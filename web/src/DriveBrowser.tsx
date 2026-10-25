import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { DriveApi, type Drive, type FileStat, type Version } from "./api";
import { useAuth } from "./context";
import { downloadFile, MAX_WEB_DOWNLOAD } from "./download";
import { driveLink, finderLink } from "./links";
import {
  ErrorNotice,
  FileIcon,
  formatBytes,
  formatDate,
  Loading,
  useLoad,
  Modal,
} from "./ui";
import { DriveTools, ForkNotice } from "./DriveTools";
import { Upload } from "./FileUpload";
import { useListing, useVersions } from "./usePagination";

function Breadcrumbs({ drive, path }: { drive: Drive; path: string }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav className="breadcrumbs" aria-label="File location">
      <Link to="/">Drives</Link>
      <span aria-hidden="true">/</span>
      <Link to={driveLink(drive.id)}>{drive.name}</Link>
      {segments.map((segment, index) => (
        <span className="crumb" key={index}>
          <span aria-hidden="true">/</span>
          {index === segments.length - 1 ? (
            <span aria-current="page">{segment}</span>
          ) : (
            <Link
              to={driveLink(
                drive.id,
                segments.slice(0, index + 1).join("/") + "/",
              )}
            >
              {segment}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
function Folder({ api, writeApi, path }: { api: DriveApi; writeApi: DriveApi | null; path: string }) {
  const listing = useListing(api, path);
  const content = (
    <>
      <div className="section-heading">
        <p className="muted small">
          {listing.entries.length} item{listing.entries.length === 1 ? "" : "s"}
          {listing.cursor ? " loaded" : ""}
        </p>
        <button disabled={listing.loading} onClick={listing.reload}>
          Refresh folder
        </button>
      </div>
      <ErrorNotice error={listing.error} />
      {Boolean(listing.error) && !listing.entries.length && (
        <button onClick={listing.reload}>Try again</button>
      )}
      <div className="file-table">
        <div className="file-row file-table-head" aria-hidden="true">
          <span>Name</span>
          <span>Size</span>
          <span>Modified</span>
        </div>
        <ul aria-label="Files and folders">
          {listing.entries.map((entry) => {
            const name = entry.name.replace(/\/$/, "");
            const entryPath =
              path + name + (entry.type === "folder" ? "/" : "");
            return (
              <li key={`${entry.type}:${entry.name}`}>
                <Link className="file-row" to={driveLink(api.id, entryPath)}>
                  <span className="file-name">
                    <FileIcon folder={entry.type === "folder"} />
                    <span>{name}</span>
                  </span>
                  <span className="muted small">
                    {entry.type === "folder"
                      ? "Folder"
                      : formatBytes(entry.size)}
                  </span>
                  <time
                    className="muted small"
                    dateTime={new Date(entry.mtimeMs).toISOString()}
                  >
                    {formatDate(entry.mtimeMs)}
                  </time>
                </Link>
              </li>
            );
          })}
        </ul>
        {!listing.loading && !listing.error && !listing.entries.length && (
          <div className="empty">
            <FileIcon folder />
            <h2>A little breathing room.</h2>
            <p>{writeApi ? "This folder is empty. Drop files here to get started." : "This folder is empty."}</p>
          </div>
        )}
      </div>
      {listing.loading && <Loading>Reading folder…</Loading>}
      {listing.cursor && (
        <button
          className="load-more"
          disabled={listing.loading}
          onClick={() => void listing.loadMore()}
        >
          {listing.loading ? "Loading…" : "Load more"}
        </button>
      )}
    </>
  );
  return writeApi ? <Upload api={writeApi} path={path} onDone={listing.reload}>{content}</Upload> : content;
}
function Versions({
  api,
  path,
  onDownload,
  downloading,
  writeApi,
  headVersion,
  onRestored,
}: {
  api: DriveApi;
  path: string;
  onDownload: (version: string) => void;
  downloading: boolean;
  writeApi: DriveApi | null;
  headVersion: string;
  onRestored: () => void;
}) {
  const { versions, cursor, loading, error, reload, loadMore } = useVersions(
    api,
    path,
  );
  const [asOf, setAsOf] = useState("");
  const [selected, setSelected] = useState<Version | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const [restoreVersion, setRestoreVersion] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<unknown>();
  const [restored, setRestored] = useState(false);
  async function restore() {
    if (!writeApi || !restoreVersion) return;
    setBusy(true); setRestoreError(undefined);
    try {
      await writeApi.restore(path, restoreVersion.versionId, headVersion);
      setRestoreVersion(null); setRestored(true); setSelected(null); reload(); onRestored();
    } catch (reason) { setRestoreError(reason); }
    finally { setBusy(false); }
  }
  return (
    <section className="versions" aria-labelledby="versions-title">
      <h2 id="versions-title">Version history</h2>
      <p className="muted small">Every save, from oldest to newest.</p>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        const instant = new Date(asOf).getTime();
        const head = versions.filter((version) => version.ts <= instant).sort((a, b) => b.ts - a.ts || b.seq - a.seq)[0];
        setSelected(head || null);
        setSelectionError(head ? "" : "This file did not exist at that time.");
      }}>
        <label htmlFor="history-as-of">View as of…</label>
        <input id="history-as-of" type="datetime-local" step="1" required value={asOf} onChange={(event) => { setAsOf(event.target.value); setSelected(null); setSelectionError(""); }} />
        <button disabled={loading || Boolean(cursor) || Boolean(error) || !asOf}>View as of</button>
        {cursor && <p className="muted small">Load all versions before choosing a time.</p>}
      </form>
      {selectionError && <p role="status">{selectionError}</p>}
      {selected && <section className="panel" aria-label="Version as of selected time">
        <h3>Head at {formatDate(new Date(asOf).getTime())}</h3>
        {selected.op === "delete" ? <p>This file was deleted at that time.</p> : <>
          <p><code>{selected.versionId}</code> · {formatDate(selected.ts)} · {formatBytes(selected.size)}</p>
          {selected.size <= MAX_WEB_DOWNLOAD ? <button disabled={downloading} onClick={() => onDownload(selected.versionId)}>Download selected version</button> : <p>Use the desktop app for versions above 512 MiB.</p>}
          {writeApi && <button disabled={busy} onClick={() => { setRestoreError(undefined); setRestoreVersion(selected); }}>Restore selected version</button>}
        </>}
      </section>}
      {restored && <p role="status">Version restored as the new head.</p>}
      <ErrorNotice error={error} />
      {Boolean(error) && <button onClick={reload}>Try again</button>}
      {loading && <Loading>Reading versions…</Loading>}
      {!loading && !error && !versions.length && (
        <p className="muted">No versions recorded.</p>
      )}
      <ol className="version-list">
        {versions.map((version) => (
          <li key={version.versionId}>
            <div className="section-heading">
              <strong>{formatDate(version.ts)}</strong>
              <span className="muted small">{version.op}</span>
            </div>
            <p className="small muted">
              {formatBytes(version.size)} · Sequence {version.seq}
            </p>
            <code>{version.versionId}</code>
            <p className="small muted">By {version.actor || "Unknown actor"}</p>
            {writeApi && version.op !== "delete" && version.op !== "rename" && <button disabled={busy} aria-label={`Restore version ${version.versionId}`} onClick={() => { setRestoreError(undefined); setRestoreVersion(version); }}>Restore this version</button>}
            {version.op !== "delete" &&
              version.op !== "rename" &&
              (version.size > MAX_WEB_DOWNLOAD ? (
                <p className="small">
                  Use the desktop app for versions above 512 MiB.
                </p>
              ) : (
                <button
                  disabled={downloading}
                  onClick={() => onDownload(version.versionId)}
                >
                  Download this version
                </button>
              ))}
          </li>
        ))}
      </ol>
      {cursor && (
        <button disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading…" : "Load more versions"}
        </button>
      )}
      {restoreVersion && <Modal title="Restore version" onClose={() => { if (!busy) setRestoreVersion(null); }}>
        <p>Restore {restoreVersion.versionId} as the current version of {path}? Existing history is kept.</p>
        <ErrorNotice error={restoreError} />
        <div className="actions"><button disabled={busy} onClick={() => setRestoreVersion(null)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void restore()}>{busy ? "Restoring…" : "Confirm restore"}</button></div>
      </Modal>}
    </section>
  );
}
function FileDetails({
  api,
  file,
  path,
  writeApi,
  onRestored,
}: {
  api: DriveApi;
  file: FileStat;
  path: string;
  writeApi: DriveApi | null;
  onRestored: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const showVersions = params.get("panel") === "versions";
  const [progress, setProgress] = useState<{
    bytes: number;
    total: number;
  } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  async function download(versionId?: string) {
    setDownloading(true);
    setError(undefined);
    setDone(false);
    setProgress(null);
    try {
      await downloadFile(
        api,
        path,
        (bytes, total) => setProgress({ bytes, total }),
        versionId,
      );
      setDone(true);
    } catch (reason) {
      setError(reason);
    } finally {
      setDownloading(false);
    }
  }
  return (
    <div className={`detail-layout ${showVersions ? "with-history" : ""}`}>
      <section
        className="panel file-details"
        aria-labelledby="file-details-title"
      >
        <FileIcon />
        <h2 id="file-details-title">File details</h2>
        <dl>
          <dt>Size</dt>
          <dd>{formatBytes(file.size)}</dd>
          <dt>Modified</dt>
          <dd>{formatDate(file.mtimeMs)}</dd>
          <dt>Type</dt>
          <dd>{file.contentType || "File"}</dd>
          <dt>Version</dt>
          <dd>
            <code>{file.versionId}</code>
          </dd>
          <dt>Sequence</dt>
          <dd>{file.seq}</dd>
        </dl>
        {file.size > MAX_WEB_DOWNLOAD ? (
          <p className="notice">
            This file is above 512 MiB. Use the desktop app to download it in
            Finder.
          </p>
        ) : (
          <button
            className="primary"
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? "Downloading…" : "Download file"}
          </button>
        )}
        <button
          aria-expanded={showVersions}
          aria-controls="history-panel"
          onClick={() => setParams(showVersions ? {} : { panel: "versions" })}
        >
          {showVersions ? "Close version history" : "Version history"}
        </button>
        <ErrorNotice error={error} />
        {downloading && (
          <div role="status">
            <p>
              {progress
                ? `${formatBytes(progress.bytes)} of ${formatBytes(progress.total)}`
                : "Fetching file manifest…"}
            </p>
            <progress
              aria-label="Download progress"
              max={progress?.total || 1}
              value={progress?.bytes || 0}
            />
          </div>
        )}
        {done && (
          <p role="status">
            Your file is ready. Check your browser’s downloads.
          </p>
        )}
      </section>
      {showVersions && (
        <aside id="history-panel" className="panel">
          <Versions
            api={api}
            path={path}
            onDownload={(version) => void download(version)}
            downloading={downloading}
            writeApi={writeApi}
            headVersion={file.versionId}
            onRestored={onRestored}
          />
        </aside>
      )}
    </div>
  );
}
function DriveContents({
  drive,
  api,
  path,
  onDriveChanged,
}: {
  drive: Drive;
  api: DriveApi;
  path: string;
  onDriveChanged: (created?: Drive) => void;
}) {
  const { auth } = useAuth();
  const writeApi = useMemo(() => drive.access === "read" ? null : new DriveApi(auth.api, drive.id, "write"), [auth, drive.id, drive.access]);
  const load = useCallback(
    () =>
      path && !path.endsWith("/") ? api.stat(path) : Promise.resolve(null),
    [api, path],
  );
  const { data: file, loading, error, reload } = useLoad(load);
  const [restoredFile, setRestoredFile] = useState<FileStat | null>(null);
  const title = path.split("/").filter(Boolean).pop() || drive.name;
  return (
    <>
      <Breadcrumbs drive={drive} path={path} />
      <header className="page-heading browser-heading">
        <div>
          <p className="eyebrow">{path ? drive.name : "YOUR CLOUD DRIVE"}</p>
          <h1>{title}</h1>
        </div>
        <a className="button" href={finderLink(drive.id, path)}>
          Show in Finder ↗
        </a>
      </header>
      <ErrorNotice error={error} />
      {Boolean(error) && <button onClick={reload}>Try again</button>}
      {!path && <DriveTools drive={drive} canManage={drive.access === "admin"} onDone={onDriveChanged} />}
      {loading && !file ? (
        <Loading>Opening drive…</Loading>
      ) : (
        !error &&
        (file?.type === "file" ? (
          <FileDetails key={path} api={api} file={restoredFile || file} path={path} writeApi={writeApi} onRestored={() => { void api.stat(path).then(setRestoredFile).catch(() => reload()); }} />
        ) : (
          <Folder
            api={api}
            writeApi={writeApi}
            path={path && !path.endsWith("/") ? path + "/" : path}
          />
        ))
      )}
    </>
  );
}
export function DriveBrowser() {
  const { id = "", "*": path = "" } = useParams();
  const { auth } = useAuth();
  const api = useMemo(() => new DriveApi(auth.api, id), [auth, id]);
  const load = useCallback(() => auth.api.drive(id), [auth, id]);
  const { data: drive, loading, error, reload } = useLoad(load);
  const [fork, setFork] = useState<Drive | null>(null);
  return (
    <>
      <ErrorNotice error={error} />
      {Boolean(error) && <button onClick={reload}>Try again</button>}
      {fork && <ForkNotice drive={fork} />}
      {loading && <Loading>Finding your drive…</Loading>}
      {drive &&
        (drive.status === "ready" ? (
          <DriveContents
            key={`${id}:${path}`}
            drive={drive}
            api={api}
            path={path}
            onDriveChanged={(created) => { setFork(created || null); reload(); }}
          />
        ) : (
          <div className="empty">
            <h1>Drive unavailable</h1>
            <p>
              This drive is{" "}
              {drive.status === "deleted"
                ? "deleted"
                : "waiting to be provisioned"}
              . Return to your drives to retry provisioning.
            </p>
            <Link to="/">Your drives</Link>
          </div>
        ))}
    </>
  );
}
