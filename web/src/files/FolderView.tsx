import {
  ArrowDown, ArrowUp, ChevronRight, CloudUpload, Download, Ellipsis, Eye, FolderInput, FolderOpen, FolderPlus, Search, Trash2, Upload, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, type Drive, type DriveApi } from "../api";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { droppedFiles, pickedFiles, TransferTray, type Transfers } from "../FileUpload";
import { driveLink, finderLink } from "../links";
import { formatBytes } from "../ui";
import { useListing, useSearch } from "../usePagination";
import { LinkManager } from "../PublicLinks";
import { DetailsPanel } from "./DetailsPanel";
import { DeletedFilesDialog, DeleteDialog, MoveDialog, NameDialog, type Item } from "./dialogs";
import { exactDate, fileError, friendlyDate, plural } from "./format";
import { baseName, childPath, describeKind, folderSegments, outermost, parentFolder } from "./paths";

/** Why nothing can be changed here, if so. `member` is a person with view access; the rest are workspace-wide pauses. */
export type ReadOnly = "member" | "expired" | "storage" | "paused" | null;
interface Row extends Item { mtimeMs: number | null; /** Folder of a search result, when it is not the one on screen. */ location?: string }
type SortKey = "name" | "size" | "modified";
type Dialog =
  | { kind: "new-folder" } | { kind: "deleted" }
  | { kind: "rename"; item: Item } | { kind: "move"; items: Item[] } | { kind: "delete"; items: Item[] };
const CHUNK = 500;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
const fileLink = (driveId: string, path: string) => `${driveLink(driveId, parentFolder(path))}?file=${encodeURIComponent(baseName(path))}`;
const PAUSES: Record<Exclude<ReadOnly, "member" | null>, [string, string]> = {
  expired: ["This workspace’s trial has ended, so everything is view only for now. You can still open and download any file.", "See plans in Billing"],
  storage: ["This workspace is over its storage limit, so changes are paused. You can still open and download any file.", "Add storage in Billing"],
  paused: ["Changes are paused for this workspace right now. You can still open and download any file.", "Check Billing"],
};

function Breadcrumbs({ driveId, driveName, folder }: { driveId: string; driveName: string; folder: string }) {
  const segments = folderSegments(folder);
  return (
    <nav className="fb-crumbs" aria-label="Folders">
      {segments.length > 0 && <Link to={driveLink(driveId)}>{driveName}</Link>}
      {segments.slice(0, -1).map((segment, index) => (
        <span key={index}><ChevronRight aria-hidden="true" /><Link to={driveLink(driveId, segments.slice(0, index + 1).join("/") + "/")}>{segment}</Link></span>
      ))}
      <span>{segments.length > 0 && <ChevronRight aria-hidden="true" />}<h1 aria-current="page">{segments.at(-1) ?? driveName}</h1></span>
    </nav>
  );
}

function RowMenu({ row, driveId, canWrite, onOpen, onDownload, onDialog }: {
  row: Row; driveId: string; canWrite: boolean; onOpen: () => void; onDownload: () => void; onDialog: (dialog: Dialog) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="fb-row-more" aria-label={`Actions for ${row.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {row.isFolder ? <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem> : <DropdownMenuItem onSelect={onDownload}>Download</DropdownMenuItem>}
        {canWrite && <>
          <DropdownMenuItem onSelect={() => onDialog({ kind: "rename", item: row })}>Rename…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onDialog({ kind: "move", items: [row] })}>Move to…</DropdownMenuItem>
        </>}
        {!row.isFolder && <DropdownMenuItem onSelect={onOpen}>Version history</DropdownMenuItem>}
        <DropdownMenuItem asChild><a href={finderLink(driveId, row.path)}>Open in Finder</a></DropdownMenuItem>
        {canWrite && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onDialog({ kind: "delete", items: [row] })}>Delete…</DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows() {
  return (
    <div className="fb-loading" role="status" aria-label="Loading files">
      {Array.from({ length: 7 }, (_, index) => <div className="fb-skeleton-row" key={index}><span className="fb-skeleton" /><span className="fb-skeleton" style={{ width: `${34 + ((index * 17) % 40)}%` }} /><span className="fb-skeleton" /></div>)}
    </div>
  );
}

export function FolderView({ drive, driveName, api, writeApi, transfers, folder, file, readOnly, sharingAllowed }: {
  drive: Drive; driveName: string; api: DriveApi; writeApi: DriveApi | null; transfers: Transfers;
  /** "" for the top of the drive, otherwise ends with "/". */ folder: string;
  /** Name of the file whose details are open, from `?file=`. */ file: string | null; readOnly: ReadOnly; sharingAllowed: boolean;
}) {
  const navigate = useNavigate();
  const canWrite = writeApi !== null;
  const listing = useListing(api, folder);
  const [query, setQuery] = useState("");
  const term = useDebounced(query.trim(), 250);
  const search = useSearch(api, term);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "name", descending: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ text: string; deleted?: boolean } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const anchor = useRef<number | null>(null);
  const here = baseName(folder) || driveName;

  // Whole-drive results once the search has enough to go on; otherwise (or if search is unavailable) a filter of this folder.
  const wholeDrive = search.active && term === query.trim() && !search.error;
  const filtering = Boolean(query.trim()) && !wholeDrive;
  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    const source: Row[] = wholeDrive
      ? search.results.map((entry) => ({
        name: baseName(entry.path), path: entry.path, isFolder: entry.type === "folder", versionId: entry.versionId, size: entry.size, mtimeMs: entry.mtimeMs,
        location: parentFolder(entry.path),
      }))
      : listing.entries
        .filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle))
        .map((entry) => ({
          name: entry.name, path: childPath(folder, entry.name, entry.type === "folder"), isFolder: entry.type === "folder",
          versionId: entry.versionId, size: entry.size, mtimeMs: entry.mtimeMs,
        }));
    const direction = sort.descending ? -1 : 1;
    return source.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      const order = sort.key === "size" ? a.size - b.size : sort.key === "modified" ? (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) : byName;
      return order * direction || byName;
    });
  }, [wholeDrive, search.results, listing.entries, query, folder, sort]);
  const active = wholeDrive ? search : listing;
  const chosen = rows.filter((row) => selected.has(row.path));
  useEffect(() => { setSelected(new Set()); anchor.current = null; }, [wholeDrive, term]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(() => { listing.reload(); if (search.active) search.reload(); }, [listing.reload, search.active, search.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  // Uploads into this folder show up as they are saved; a burst of them causes one refresh.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = transfers.onUploaded((path) => {
      if (!path.startsWith(folder)) return;
      clearTimeout(timer);
      timer = setTimeout(() => refreshRef.current(), 300);
    });
    return () => { stop(); clearTimeout(timer); };
  }, [transfers, folder]);

  const closeDetails = useCallback(() => {
    navigate(driveLink(drive.id, folder));
    const opened = file;
    // Hand focus back to the row the panel was opened from.
    setTimeout(() => Array.from(document.querySelectorAll<HTMLElement>("[data-file]")).find((link) => link.dataset.file === opened)?.focus(), 0);
  }, [navigate, drive.id, folder, file]);
  /** Runs a change, then shows the drive as it is now whether or not it worked. */
  async function change(work: (api: DriveApi) => Promise<unknown>) {
    try { await work(writeApi!); }
    finally { refresh(); }
  }
  function add(files: { file: File; relative: string }[]) {
    if (!files.length) return;
    if (!canWrite) return setNotice({ text: "You can view this drive, but you can’t add files to it." });
    transfers.upload(files.map(({ file: item, relative }) => ({ file: item, path: folder + relative })));
  }
  function download(items: Row[]) {
    const files = items.filter((item) => !item.isFolder);
    files.forEach((item) => transfers.download(item.path, item.size));
    if (files.length < items.length) setNotice({ text: files.length ? "Folders can’t be downloaded in the browser, so only the files were downloaded. Open folders in Finder instead." : "Folders can’t be downloaded in the browser. Open them in Finder instead." });
  }
  function toggle(index: number, event: MouseEvent<HTMLInputElement>) {
    const next = new Set(selected);
    const on = !selected.has(rows[index].path);
    // Shift-click extends from the last box clicked.
    const from = event.shiftKey && anchor.current !== null ? anchor.current : index;
    for (let i = Math.min(from, index); i <= Math.max(from, index); i++) if (on) next.add(rows[i].path); else next.delete(rows[i].path);
    anchor.current = index;
    setSelected(next);
  }
  const fileHere = (path: string) => !path.endsWith("/") && parentFolder(path) === folder && baseName(path) === file;
  const onDragOver = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (types && !Array.from(types).includes("Files")) return;
    event.preventDefault();
    if (canWrite) setDragging(true);
  };
  const headers: [SortKey, string, string][] = [["name", "Name", "fb-col-name"], ["size", "Size", "fb-col-size"], ["modified", "Modified", "fb-col-modified"]];
  const allSelected = rows.length > 0 && chosen.length === rows.length;
  const notFound = listing.error instanceof ApiError && listing.error.status === 404;
  const showSkeleton = active.loading && !rows.length && !active.error;
  const pause = readOnly && readOnly !== "member" ? PAUSES[readOnly] : null;

  return (
    <div className="fb" data-dragging={dragging || undefined} data-details={file ? "" : undefined}
      onDragOver={onDragOver}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => {
        if (!event.dataTransfer) return;
        event.preventDefault(); setDragging(false);
        void droppedFiles(event.dataTransfer).then(add, (reason) => setNotice({ text: fileError(reason) }));
      }}>
      <header className="fb-head">
        <div className="fb-title">
          <Breadcrumbs driveId={drive.id} driveName={driveName} folder={folder} />
          {readOnly && <span className="fb-badge" title="You can open and download files here, but not change them."><Eye aria-hidden="true" />View only</span>}
        </div>
        <div className="fb-toolbar">
          <LinkManager key={`${drive.id}:${folder}`} driveId={drive.id} folder={folder} canWrite={canWrite} canCreate={sharingAllowed} />
          <div className="fb-search" role="search">
            <Search aria-hidden="true" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${driveName}`} aria-label={`Search ${driveName}`} aria-describedby="fb-search-scope" autoComplete="off" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}><X aria-hidden="true" /></button>}
          </div>
          <div className="fb-actions">
            <Button variant="ghost" asChild className="fb-compact"><a href={finderLink(drive.id, folder)} aria-label="Open in Finder"><FolderOpen /><span>Open in Finder</span></a></Button>
            {canWrite && <Button className="fb-compact" aria-label="New folder" onClick={() => setDialog({ kind: "new-folder" })}><FolderPlus /><span>New folder</span></Button>}
            {canWrite && <Button variant="default" onClick={() => picker.current?.click()}><Upload />Upload</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More for this drive"><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                {canWrite && <DropdownMenuItem onSelect={() => folderPicker.current?.click()}><FolderInput />Upload a folder</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => setDialog({ kind: "deleted" })}><Trash2 />Deleted files</DropdownMenuItem>
                <DropdownMenuItem onSelect={refresh}>Refresh</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {canWrite && <>
          <input ref={picker} className="fb-file-input" type="file" multiple tabIndex={-1} aria-label="Choose files to upload" onChange={(event) => { add(pickedFiles(event.target.files)); event.target.value = ""; }} />
          <input ref={folderPicker} className="fb-file-input" type="file" multiple tabIndex={-1} aria-label="Choose a folder to upload" {...{ webkitdirectory: "" }} onChange={(event) => { add(pickedFiles(event.target.files)); event.target.value = ""; }} />
        </>}
      </header>

      {pause && <p className="fb-pause" role="note"><span><strong>Your files are safe.</strong> {pause[0]}</span> <Link to={`/orgs/${encodeURIComponent(drive.orgId)}/billing`}>{pause[1]}</Link></p>}
      <p id="fb-search-scope" className="fb-scope muted small" role="status">
        {wholeDrive ? (search.loading && !rows.length ? `Searching ${driveName}…` : `${plural(rows.length, "result")}${search.cursor ? "+" : ""} for “${term}” in all of ${driveName}`)
          : filtering && search.error && search.active ? "Searching the whole drive isn’t available right now, so this shows matches in this folder only."
          : filtering && [...query.trim()].length < 3 ? "Showing matches in this folder. Type 3 or more characters to search the whole drive."
          : ""}
        {filtering && listing.cursor ? " Only the items shown so far are checked." : ""}
      </p>
      {notice && <p className="fb-notice" role="status">{notice.text}{notice.deleted && <Button variant="ghost" size="xs" onClick={() => { setNotice(null); setDialog({ kind: "deleted" }); }}>Show deleted files</Button>}<Button variant="ghost" size="icon-xs" aria-label="Dismiss message" onClick={() => setNotice(null)}><X /></Button></p>}

      {chosen.length > 0 && <div className="fb-bulk" role="toolbar" aria-label="Selected items">
        <strong>{chosen.length.toLocaleString()} selected</strong>
        <Button size="sm" onClick={() => download(chosen)}><Download />Download</Button>
        {canWrite && <Button size="sm" onClick={() => setDialog({ kind: "move", items: chosen })}><FolderInput />Move to…</Button>}
        {canWrite && <Button size="sm" onClick={() => setDialog({ kind: "delete", items: chosen })}><Trash2 />Delete…</Button>}
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear selection</Button>
      </div>}

      <div className="fb-body">
        <div className="fb-main" aria-busy={active.loading}>
          {showSkeleton ? <SkeletonRows />
            : active.error && !rows.length && !filtering ? (
              <div className="fb-state" role="alert">
                <h2>{notFound ? "This folder can’t be found" : "This folder couldn’t be loaded"}</h2>
                <p>{notFound ? "It may have been moved, renamed or deleted." : fileError(active.error)}</p>
                <div className="fb-state-actions">
                  <Button onClick={refresh}>Try again</Button>
                  {notFound && folder && <Button variant="ghost" asChild><Link to={driveLink(drive.id)}>Go to {driveName}</Link></Button>}
                </div>
              </div>
            ) : !rows.length && query.trim() ? (
              <div className="fb-state">
                <h2>No matches</h2>
                <p>Nothing {wholeDrive ? `in ${driveName}` : "in this folder"} has “{query.trim()}” in its name.</p>
                <div className="fb-state-actions">
                  <Button onClick={() => setQuery("")}>Clear search</Button>
                  {!wholeDrive && listing.cursor && <Button disabled={listing.loading} onClick={() => void listing.loadMore()}>{listing.loading ? "Loading…" : "Check more of this folder"}</Button>}
                </div>
              </div>
            ) : !rows.length ? (
              <div className="fb-state fb-empty">
                <CloudUpload aria-hidden="true" />
                <h2>{folder ? "This folder is empty" : "Nothing in this drive yet"}</h2>
                {canWrite ? <>
                  <p>Drop files anywhere on this page to add them. They’ll show up here and in Finder on every Mac that has this drive.</p>
                  <div className="fb-state-actions">
                    <Button variant="default" onClick={() => picker.current?.click()}><Upload />Upload files</Button>
                    <Button onClick={() => setDialog({ kind: "new-folder" })}><FolderPlus />New folder</Button>
                  </div>
                </> : <p>Files and folders added here will appear in this list.</p>}
              </div>
            ) : (
              <table className="fb-table">
                <caption className="sr-only">{wholeDrive ? `Search results in ${driveName}` : `Contents of ${here}`}</caption>
                <thead>
                  <tr>
                    <th className="fb-col-check"><input type="checkbox" aria-label="Select all items" checked={allSelected}
                      ref={(element) => { if (element) element.indeterminate = chosen.length > 0 && !allSelected; }}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.path)))} /></th>
                    {headers.map(([key, label, className]) => (
                      <th key={key} scope="col" className={className} aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}>
                        <button type="button" onClick={() => setSort((value) => ({ key, descending: value.key === key ? !value.descending : key !== "name" }))}>
                          {label}{sort.key === key && (sort.descending ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />)}
                        </button>
                      </th>
                    ))}
                    <th className="fb-col-more"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const { icon: Kind } = describeKind(row.name, row.isFolder);
                    const target = row.isFolder ? driveLink(drive.id, row.path) : fileLink(drive.id, row.path);
                    const open = fileHere(row.path);
                    return (
                      <tr key={row.path} data-selected={selected.has(row.path) || undefined} data-open={open || undefined}>
                        <td className="fb-col-check"><input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.has(row.path)} onChange={() => {}} onClick={(event) => toggle(index, event)} /></td>
                        <td className="fb-col-name">
                          <Link to={target} className="fb-name" data-file={row.isFolder || row.location !== undefined ? undefined : row.name} aria-current={open ? "true" : undefined}>
                            <Kind className={row.isFolder ? "fb-kind fb-kind-folder" : "fb-kind"} aria-hidden="true" />
                            <span className="fb-name-text"><span>{row.name}</span>{row.location !== undefined && <small>in {row.location ? row.location.replace(/\/$/, "").split("/").join(" › ") : driveName}</small>}</span>
                          </Link>
                        </td>
                        <td className="fb-col-size">{row.isFolder ? <span aria-label="Folder">—</span> : formatBytes(row.size)}</td>
                        <td className="fb-col-modified"><time title={exactDate(row.mtimeMs)}>{friendlyDate(row.mtimeMs)}</time></td>
                        <td className="fb-col-more">
                          <RowMenu row={row} driveId={drive.id} canWrite={canWrite} onOpen={() => navigate(target)} onDownload={() => download([row])} onDialog={setDialog} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          {rows.length > 0 && <footer className="fb-foot">
            {Boolean(active.error) && <p className="fb-problem" role="alert">{fileError(active.error)}</p>}
            <span className="muted small">{!wholeDrive && `${plural(rows.length, "item")}${active.cursor && !filtering ? " shown so far" : ""}`}</span>
            {active.cursor && <Button size="sm" disabled={active.loading} onClick={() => void active.loadMore()}>{active.loading ? "Loading…" : active.error ? "Try again" : "Show more"}</Button>}
          </footer>}
        </div>
        {file && <DetailsPanel sharingAllowed={sharingAllowed} key={file} api={api} writeApi={writeApi} transfers={transfers} driveId={drive.id} path={folder + file}
          onClose={closeDetails} onChanged={refresh} onAction={(kind, item) => setDialog(kind === "rename" ? { kind, item } : { kind, items: [item] })} />}
      </div>

      {dragging && <div className="fb-drop" aria-hidden="true"><CloudUpload /><p>Drop to upload to “{here}”</p></div>}
      <TransferTray transfers={transfers} />

      {dialog?.kind === "new-folder" && <NameDialog title="New folder" label="Folder name" initial="Untitled folder" action="Create folder" working="Creating…"
        taken={(name) => `“${name}” already exists in this folder. Choose another name.`} onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await change((drive) => drive.mkdir(childPath(folder, name, true)));
          setDialog(null); setNotice({ text: `Created “${name}”.` });
        }} />}
      {dialog?.kind === "rename" && <NameDialog title={`Rename “${dialog.item.name}”`} label="New name" initial={dialog.item.name} action="Rename" working="Renaming…"
        taken={(name) => `“${name}” already exists in this folder. Choose another name.`} onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const { item } = dialog;
          await change((drive) => drive.move([{ from: item.path, to: childPath(parentFolder(item.path), name, item.isFolder), versionId: item.versionId }]));
          setDialog(null); setNotice({ text: `Renamed to “${name}”.` });
          if (fileHere(item.path)) navigate(fileLink(drive.id, folder + name), { replace: true });
        }} />}
      {dialog?.kind === "move" && <MoveDialog api={api} driveName={driveName} items={dialog.items} onClose={() => setDialog(null)}
        onMove={async (destination) => {
          // Search can select a folder with something inside it, or items from several folders, some already at the destination.
          const items = outermost(dialog.items).filter((item) => parentFolder(item.path) !== destination);
          for (let i = 0; i < items.length; i += CHUNK)
            await change((drive) => drive.move(items.slice(i, i + CHUNK).map((item) => ({ from: item.path, to: childPath(destination, item.name, item.isFolder), versionId: item.versionId }))));
          setDialog(null); setSelected(new Set());
          setNotice({ text: `Moved ${items.length === 1 ? `“${items[0].name}”` : plural(items.length, "item")} to “${baseName(destination) || driveName}”.` });
          if (items.some((item) => fileHere(item.path))) navigate(driveLink(drive.id, folder), { replace: true });
        }} />}
      {dialog?.kind === "delete" && <DeleteDialog items={dialog.items} onClose={() => setDialog(null)}
        onConfirm={async () => {
          const items = outermost(dialog.items);
          for (let i = 0; i < items.length; i += CHUNK) await change((drive) => drive.remove(items.slice(i, i + CHUNK)));
          setDialog(null); setSelected(new Set());
          setNotice({ text: `Deleted ${items.length === 1 ? `“${items[0].name}”` : plural(items.length, "item")}.`, deleted: true });
          if (items.some((item) => fileHere(item.path))) navigate(driveLink(drive.id, folder), { replace: true });
        }} />}
      {dialog?.kind === "deleted" && <DeletedFilesDialog api={api} writeApi={writeApi} driveName={driveName} onRestored={refresh} onClose={() => setDialog(null)} />}
    </div>
  );
}
