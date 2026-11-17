import { Button } from "./components/ui/button";
import { useEffect, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Input } from "./components/ui/input";
import { Link } from "react-router-dom";
import type { Drive } from "./api";
import { useAuth } from "./context";
import { driveLink, finderLink } from "./links";
import { ErrorNotice, Icon, useLoad } from "./ui";
import { DriveDialog, DriveTools, ForkNotice, type DriveAction } from "./DriveTools";

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
  const [filter, setFilter] = useState("All");
  const search = useRef<HTMLInputElement>(null);
  const driveCount = data?.orgs.reduce((count, org) => count + org.drives.filter((drive) => drive.status !== "deleted").length, 0);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='dialog']")))) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <>
      <header className="drive-summary">
        <h1>Your drives</h1>
        {loading && !data ? <p aria-hidden="true"><span className="drive-skeleton drive-skeleton-count" /> drives</p> : data && <p>{driveCount} {driveCount === 1 ? "drive" : "drives"}</p>}
      </header>
      {fork && <ForkNotice drive={fork} />}
      <ErrorNotice error={error} />
      {Boolean(error) && <Button onClick={reload}>Try again</Button>}
      {loading && !data && (
        <div className="drives-panel drive-loading" role="status">
          <div className="drive-searchbar">
            <div className="drive-search"><Search size={16} aria-hidden="true" />Loading your drives…</div>
            <div className="drive-loading-filters" aria-hidden="true"><span className="drive-skeleton" /><span className="drive-skeleton" /><span className="drive-skeleton" /></div>
          </div>
          <div className="org-section" aria-hidden="true">
            <div className="section-heading">
              <div className="drive-loading-lines"><span className="drive-skeleton" /><span className="drive-skeleton" /></div>
              <span className="drive-skeleton drive-loading-button" />
            </div>
            <div className="drive-card">
              <div className="drive-heading">
                <span className="drive-skeleton drive-loading-icon" />
                <div className="drive-loading-lines"><span className="drive-skeleton" /><span className="drive-skeleton" /></div>
              </div>
              <div className="drive-card-actions"><span className="drive-skeleton drive-loading-button" /><span className="drive-skeleton drive-loading-button" /></div>
            </div>
          </div>
        </div>
      )}
      {data?.orgs.length === 0 && (
        <div className="empty">
          <h2>No workspaces yet</h2>
          <p>
            Your account has no workspaces. Contact your workspace owner.
          </p>
        </div>
      )}
      {Boolean(data?.orgs.length) && <div className="drives-panel">
      <div className="drive-searchbar">
        <div className="drive-search">
          <Search size={16} aria-hidden="true" />
          <Input ref={search} type="search" aria-label="Search drives" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="h-12 rounded-none border-0 bg-transparent px-0 text-sm shadow-none dark:bg-transparent focus-visible:ring-0" />
          {query ? <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}><X /></Button> : <kbd aria-hidden="true">/</kbd>}
        </div>
        <div className="drive-filters" role="group" aria-label="Filter drives">
          {["All", "Ready", "Needs setup"].map((value) => <Button key={value} variant="ghost" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</Button>)}
        </div>
      </div>
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
        const visibleDrives = drives.filter((drive) => drive.name.toLowerCase().includes(query.trim().toLowerCase()) && (filter === "All" || (filter === "Ready" ? drive.status === "ready" : drive.status === "provisioning_failed")));
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
              <div className="actions">
              {canManage && drives.length > 0 && (
                <Button variant="default" onClick={() => setAction({ kind: "create", org })}>
                  <Plus size={15} /> New drive
                </Button>
              )}</div>
            </div>
            {trialPending && <p className="notice" role="status">Your account is verified. Your drive is not ready yet, so your seven-day trial has not started.</p>}
            {ws && !trialPending && !ws.storageReady && <p className="notice" role="status">Your account is verified. Your storage is still being prepared.</p>}
            {ws?.state === "expired" && <p className="notice" role="status">Your trial has ended. Your files remain readable; choose a plan in Billing to keep uploading.</p>}
            {(drives.some((drive) => drive.status === "provisioning_failed") || (ws && !ws.storageReady)) && <div className="workspace-status"><p className="muted small">Storage setup needs attention.</p><Button disabled={loading || accessLoad.loading} onClick={reload}>Retry drive setup</Button></div>}
            <div>
              {visibleDrives.map((drive) => (
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
                        <span className={`drive-status-dot ${drive.status === "ready" ? "ready" : ""}`} aria-hidden="true" />
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
              {!drives.length ? (
                <div className="drive-empty">
                  <span className="empty-drive-icon"><Icon name="drive" /></span>
                  <h3>No drives yet</h3>
                  {canManage ? <Button variant="default" onClick={() => setAction({ kind: "create", org })}><Plus size={16} />New drive</Button> : <p className="muted">A workspace owner or admin can create a drive.</p>}
                  <Button asChild><Link to="/overview">Explore Orbit</Link></Button>
                </div>
              ) : !visibleDrives.length && (
                <div className="drive-empty"><Search size={24} className="muted" aria-hidden="true" /><h3>No matching drives</h3><Button onClick={() => { setQuery(""); setFilter("All"); }}>Clear filters</Button></div>
              )}
            </div>
          </section>
        );
      })}
      </div>}
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
