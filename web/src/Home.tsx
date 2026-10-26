import { useState } from "react";
import { Link } from "react-router-dom";
import type { Drive } from "./api";
import { useAuth } from "./context";
import { driveLink, finderLink } from "./links";
import { ErrorNotice, FileIcon, Loading, useLoad } from "./ui";
import { DriveDialog, DriveTools, ForkNotice, type DriveAction } from "./DriveTools";
import { OrgUsage } from "./Usage";

export function Home() {
  const { auth } = useAuth();
  const { data, loading, error, reload } = useLoad(auth.api.orgs);
  const [fork, setFork] = useState<Drive | null>(null);
  const [action, setAction] = useState<DriveAction | null>(null);
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">WORKSPACE / OVERVIEW</p>
          <h1>Your drives</h1>
          <p className="muted">
            Everything you’re working on, with room to grow.
          </p>
        </div>
      </header>
      {fork && <ForkNotice drive={fork} />}
      <ErrorNotice error={error} />
      {Boolean(error) && <button onClick={reload}>Try again</button>}
      {loading && <Loading>Finding your spaces…</Loading>}
      {data?.orgs.length === 0 && (
        <div className="empty">
          <h2>No spaces yet</h2>
          <p>
            Your account has no organizations. Contact your workspace owner.
          </p>
        </div>
      )}
      {data?.orgs.map((org) => {
        const canManage = org.role === "owner" || org.role === "admin";
        const days =
          org.trialEndsAt === null
            ? null
            : Math.max(
                0,
                Math.ceil((org.trialEndsAt - Date.now()) / 86_400_000),
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
              <div className="actions"><Link to={`/orgs/${encodeURIComponent(org.id)}/billing`}>Billing</Link>
              {canManage && (
                <button className="primary" onClick={() => setAction({ kind: "create", org })}>
                  + New drive
                </button>
              )}</div>
            </div>
            <OrgUsage orgId={org.id} />
            <div className="drives-grid">
              {drives.map((drive) => (
                <article className="drive-card" key={drive.id}>
                  <div className="drive-card-top">
                    <FileIcon folder />
                    <span className="muted small">
                      {drive.placement || "Automatic region"}
                    </span>
                  </div>
                  <h3>
                    {drive.status === "ready" ? (
                      <Link to={driveLink(drive.id)}>{drive.name}</Link>
                    ) : (
                      drive.name
                    )}
                  </h3>
                  <p className="muted small">
                    {drive.status === "ready"
                      ? "Ready when you are"
                      : "Provisioning needs attention. Reload to retry."}
                  </p>
                  <DriveTools drive={drive} canManage={canManage} onDone={(created) => { setFork(created || null); reload(); }} />
                  <div className="drive-card-actions">
                    {drive.status === "ready" && (
                      <a href={finderLink(drive.id, "")}>Show in Finder ↗</a>
                    )}

                  </div>
                </article>
              ))}
              {!drives.length && (
                <div className="empty">
                  <h3>A fresh space</h3>
                  <p>Create a drive to get started.</p>
                </div>
              )}
            </div>
          </section>
        );
      })}
      <aside className="desktop-note">
        <span aria-hidden="true">↗</span>
        <div>
          <strong>Make room on your Mac.</strong>
          <p className="muted small">
            Use Unlispace in Finder to work with files of any size. Every save
            keeps a version.
          </p>
        </div>
      </aside>
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
