import { Button } from "./components/ui/button";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Drive } from "./api";
import { useAuth } from "./context";
import { driveLink, finderLink } from "./links";
import { ErrorNotice, Icon, Loading, useLoad } from "./ui";
import { DriveDialog, DriveTools, ForkNotice, type DriveAction } from "./DriveTools";
import { OrgUsage } from "./Usage";

export function Home() {
  const { auth } = useAuth();
  const orgsLoad = useLoad(auth.api.orgs);
  const accessLoad = useLoad(auth.api.access);
  const { data, loading, error } = orgsLoad;
  // Readiness comes from /me/access; if it is unavailable the drive list still works from /orgs.
  const workspaces = Array.isArray(accessLoad.data?.workspaces) ? accessLoad.data.workspaces : [];
  const reload = () => { orgsLoad.reload(); accessLoad.reload(); };
  const [fork, setFork] = useState<Drive | null>(null);
  const [action, setAction] = useState<DriveAction | null>(null);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Your drives</h1>
          <p className="muted">
            Browse your files here or open a drive in Finder.
          </p>
        </div>
      </header>
      {fork && <ForkNotice drive={fork} />}
      <ErrorNotice error={error} />
      {Boolean(error) && <Button onClick={reload}>Try again</Button>}
      {loading && <Loading>Loading drives…</Loading>}
      {data?.orgs.length === 0 && (
        <div className="empty">
          <h2>No workspaces yet</h2>
          <p>
            Your account has no workspaces. Contact your workspace owner.
          </p>
        </div>
      )}
      {data?.orgs.map((org) => {
        const canManage = org.role === "owner" || org.role === "admin";
        const ws = workspaces.find((item) => item.id === org.id);
        const trialEndsAt = ws ? ws.trialEndsAt : org.trialEndsAt;
        const trialPending = ws ? ws.trialPending : org.trialPending;
        const days =
          trialEndsAt === null || ws?.state === "paid"
            ? null
            : Math.max(
                0,
                Math.ceil((trialEndsAt - Date.now()) / 86_400_000),
              );
        const drives = org.drives.filter((drive) => drive.status !== "deleted");
        return (
          <section
            className="org-section"
            key={org.id}
            aria-labelledby={`org-${org.id}`}
          >
            <div className="section-heading">
              <div>
                <h2 id={`org-${org.id}`}>{org.name}</h2>
                <p className="muted small">
                  {org.tier === "individual" ? "Individual" : "Teams"} ·{" "}
                  {org.role}
                  {days !== null &&
                    ` · ${days > 0 ? `${days} trial day${days === 1 ? "" : "s"} remaining` : "Trial ended"}`}
                </p>
              </div>
              <div className="actions"><Button asChild variant="ghost"><Link to={`/orgs/${encodeURIComponent(org.id)}/team`}>Team</Link></Button><Button asChild variant="ghost"><Link to={`/orgs/${encodeURIComponent(org.id)}/billing`}>Billing</Link></Button>
              {canManage && (
                <Button variant="default" onClick={() => setAction({ kind: "create", org })}>
                  New drive
                </Button>
              )}</div>
            </div>
            {trialPending && <p className="notice" role="status">Your account is verified. Your drive is not ready yet, so your seven-day trial has not started.</p>}
            {ws && !trialPending && !ws.storageReady && <p className="notice" role="status">Your account is verified. Your storage is still being prepared.</p>}
            {ws?.state === "expired" && <p className="notice" role="status">Your trial has ended. Your files remain readable; choose a plan in Billing to keep uploading.</p>}
            {(drives.some((drive) => drive.status === "provisioning_failed") || (ws && !ws.storageReady)) && <div className="workspace-status"><p className="muted small">Storage setup needs attention.</p><Button disabled={loading || accessLoad.loading} onClick={reload}>Retry drive setup</Button></div>}
            <div className="drive-list">
              {drives.map((drive) => (
                <article className="drive-card" key={drive.id}>
                  <div className="drive-heading">
                    <span className="drive-icon"><Icon name="drive" /></span>
                    <div>
                      <h3>
                        {drive.status === "ready" ? (
                          <Link to={driveLink(drive.id)}>{drive.name}</Link>
                        ) : (
                          drive.name
                        )}
                      </h3>
                      <p className="muted small">
                        {drive.status === "ready"
                          ? "Ready"
                          : "Drive setup could not finish. Retry to prepare your storage."}
                      </p>
                    </div>
                  </div>
                  <div className="drive-card-actions">
                    {drive.status === "ready" && (
                      <>
                        <Button asChild><Link to={driveLink(drive.id)}>Browse files</Link></Button>
                        <Button asChild><a href={finderLink(drive.id, "")}>Show in Finder</a></Button>
                      </>
                    )}
                  </div>
                  <DriveTools drive={drive} canManage={canManage} onDone={(created) => { setFork(created || null); reload(); }} />
                </article>
              ))}
              {!drives.length && (
                <div className="empty">
                  <h3>No drives yet</h3>
                  <p>{canManage ? "Create a drive to get started." : "A workspace owner or admin can create a drive."}</p>
                </div>
              )}
            </div>
            <footer className="org-storage"><OrgUsage orgId={org.id} /></footer>
          </section>
        );
      })}
      {action && (
        <DriveDialog
          action={action}
          api={auth.api}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            reload();
          }}
        />
      )}
    </>
  );
}
