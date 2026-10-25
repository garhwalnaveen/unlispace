import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { Api, Drive, Org } from "./api";
import { useAuth } from "./context";
import { driveLink, finderLink } from "./links";
import { ErrorNotice, FileIcon, Loading, Modal, useLoad } from "./ui";

type DriveAction =
  | { kind: "create"; org: Org }
  | { kind: "rename" | "delete"; drive: Drive };
function DriveDialog({
  action,
  api,
  onClose,
  onDone,
}: {
  action: DriveAction;
  api: Api;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(
    action.kind === "rename" ? action.drive.name : "",
  );
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const deleting = action.kind === "delete";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (action.kind === "create")
        await api.createDrive(action.org.id, name.trim());
      else if (action.kind === "rename")
        await api.renameDrive(action.drive.id, name.trim());
      else {
        if (confirmation !== action.drive.name) return;
        await api.deleteDrive(action.drive.id);
      }
      onDone();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        deleting
          ? "Delete drive"
          : action.kind === "create"
            ? "Create a drive"
            : "Rename drive"
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        {action.kind === "delete" ? (
          <>
            <p>
              Deleting <strong>{action.drive.name}</strong> removes access to
              this drive and all of its files.
            </p>
            <label htmlFor="confirmation">
              Type “{action.drive.name}” to confirm
            </label>
            <input
              id="confirmation"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoFocus
              required
            />
          </>
        ) : (
          <>
            <label htmlFor="drive-name">Drive name</label>
            <input
              id="drive-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              required
            />
          </>
        )}
        <ErrorNotice error={error} />
        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={deleting ? "danger" : "primary"}
            disabled={
              busy ||
              (deleting ? confirmation !== action.drive.name : !name.trim())
            }
          >
            {busy ? "Saving…" : deleting ? "Delete drive" : "Save drive"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Home() {
  const { auth } = useAuth();
  const { data, loading, error, reload } = useLoad(auth.api.orgs);
  const [action, setAction] = useState<DriveAction | null>(null);
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORK, WITH ROOM TO GROW</p>
          <h1>Your drives</h1>
          <p className="muted">
            A familiar place for everything you’re working on.
          </p>
        </div>
      </header>
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
                <button onClick={() => setAction({ kind: "create", org })}>
                  + New drive
                </button>
              )}</div>
            </div>
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
                  <div className="drive-card-actions">
                    {drive.status === "ready" && (
                      <a href={finderLink(drive.id, "")}>Show in Finder ↗</a>
                    )}
                    {canManage && (
                      <div className="actions">
                        <button
                          className="text-button"
                          aria-label={`Rename ${drive.name}`}
                          onClick={() => setAction({ kind: "rename", drive })}
                        >
                          Rename
                        </button>
                        <button
                          className="text-button danger-text"
                          aria-label={`Delete ${drive.name}`}
                          onClick={() => setAction({ kind: "delete", drive })}
                        >
                          Delete
                        </button>
                      </div>
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
