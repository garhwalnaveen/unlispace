import { useCallback, useMemo } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, DriveApi, type Drive } from "../api";
import { Button } from "../components/ui/button";
import { useAuth } from "../context";
import { driveTransfers } from "../FileUpload";
import { driveLink } from "../links";
import { useWorkspace } from "../shell/workspace";
import { useLoad } from "../ui";
import { FolderView, type ReadOnly } from "./FolderView";
import { fileError } from "./format";
import { baseName, parentFolder } from "./paths";
import "./files.css";

function Skeleton({ label }: { label: string }) {
  return (
    <div className="fb"><div className="fb-loading" role="status" aria-label={label}>
      {Array.from({ length: 7 }, (_, index) => <div className="fb-skeleton-row" key={index}><span className="fb-skeleton" /><span className="fb-skeleton" style={{ width: `${34 + ((index * 17) % 40)}%` }} /><span className="fb-skeleton" /></div>)}
    </div></div>
  );
}
function Problem({ title, children, onRetry, home }: { title: string; children: string; onRetry?: () => void; home?: string }) {
  return (
    <div className="fb"><div className="fb-state" role="alert">
      <h1>{title}</h1>
      <p>{children}</p>
      <div className="fb-state-actions">
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
        <Button variant="ghost" asChild><Link to={home ?? "/"}>{home ? "Go to the top of this drive" : "Back to your files"}</Link></Button>
      </div>
    </div></div>
  );
}
/** A link without a trailing slash may name a file or a folder; find out, then show it at its lasting address. */
function Resolve({ api, id, path }: { api: DriveApi; id: string; path: string }) {
  const load = useCallback(() => api.stat(path), [api, path]);
  const { data, error, reload } = useLoad(load);
  if (data) return <Navigate replace to={data.type === "folder" ? driveLink(id, `${path}/`) : `${driveLink(id, parentFolder(path))}?file=${encodeURIComponent(baseName(path))}`} />;
  if (error instanceof ApiError && error.status === 404) return <Problem title="This item can’t be found" home={driveLink(id)}>It may have been moved, renamed or deleted.</Problem>;
  if (error) return <Problem title="This item couldn’t be opened" onRetry={reload} home={driveLink(id)}>{fileError(error)}</Problem>;
  return <Skeleton label="Opening…" />;
}
function readOnlyReason(drive: Drive, plan: ReturnType<typeof useWorkspace>["access"]): ReadOnly {
  if (plan?.state === "expired") return "expired";
  if (plan && !plan.writable) return plan.usedBytes > plan.quotaBytes ? "storage" : "paused";
  return drive.access === "read" ? "member" : null;
}

/** The home of the product: the files of one drive. `/drives/:id/<folder>/` with `?file=<name>` for an open file. */
export function DriveBrowser() {
  const { id = "", "*": path = "" } = useParams();
  const [params] = useSearchParams();
  const { auth } = useAuth();
  const { workspaces, orgs, loaded, loading: planLoading } = useWorkspace();
  const load = useCallback(() => auth.api.drive(id), [auth, id]);
  const { data, loading, error, reload } = useLoad(load);
  // While switching drives, the previous drive lingers for a frame; never pair it with the new address.
  const drive = data?.id === id ? data : undefined;
  const readOnly = drive ? readOnlyReason(drive, workspaces.find((item) => item.id === drive.orgId) ?? null) : null;
  const canWrite = Boolean(drive) && !readOnly;
  const api = useMemo(() => new DriveApi(auth.api, id), [auth, id]);
  const writeApi = useMemo(() => (canWrite ? new DriveApi(auth.api, id, "write") : null), [auth, id, canWrite]);
  const ready = Boolean(drive) && !loading && (loaded || !planLoading);
  const transfers = useMemo(() => (ready ? driveTransfers(auth, id, api, writeApi) : null), [ready, auth, id, api, writeApi]);
  // The sidebar can rename a drive while it is open; prefer the name it shows.
  const name = orgs.flatMap((org) => org.drives).find((item) => item.id === id)?.name ?? drive?.name ?? "";

  if (error) {
    const gone = error instanceof ApiError && (error.status === 404 || error.status === 403);
    return <Problem title={gone ? "This drive isn’t available" : "This drive couldn’t be opened"} onRetry={gone ? undefined : reload}>{gone ? "It may have been deleted, or you may no longer have access to it." : fileError(error)}</Problem>;
  }
  // Wait for the workspace's plan as well, so write controls never flash on a view-only drive.
  if (!drive || !transfers) return <Skeleton label="Opening drive…" />;
  if (drive.status !== "ready")
    return <Problem title={drive.status === "deleted" ? "This drive was deleted" : "This drive isn’t ready yet"} onRetry={drive.status === "deleted" ? undefined : reload}>
      {drive.status === "deleted" ? "Its files are no longer available here." : "Orbit is still setting it up. Give it a moment, then try again."}
    </Problem>;
  if (path && !path.endsWith("/")) return <Resolve api={api} id={id} path={path} />;
  return <FolderView key={`${id}:${path}`} drive={drive} driveName={name} api={api} writeApi={writeApi} transfers={transfers} folder={path} file={params.get("file")} readOnly={readOnly} sharingAllowed={orgs.find(org => org.id === drive.orgId)?.tier === "individual"} />;
}
