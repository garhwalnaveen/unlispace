import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronUp, RotateCw, X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { DriveApi } from "./api";
import { Button } from "./components/ui/button";
import { downloadFile, MAX_WEB_DOWNLOAD } from "./download";
import { fileError, plural } from "./files/format";
import { baseName } from "./files/paths";
import { formatBytes } from "./ui";
import { readOnboarding, writeOnboarding } from "./onboarding/state";
import { existing, freePath, uploadFile, type UploadProgress } from "./upload";

export interface Transfer {
  id: number;
  kind: "upload" | "download";
  name: string;
  /** Where an upload goes, or which file a download reads. */
  path: string;
  /** `conflict` waits for the user to choose between replacing the existing file and keeping both. */
  status: "queued" | "conflict" | "active" | "done" | "error";
  phase?: "checking" | UploadProgress["phase"];
  bytes: number;
  total: number;
  error?: string;
}
interface Job extends Transfer {
  file?: File;
  versionId?: string;
  mode?: "create" | "replace";
  keepBoth?: boolean;
  controller?: AbortController;
}
const PARALLEL = 2;

/** The uploads and downloads of one drive. It outlives folder navigation, so progress is never lost by browsing. */
export class Transfers {
  private jobs: Job[] = [];
  private view: Transfer[] = [];
  private listeners = new Set<() => void>();
  private uploaded = new Set<(path: string) => void>();
  private nextId = 1;
  constructor(private readApi: DriveApi, private writeApi: DriveApi | null) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.view;
  /** Called with the destination path each time an upload is saved. */
  onUploaded(listener: (path: string) => void) { this.uploaded.add(listener); return () => { this.uploaded.delete(listener); }; }
  get busy() { return this.jobs.some((job) => job.status === "active" || job.status === "queued"); }

  upload(files: { file: File; path: string }[]) {
    if (!this.writeApi) return;
    for (const { file, path } of files)
      this.jobs.push({ id: this.nextId++, kind: "upload", name: baseName(path), path, file, status: "queued", bytes: 0, total: file.size });
    this.pump();
  }
  download(path: string, size: number | null, versionId?: string) {
    this.jobs.push({ id: this.nextId++, kind: "download", name: baseName(path), path, versionId, status: "queued", bytes: 0, total: size ?? 0 });
    this.pump();
  }
  /** Answers a name conflict: save a new version of the existing file, or upload next to it under a free name. */
  resolve(id: number, choice: "replace" | "keep") {
    const job = this.find(id);
    if (job?.status !== "conflict") return;
    if (choice === "replace") job.mode = "replace"; else job.keepBoth = true;
    job.status = "queued";
    this.pump();
  }
  retry(id: number) {
    const job = this.find(id);
    if (job?.status !== "error") return;
    if (job.mode === "create") job.mode = undefined;
    Object.assign(job, { status: "queued", error: undefined, bytes: 0, phase: undefined });
    this.pump();
  }
  /** Stops a waiting or running transfer, or dismisses a finished one. */
  remove(id: number) {
    const job = this.find(id);
    job?.controller?.abort();
    this.jobs = this.jobs.filter((item) => item !== job);
    this.pump();
  }
  clearFinished() {
    this.jobs = this.jobs.filter((job) => job.status !== "done");
    this.publish();
  }
  /** Stops everything and forgets it. */
  dispose() { this.jobs.forEach((job) => job.controller?.abort()); this.jobs = []; this.listeners.clear(); this.uploaded.clear(); }

  private find = (id: number) => this.jobs.find((job) => job.id === id);
  private publish() {
    this.view = this.jobs.map(({ id, kind, name, path, status, phase, bytes, total, error }) => ({ id, kind, name, path, status, phase, bytes, total, error }));
    this.listeners.forEach((listener) => listener());
  }
  private pump() {
    let running = this.jobs.filter((job) => job.status === "active").length;
    for (const job of this.jobs) {
      if (running >= PARALLEL) break;
      if (job.status !== "queued") continue;
      running++;
      void this.run(job);
    }
    this.publish();
  }
  private async run(job: Job) {
    job.status = "active";
    job.controller = new AbortController();
    const { signal } = job.controller;
    const progress = (bytes: number, total: number, phase?: Job["phase"]) => {
      if (signal.aborted) return;
      Object.assign(job, { bytes, total, phase });
      this.publish();
    };
    try {
      if (job.kind === "download") {
        if (job.total > MAX_WEB_DOWNLOAD) throw new Error("This file is too large to download in the browser. Open it in Finder instead.");
        await downloadFile(this.readApi, job.path, (bytes, total) => progress(bytes, total, "uploading"), job.versionId, signal);
      } else {
        const api = this.writeApi!;
        if (job.keepBoth) {
          job.path = await freePath(api, job.path);
          job.name = baseName(job.path);
          job.keepBoth = false;
          job.mode = "create";
        }
        if (!job.mode) {
          progress(0, job.total, "checking");
          const head = await existing(api, job.path);
          if (signal.aborted) return;
          if (head && head.type !== "file") throw new Error("A folder already uses this name. Rename the file, then upload it again.");
          if (head) { job.status = "conflict"; return; }
          job.mode = "create";
        }
        await uploadFile(api, job.file!, job.path, (value) => progress(value.bytes, value.total, value.phase), { mode: job.mode, signal });
        this.uploaded.forEach((listener) => listener(job.path));
        const onboarding = readOnboarding();
        if (onboarding && !onboarding.uploaded) writeOnboarding({ uploaded: true });
      }
      job.status = "done";
    } catch (error) {
      if (signal.aborted) return;
      Object.assign(job, { status: "error", error: fileError(error) });
    } finally {
      job.controller = undefined;
      if (!signal.aborted) this.pump();
    }
  }
}
// Transfers belong to a signed-in session and a drive, not to a page: visiting Settings or another drive
// must not abandon an upload. They live here until the tab closes or the session goes away.
const sessions = new WeakMap<object, Map<string, { transfers: Transfers; writable: boolean }>>();
const live = new Set<Transfers>();
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    // Closing the tab would abandon unfinished transfers, so the browser asks first.
    if ([...live].some((transfers) => transfers.busy)) event.preventDefault();
  });
/** The transfers of drive `id` for the signed-in `session`, created on first use. */
export function driveTransfers(session: object, id: string, readApi: DriveApi, writeApi: DriveApi | null): Transfers {
  const drives = sessions.get(session) ?? new Map<string, { transfers: Transfers; writable: boolean }>();
  sessions.set(session, drives);
  const known = drives.get(id);
  // Access can change (a plan lapses, a role changes); switch over once nothing is in flight.
  if (known && (known.writable === (writeApi !== null) || known.transfers.busy)) return known.transfers;
  if (known) { known.transfers.dispose(); live.delete(known.transfers); }
  const transfers = new Transfers(readApi, writeApi);
  drives.set(id, { transfers, writable: writeApi !== null });
  live.add(transfers);
  return transfers;
}
export function useTransfers(transfers: Transfers) {
  return useSyncExternalStore(transfers.subscribe, transfers.snapshot);
}

interface FsEntry { isFile: boolean; isDirectory: boolean; name: string; file?: (done: (file: File) => void, fail: (error: unknown) => void) => void; createReader?: () => { readEntries: (done: (entries: FsEntry[]) => void, fail: (error: unknown) => void) => void } }
async function walk(entry: FsEntry, prefix: string, out: { file: File; relative: string }[]) {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((done, fail) => entry.file!(done, fail));
    out.push({ file, relative: prefix + entry.name });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((done, fail) => reader.readEntries(done, fail));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}
/** The files of a drop, with folders expanded to `folder/sub/name` paths where the browser allows it. */
export async function droppedFiles(data: DataTransfer): Promise<{ file: File; relative: string }[]> {
  // Entries must be read during the drop event; they are gone once it returns.
  const entries = Array.from(data.items || [])
    .map((item) => (item as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null)
    .filter((entry) => entry !== null);
  if (!entries.length) return Array.from(data.files || []).map((file) => ({ file, relative: file.name }));
  const out: { file: File; relative: string }[] = [];
  for (const entry of entries) await walk(entry, "", out);
  return out;
}
export const pickedFiles = (list: FileList | null) =>
  Array.from(list || []).map((file) => ({ file, relative: file.webkitRelativePath || file.name }));

function headline(items: Transfer[]): string {
  const running = items.filter((item) => item.status === "active" || item.status === "queued");
  const waiting = items.filter((item) => item.status === "conflict").length;
  const failed = items.filter((item) => item.status === "error").length;
  if (running.length) {
    const kinds = new Set(running.map((item) => item.kind));
    return kinds.size > 1 ? `${plural(running.length, "transfer")} in progress` : `${kinds.has("upload") ? "Uploading" : "Downloading"} ${plural(running.length, "file")}…`;
  }
  if (waiting) return `${plural(waiting, "file")} already ${waiting === 1 ? "exists" : "exist"} here`;
  if (failed) return `${plural(failed, "file")} didn’t finish`;
  const uploads = items.filter((item) => item.kind === "upload").length;
  return uploads === items.length ? `${plural(uploads, "file")} uploaded` : uploads ? `${plural(items.length, "transfer")} finished` : `${plural(items.length, "file")} downloaded`;
}
function describe(item: Transfer): string {
  const upload = item.kind === "upload";
  if (item.status === "queued") return "Waiting…";
  if (item.status === "conflict") return "A file with this name is already here.";
  if (item.status === "done") return upload ? `Uploaded · ${formatBytes(item.total)}` : "Downloaded — check your browser’s downloads.";
  if (item.status === "error") return item.error || "This didn’t finish.";
  if (!upload) return item.total ? `Downloading · ${formatBytes(item.bytes)} of ${formatBytes(item.total)}` : "Starting download…";
  if (item.phase === "checking") return "Checking the folder…";
  if (item.phase === "hashing") return `Preparing · ${formatBytes(item.bytes)} of ${formatBytes(item.total)}`;
  if (item.phase === "committing" || item.phase === "done") return "Saving…";
  return `Uploading · ${formatBytes(item.bytes)} of ${formatBytes(item.total)}`;
}

/** The small activity list pinned to the bottom right while files move in or out of the drive. */
export function TransferTray({ transfers }: { transfers: Transfers }) {
  const items = useTransfers(transfers);
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  const settled = items.every((item) => item.status === "done" || item.status === "error");
  const title = headline(items);
  return (
    <section className="fb-tray" aria-label="Uploads and downloads">
      <header className="fb-tray-head">
        <h2 role="status">{title}</h2>
        {items.some((item) => item.status === "done") && !settled && <Button variant="ghost" size="xs" onClick={() => transfers.clearFinished()}>Clear finished</Button>}
        <Button variant="ghost" size="icon-xs" aria-expanded={open} aria-label={open ? "Hide transfer list" : "Show transfer list"} onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown /> : <ChevronUp />}</Button>
        {settled && <Button variant="ghost" size="icon-xs" aria-label="Close transfer list" onClick={() => items.forEach((item) => transfers.remove(item.id))}><X /></Button>}
      </header>
      {open && <ul className="fb-tray-list">
        {items.map((item) => {
          const Kind = item.status === "done" ? Check : item.status === "error" || item.status === "conflict" ? AlertCircle : item.kind === "upload" ? ArrowUpFromLine : ArrowDownToLine;
          const working = item.status === "active" && item.phase !== "checking";
          return (
            <li key={item.id} className="fb-tray-item" data-status={item.status}>
              <Kind className="fb-tray-icon" aria-hidden="true" />
              <div className="fb-tray-text">
                <p className="fb-tray-name" title={item.path}>{item.name}</p>
                <p className="fb-tray-note" role={item.status === "error" ? "alert" : undefined}>{describe(item)}</p>
                {working && <progress aria-label={`${item.kind === "upload" ? "Upload" : "Download"} progress for ${item.name}`} max={item.total || 1} value={item.total ? item.bytes : undefined} />}
                {item.status === "conflict" && <div className="fb-tray-choice">
                  <Button size="xs" onClick={() => transfers.resolve(item.id, "keep")} aria-label={`Keep both copies of ${item.name}`}>Keep both</Button>
                  <Button size="xs" onClick={() => transfers.resolve(item.id, "replace")} aria-label={`Replace ${item.name} with a new version`} title="Saves a new version. The current one stays in version history.">Replace</Button>
                </div>}
              </div>
              {item.status === "error" && <Button variant="ghost" size="icon-xs" aria-label={`Try ${item.name} again`} title="Try again" onClick={() => transfers.retry(item.id)}><RotateCw /></Button>}
              <Button variant="ghost" size="icon-xs" aria-label={item.status === "active" || item.status === "queued" ? `Cancel ${item.name}` : `Dismiss ${item.name}`} title={item.status === "active" || item.status === "queued" ? "Cancel" : "Dismiss"} onClick={() => transfers.remove(item.id)}><X /></Button>
            </li>
          );
        })}
      </ul>}
    </section>
  );
}
