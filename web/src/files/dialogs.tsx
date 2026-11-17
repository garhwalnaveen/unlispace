import { ChevronRight, Folder, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DriveApi, Version } from "../api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { formatBytes, Modal, useLoad } from "../ui";
import { deletedItems, restoreDeletedFile, restoreDeletedFolder, type DeletedItem } from "./deleted";
import { fileError, friendlyDate, plural } from "./format";
import { baseName, childPath, describeKind, folderSegments, nameProblem, outermost, parentFolder } from "./paths";

/** A file or folder the user is acting on. `path` ends with "/" for folders. */
export interface Item { name: string; path: string; isFolder: boolean; versionId?: string | null; size: number }

/** Runs one request at a time and keeps its failure on screen, so a dialog stays open until the work succeeds. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(undefined);
    try { await work(); }
    catch (reason) { setError(fileError(reason)); }
    finally { running.current = false; setBusy(false); }
  }, []);
  return { busy, error, setError, run };
}
const Problem = ({ children }: { children?: ReactNode }) => (children ? <p className="fb-problem" role="alert">{children}</p> : null);
function Footer({ busy, label, working, onClose, destructive, disabled }: { busy: boolean; label: string; working: string; onClose: () => void; destructive?: boolean; disabled?: boolean }) {
  return (
    <div className="fb-dialog-foot">
      <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={busy || disabled}>{busy ? working : label}</Button>
    </div>
  );
}

/** New folder and Rename share one small form: a name, validated before anything is sent. */
export function NameDialog({ title, label, initial, action, working, taken, onSubmit, onClose }: {
  title: string; label: string; initial: string; action: string; working: string;
  /** Shown when the data plane reports that the name is in use. */
  taken: (name: string) => string;
  onSubmit: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const { busy, error, setError, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    // Select the part before the extension, as Finder does.
    const dot = initial.lastIndexOf(".");
    input.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = nameProblem(name);
    if (problem) return setError(problem);
    if (name === initial && title.startsWith("Rename")) return onClose();
    void run(async () => {
      try { await onSubmit(name); }
      catch (reason) {
        const { status } = reason as { status?: number };
        if (status === 409 || status === 412) return setError(taken(name));
        throw reason;
      }
    });
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form className="fb-form" onSubmit={submit} noValidate>
        <label htmlFor={id}>{label}</label>
        <Input id={id} ref={input} value={name} autoFocus autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => { setName(event.target.value); setError(undefined); }} />
        <span id={`${id}-error`}><Problem>{error}</Problem></span>
        <Footer busy={busy} label={action} working={working} onClose={onClose} />
      </form>
    </Modal>
  );
}

export function DeleteDialog({ items, onConfirm, onClose }: { items: Item[]; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { busy, error, run } = useAction();
  const [only] = items;
  const folders = items.filter((item) => item.isFolder).length;
  const title = items.length === 1 ? `Delete “${only.name}”?` : `Delete ${plural(items.length, "item")}?`;
  const what = items.length === 1
    ? only.isFolder ? "This folder and everything in it" : "This file"
    : folders ? "These items, and everything inside the folders," : "These files";
  return (
    <Modal title={title} onClose={onClose}>
      <form className="fb-form" onSubmit={(event) => { event.preventDefault(); void run(onConfirm); }}>
        <p>{what} will be removed from the drive for everyone who can open it, including in Finder.</p>
        <p className="muted">Nothing is erased: Orbit keeps the history, so you can bring {items.length === 1 ? "it" : "them"} back from <strong>Deleted files</strong> in this drive’s menu.</p>
        <Problem>{error}</Problem>
        <Footer busy={busy} label={items.length === 1 ? "Delete" : `Delete ${plural(items.length, "item")}`} working="Deleting…" onClose={onClose} destructive />
      </form>
    </Modal>
  );
}

export function RestoreDialog({ name, version, onConfirm, onClose }: { name: string; version: Version; onConfirm: () => Promise<void>; onClose: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Modal title="Restore this version?" onClose={onClose}>
      <form className="fb-form" onSubmit={(event) => { event.preventDefault(); void run(onConfirm); }}>
        <p>“{name}” will go back to how it was {friendlyDate(version.ts)}{version.size === null ? "" : ` (${formatBytes(version.size)})`}.</p>
        <p className="muted">The current version is kept in history, so you can switch back at any time.</p>
        <Problem>{error}</Problem>
        <Footer busy={busy} label="Restore version" working="Restoring…" onClose={onClose} />
      </form>
    </Modal>
  );
}

async function subfolders(api: DriveApi, folder: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;
  // Folders sort first within a page only, so read the folder through (bounded) rather than stop early.
  for (let page = 0; page < 20; page++) {
    const result: Awaited<ReturnType<DriveApi["list"]>> = await api.list(folder, cursor);
    names.push(...result.entries.filter((entry) => entry.type === "folder").map((entry) => entry.name));
    if (!result.cursor || result.cursor === cursor) break;
    cursor = result.cursor;
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
/** A folder picker: browse to the destination, then confirm. */
export function MoveDialog({ api, driveName, items, onMove, onClose }: {
  api: DriveApi; driveName: string; items: Item[]; onMove: (destination: string) => Promise<void>; onClose: () => void;
}) {
  const [destination, setDestination] = useState(() => parentFolder(items[0].path));
  // Items picked from search can come from several folders; only a folder that holds all of them is no move at all.
  const alreadyThere = outermost(items).every((item) => parentFolder(item.path) === destination);
  const { busy, error, setError, run } = useAction();
  const load = useCallback(() => subfolders(api, destination), [api, destination]);
  const { data: folders, loading, error: loadError, reload } = useLoad(load);
  const moving = items.filter((item) => item.isFolder).map((item) => item.path);
  const inside = moving.some((path) => destination.startsWith(path));
  const segments = folderSegments(destination);
  const target = segments.at(-1) ?? driveName;
  const go = (folder: string) => { setError(undefined); setDestination(folder); };
  const subject = items.length === 1 ? `“${items[0].name}”` : plural(items.length, "item");
  return (
    <Modal title={`Move ${subject}`} onClose={onClose}>
      <form className="fb-form" onSubmit={(event) => { event.preventDefault(); void run(() => onMove(destination)); }}>
        <nav className="fb-picker-path" aria-label="Destination">
          <button type="button" onClick={() => go("")} aria-current={segments.length ? undefined : "location"}>{driveName}</button>
          {segments.map((segment, index) => (
            <span key={index}><ChevronRight aria-hidden="true" />
              <button type="button" onClick={() => go(segments.slice(0, index + 1).join("/") + "/")} aria-current={index === segments.length - 1 ? "location" : undefined}>{segment}</button>
            </span>
          ))}
        </nav>
        <div className="fb-picker" role="group" aria-label={`Folders in ${target}`} aria-busy={loading}>
          {loading && <p className="muted fb-picker-note" role="status">Loading folders…</p>}
          {Boolean(loadError) && <p className="fb-picker-note" role="alert">{fileError(loadError)} <Button type="button" size="xs" onClick={reload}>Try again</Button></p>}
          {folders?.map((name) => {
            const path = childPath(destination, name, true);
            const self = moving.includes(path);
            return (
              <button type="button" key={name} className="fb-picker-row" disabled={self} title={self ? "A folder can’t be moved into itself." : undefined} onClick={() => go(path)}>
                <Folder aria-hidden="true" /><span>{name}</span><ChevronRight aria-hidden="true" />
              </button>
            );
          })}
          {folders && !folders.length && <p className="muted fb-picker-note">No folders in here. You can still move {items.length === 1 ? "it" : "them"} to “{target}”.</p>}
        </div>
        <Problem>{error}</Problem>
        <p className="muted small fb-picker-hint">{alreadyThere ? `${items.length === 1 ? "It’s" : "They’re"} already in this folder. Choose another one.` : inside ? "A folder can’t be moved into itself." : "\u00a0"}</p>
        <Footer busy={busy} label={`Move to “${target}”`} working="Moving…" onClose={onClose} disabled={alreadyThere || inside} />
      </form>
    </Modal>
  );
}

/** Everything deleted from the drive, newest first, with a way back. */
export function DeletedFilesDialog({ api, writeApi, driveName, onRestored, onClose }: {
  api: DriveApi; writeApi: DriveApi | null; driveName: string; onRestored: () => void; onClose: () => void;
}) {
  type Page = Awaited<ReturnType<typeof deletedItems>>;
  const [page, setPage] = useState<Page>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<Record<string, "working" | "restored" | string>>({});
  const more = useCallback(async (previous?: Page) => {
    setLoading(true); setError(undefined);
    try { setPage(await deletedItems(api, previous)); }
    catch (reason) { setError(fileError(reason)); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void more(); }, [more]);
  async function restore(item: DeletedItem) {
    if (!writeApi || status[item.path] === "working") return;
    setStatus((value) => ({ ...value, [item.path]: "working" }));
    try {
      if (item.isFolder) {
        const { skipped } = await restoreDeletedFolder(api, writeApi, item.path);
        setStatus((value) => ({ ...value, [item.path]: skipped ? `Restored. ${plural(skipped, "file")} already existed and ${skipped === 1 ? "was" : "were"} left as ${skipped === 1 ? "it is" : "they are"}.` : "restored" }));
      } else {
        await restoreDeletedFile(api, writeApi, item.path);
        setStatus((value) => ({ ...value, [item.path]: "restored" }));
      }
      onRestored();
    } catch (reason) {
      const taken = (reason as { status?: number }).status === 412;
      setStatus((value) => ({ ...value, [item.path]: taken ? "Something with this name is already there. Rename it first, then restore." : fileError(reason) }));
    }
  }
  const items = page?.items ?? [];
  return (
    <Modal title="Deleted files" onClose={onClose}>
      <div className="fb-form">
        <p className="muted">Deleted items stay in this drive’s history. {writeApi ? "Restore one to put it back where it was." : "Someone who can edit this drive can put them back."}</p>
        {error && <p className="fb-problem" role="alert">{error} <Button size="xs" onClick={() => void more(page)}>Try again</Button></p>}
        {!error && !loading && !items.length && <p className="fb-deleted-empty">Nothing has been deleted{page && page.from > 0 ? " recently" : ""}. Files you delete will be listed here.</p>}
        {items.length > 0 && <ul className="fb-deleted" aria-label="Deleted items">
          {items.map((item) => {
            const { icon: Kind } = describeKind(baseName(item.path), item.isFolder);
            const state = status[item.path];
            const where = parentFolder(item.path);
            return (
              <li key={item.path}>
                <Kind aria-hidden="true" />
                <div>
                  <p className="fb-deleted-name">{baseName(item.path)}</p>
                  <p className="muted small">{state && state !== "working" && state !== "restored" ? <span role="alert">{state}</span> : `Was in ${where ? where.replace(/\/$/, "").split("/").join(" › ") : driveName}`}</p>
                </div>
                {state === "restored" ? <span className="muted small" role="status">Restored</span>
                  : writeApi && <Button size="sm" disabled={state === "working"} aria-label={`Restore ${baseName(item.path)}`} onClick={() => void restore(item)}><RotateCcw />{state === "working" ? "Restoring…" : "Restore"}</Button>}
              </li>
            );
          })}
        </ul>}
        {loading && <p className="muted" role="status">Looking through this drive’s history…</p>}
        {!loading && page && page.from > 0 && <Button variant="ghost" size="sm" onClick={() => void more(page)}>Look further back</Button>}
        <div className="fb-dialog-foot"><Button type="button" onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}
