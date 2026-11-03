import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
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
  const [query, setQuery] = useState("");
  const totalDrives = data?.orgs.reduce((count, org) => count + org.drives.filter((drive) => drive.status !== "deleted").length, 0) || 0;
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace overview</p>
          <h1>Your drives</h1>
          <p className="muted">
            Browse your files here or open a drive in Finder.
          </p>
        </div>
      </header>
      {data && data.orgs.length > 0 && <section className="workspace-overview" aria-label="Workspace summary">
        <div className="overview-stat"><span className="overview-icon"><Icon name="drive" /></span><div><strong>{totalDrives}</strong><span>Active drive{totalDrives === 1 ? "" : "s"}</span></div></div>
        <div className="overview-stat"><span className="overview-icon"><Icon name="user" /></span><div><strong>{data.orgs.length}</strong><span>Workspace{data.orgs.length === 1 ? "" : "s"}</span></div></div>
        <div className="overview-note"><Icon name="folder" /><div><strong>Your files, wherever you work.</strong><p>Browse in the web app. Keep working in Finder.</p></div></div>
      </section>}
      {data && totalDrives > 0 && <div className="drive-library-toolbar"><div><h2>Drive library</h2><p className="muted small">Organized by workspace</p></div><div className="search-field"><Icon name="search" /><Input aria-label="Find a drive" placeholder="Find a drive…" value={query} onChange={(event) => setQuery(event.target.value)} /></div></div>}
      {fork && <ForkNotice drive={fork} />}
      <ErrorNotice error={error} />
      {Boolean(error) && <Button onClick={reload}>Try again</Button>}
      {loading && <Loading>Loading drives…</Loading>}
      {data?.orgs.length === 0 && (
        <div className="empty panel">
          <span className="empty-symbol"><Icon name="user" /></span>
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
        const visibleDrives = drives.filter((drive) => drive.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
        return (
          <section
            className="org-section"
            key={org.id}
            aria-labelledby={`org-${org.id}`}
          >
            <div className="section-heading">
              <div>
                <div className="org-title"><span className="workspace-monogram" aria-hidden="true">{org.name.charAt(0).toUpperCase()}</span><h2 id={`org-${org.id}`}>{org.name}</h2><span className="count-badge">{drives.length}</span></div>
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
                  <Icon name="plus" /> New drive
                </Button>
              )}</div>
            </div>
            {trialPending && <p className="notice" role="status">Your account is verified. Your drive is not ready yet, so your seven-day trial has not started.</p>}
            {ws && !trialPending && !ws.storageReady && <p className="notice" role="status">Your account is verified. Your storage is still being prepared.</p>}
            {ws?.state === "expired" && <p className="notice" role="status">Your trial has ended. Your files remain readable; choose a plan in Billing to keep uploading.</p>}
            {(drives.some((drive) => drive.status === "provisioning_failed") || (ws && !ws.storageReady)) && <div className="workspace-status"><p className="muted small">Storage setup needs attention.</p><Button disabled={loading || accessLoad.loading} onClick={reload}>Retry drive setup</Button></div>}
            <div className="drive-list">
              {visibleDrives.map((drive) => (
                <article className="drive-card" key={drive.id} aria-label={drive.name}>
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
                          ? <><span className="status-dot" aria-hidden="true" />Ready to use</>
                          : "Drive setup could not finish. Retry to prepare your storage."}
                      </p>
                    </div>
                  </div>
                  <div className="drive-card-actions">
                    {drive.status === "ready" && (
                      <>
                        <Button asChild><Link to={driveLink(drive.id)}>Browse files <Icon name="chevron" /></Link></Button>
                        <Button asChild variant="ghost"><a href={finderLink(drive.id, "")}>Show in Finder <Icon name="external" /></a></Button>
                      </>
                    )}
                  </div>
                  <DriveTools drive={drive} canManage={canManage} onDone={(created) => { setFork(created || null); reload(); }} />
                </article>
              ))}
              {drives.length > 0 && visibleDrives.length === 0 && <div className="empty"><span className="empty-symbol"><Icon name="search" /></span><h3>No matching drives</h3><p>Try another name to find a drive in this workspace.</p><Button onClick={() => setQuery("")}>Clear search</Button></div>}
              {!drives.length && (
                <div className="empty">
                  <span className="empty-symbol"><Icon name="drive" /></span>
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
