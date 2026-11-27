import { LinkManager } from "../PublicLinks";
import { Download, Ellipsis, FolderOpen, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DriveApi, FileStat, Version } from "../api";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { assembleFile } from "../download";
import type { Transfers } from "../FileUpload";
import { finderLink } from "../links";
import { formatBytes, useLoad } from "../ui";
import { useVersions } from "../usePagination";
import { RestoreDialog, type Item } from "./dialogs";
import { exactDate, fileError, friendlyDate } from "./format";
import { baseName, describeKind, previewFor } from "./paths";

const VERSIONS_SHOWN = 8;

function FilePreview({ api, file, name }: { api: DriveApi; file: FileStat; name: string }) {
  const preview = previewFor(name);
  const { icon: Kind, label } = describeKind(name, false);
  const fits = preview !== null && file.size <= preview.limit;
  const [shown, setShown] = useState<{ url?: string; text?: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!preview || !fits) return;
    let active = true;
    let url: string | undefined;
    setShown(undefined); setFailed(false);
    void (async () => {
      const blob = await assembleFile(await api.manifest(file.path, file.versionId), api.shard.bind(api), () => {});
      if (!active) return;
      if (preview.kind === "text") return setShown({ text: await blob.text() });
      // Re-typed from the file name so stored metadata cannot turn a preview into an active page.
      url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: preview.type }));
      setShown({ url });
    })().catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [api, file.path, file.versionId, fits]); // eslint-disable-line react-hooks/exhaustive-deps
  if (preview && fits && shown?.url && preview.kind === "image") return <div className="fb-preview"><img src={shown.url} alt={`Preview of ${name}`} /></div>;
  if (preview && fits && shown?.url) return <div className="fb-preview"><iframe src={shown.url} title={`Preview of ${name}`} /></div>;
  if (preview && fits && shown?.text !== undefined) return <div className="fb-preview"><pre tabIndex={0} aria-label={`Preview of ${name}`}>{shown.text || "This file is empty."}</pre></div>;
  return (
    <div className="fb-preview fb-preview-none" role={preview && fits && !failed ? "status" : undefined}>
      <Kind aria-hidden="true" />
      <p className="muted small">
        {failed ? "The preview couldn’t be loaded. Download the file to open it."
          : preview && fits ? "Loading preview…"
          : preview ? `Previews are shown for files up to ${formatBytes(preview.limit)}. Download this one to open it.`
          : `${label} · no preview in the browser`}
      </p>
    </div>
  );
}

function describeVersion(version: Version, all: Version[]): string {
  if (version.op === "delete") return "Deleted";
  const source = version.op === "restore" && version.restoredFrom ? all.find((item) => item.versionId === version.restoredFrom) : undefined;
  return [version.size === null ? null : formatBytes(version.size), source ? `Restored from ${friendlyDate(source.ts)}` : version.op === "restore" ? "Restored" : null].filter(Boolean).join(" · ");
}
function History({ api, writeApi, transfers, file, name, onRestored }: {
  api: DriveApi; writeApi: DriveApi | null; transfers: Transfers; file: FileStat; name: string; onRestored: () => void;
}) {
  const { versions, cursor, loading, error, loadMore, reload } = useVersions(api, file.path);
  const [limit, setLimit] = useState(VERSIONS_SHOWN);
  const [restoring, setRestoring] = useState<Version | null>(null);
  // The newest versions are on the last page, so history is read through before it is shown.
  useEffect(() => { if (cursor && !loading && !error) void loadMore(); }, [cursor, loading, error, loadMore]);
  const head = useRef(file.versionId);
  useEffect(() => { if (head.current !== file.versionId) { head.current = file.versionId; reload(); } }, [file.versionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const complete = !cursor && !error && !(loading && !versions.length);
  const newestFirst = [...versions].reverse();
  return (
    <section className="fb-history" aria-labelledby="fb-history-title">
      <h3 id="fb-history-title">Version history</h3>
      {!complete && !error && <p className="muted small" role="status">Loading versions…</p>}
      {Boolean(error) && <p className="fb-problem" role="alert">{fileError(error)} <Button size="xs" onClick={cursor ? () => void loadMore() : reload}>Try again</Button></p>}
      {complete && !versions.length && <p className="muted small">No earlier versions yet. Each time this file changes, the previous version is kept here.</p>}
      {complete && <ol className="fb-versions">
        {newestFirst.slice(0, limit).map((version) => {
          const current = version.versionId === file.versionId;
          const when = friendlyDate(version.ts);
          const detail = describeVersion(version, versions);
          const content = version.op !== "delete" && version.size !== null;
          return (
            <li key={version.versionId} data-current={current || undefined}>
              <p><time dateTime={new Date(version.ts).toISOString()} title={exactDate(version.ts)}>{when}</time>{detail && <> · {detail}</>}{current && <> · <strong>Current version</strong></>}</p>
              {content && !current && <div className="fb-version-actions">
                <Button variant="ghost" size="xs" aria-label={`Download the version from ${when}`} onClick={() => transfers.download(file.path, version.size, version.versionId)}><Download />Download</Button>
                {writeApi && <Button variant="ghost" size="xs" aria-label={`Restore the version from ${when}`} onClick={() => setRestoring(version)}><RotateCcw />Restore this version</Button>}
              </div>}
            </li>
          );
        })}
      </ol>}
      {complete && newestFirst.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit((value) => value + 20)}>Show older versions</Button>}
      {restoring && writeApi && <RestoreDialog name={name} version={restoring} onClose={() => setRestoring(null)} onConfirm={async () => {
        try { await writeApi.restore(file.path, restoring.versionId, file.versionId); }
        catch (reason) {
          // Someone changed the file meanwhile: show what is current now before the user decides again.
          if ((reason as { status?: number }).status === 412) onRestored();
          throw reason;
        }
        setRestoring(null);
        onRestored();
      }} />}
    </section>
  );
}

/** The right-hand panel for one file: what it is, a preview, and its history. A full-screen sheet on small screens. */
export function DetailsPanel({ api, writeApi, transfers, driveId, path, onClose, onChanged, onAction, sharingAllowed }: {
  api: DriveApi; writeApi: DriveApi | null; transfers: Transfers; driveId: string; path: string;
  sharingAllowed: boolean; onClose: () => void; onChanged: () => void; onAction: (kind: "rename" | "move" | "delete", item: Item) => void;
}) {
  const name = baseName(path);
  const load = useCallback(() => api.stat(path), [api, path]);
  const { data, loading, error, reload } = useLoad(load);
  const [fresh, setFresh] = useState<FileStat>();
  const file = fresh?.path === path ? fresh : data;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, [path]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Menus and dialogs handle their own Escape; only close the panel when none is open.
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector('[role="dialog"],[role="menu"]')) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const refresh = () => { void api.stat(path).then(setFresh, reload); onChanged(); };
  const isFile = file?.type === "file";
  return (
    <aside className="fb-details" aria-label={`Details for ${name}`}>
      <header className="fb-details-head">
        <h2 ref={title} tabIndex={-1}>{name}</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={onClose}><X /></Button>
      </header>
      {loading && !file && <div className="fb-details-loading" role="status" aria-label="Loading file details"><span className="fb-skeleton" /><span className="fb-skeleton" /><span className="fb-skeleton" /></div>}
      {Boolean(error) && !file && <div className="fb-details-error">
        <p role="alert">{fileError(error)}</p>
        <Button size="sm" onClick={reload}>Try again</Button>
      </div>}
      {file && !isFile && <p className="muted">This is a folder. Close this panel and open it from the list.</p>}
      {file && isFile && <>
        <FilePreview api={api} file={file} name={name} />
        {sharingAllowed && <LinkManager key={`${driveId}:${path}`} driveId={driveId} folder="" file={path} canWrite={false} />}
        <div className="fb-details-actions">
          <Button onClick={() => transfers.download(path, file.size)}><Download />Download</Button>
          <Button variant="ghost" asChild><a href={finderLink(driveId, path)}><FolderOpen />Open in Finder</a></Button>
          {writeApi && <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${name}`}><Ellipsis /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(() => {
                const item: Item = { name, path, isFolder: false, versionId: file.versionId, size: file.size };
                return <>
                  <DropdownMenuItem onSelect={() => onAction("rename", item)}>Rename…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onAction("move", item)}>Move to…</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete", item)}>Delete…</DropdownMenuItem>
                </>;
              })()}
            </DropdownMenuContent>
          </DropdownMenu>}
        </div>
        <dl className="fb-facts">
          <dt>Size</dt><dd>{formatBytes(file.size)}</dd>
          <dt>Modified</dt><dd title={exactDate(file.mtimeMs)}>{friendlyDate(file.mtimeMs)}</dd>
          <dt>Kind</dt><dd>{describeKind(name, false).label}</dd>
        </dl>
        <History api={api} writeApi={writeApi} transfers={transfers} file={file} name={name} onRestored={refresh} />
      </>}
    </aside>
  );
}
