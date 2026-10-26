import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, type Api, type Drive, type Org } from "./api";
import { useAuth } from "./context";
import { driveLink } from "./links";
import { ErrorNotice, Modal, formatBytes, formatDate } from "./ui";

export type DriveAction =
  | { kind: "create"; org: Org }
  | { kind: "rename" | "delete" | "hard-delete" | "fork"; drive: Drive };
export function DriveDialog({
  action,
  api,
  onClose,
  onDone,
}: {
  action: DriveAction;
  api: Api;
  onClose: () => void;
  onDone: (drive?: Drive) => void;
}) {
  const [name, setName] = useState(
    action.kind === "rename" ? action.drive.name : "",
  );
  const [alias, setAlias] = useState(action.kind === "rename" ? action.drive.alias || "" : "");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const deleting = action.kind === "delete" || action.kind === "hard-delete";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (action.kind === "create")
        await api.createDrive(action.org.id, name.trim());
      else if (action.kind === "rename") {
        if (/^d-[0-9a-z]{26}$/.test(alias)) throw new Error("Drive IDs are reserved and cannot be used as aliases.");
        await api.renameDrive(action.drive.id, name.trim(), alias || undefined);
      }
      else if (action.kind === "fork") {
        if (/^d-[0-9a-z]{26}$/.test(alias)) throw new Error("Drive IDs are reserved and cannot be used as aliases.");
        const fork = await api.forkDrive(action.drive.id, name.trim(), alias);
        onDone(fork);
        return;
      }
      else {
        if (confirmation !== action.drive.name) return;
        await api.deleteDrive(action.drive.id, action.kind === "hard-delete");
      }
      onDone();
    } catch (reason) {
      setError(action.kind === "fork" && reason instanceof ApiError && reason.code === "plan_limit" ? "Your organization has reached its limit of 50 live forks. Delete a fork before creating another." : reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        deleting
          ? action.kind === "hard-delete" ? "Permanently delete drive" : "Delete drive"
          : action.kind === "create"
            ? "Create a drive"
            : action.kind === "fork" ? "Fork drive…" : "Rename drive"
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        {deleting ? (
          <>
            <p>
              {action.kind === "hard-delete" ? "Permanently deleting" : "Deleting"} <strong>{action.drive.name}</strong> removes access to
              this drive and all of its files. {action.kind === "hard-delete" && "This permanently removes drive state and cannot be undone."}
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
        {!deleting && action.kind !== "create" && <>
          <label htmlFor="drive-alias">Drive alias</label>
          <input id="drive-alias" value={alias} onChange={(event) => setAlias(event.target.value)}
            required={action.kind === "fork" || Boolean(action.drive.alias)} minLength={3} maxLength={63}
            pattern={"[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]"} aria-describedby="alias-help" />
          <p id="alias-help" className="muted small">3–63 lowercase letters, numbers or hyphens. Drive IDs are reserved.</p>
        </>}
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
            {busy ? "Saving…" : deleting ? action.kind === "hard-delete" ? "Permanently delete drive" : "Delete drive" : action.kind === "fork" ? "Fork drive" : "Save drive"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function DriveTools({ drive, canManage, onDone }: { drive: Drive; canManage: boolean; onDone: (created?: Drive) => void }) {
  const { auth } = useAuth();
  const [action, setAction] = useState<DriveAction | null>(null);
  return <div className="drive-tools">
    <p className="muted small">Alias: <code>{drive.alias || "Not set"}</code> · Usage: {formatBytes(drive.usageBytes || 0)}</p>
    <details><summary>Lineage</summary>
      {drive.forkOf ? <p>Forked from <Link to={driveLink(drive.forkOf.driveId)}>{drive.forkOf.driveId}</Link> at {formatDate(drive.forkOf.forkPoint)}</p> : <p>Root drive</p>}
      <p>Forks: {drive.forks?.length || 0}</p>
      <ul>{drive.forks?.map((id) => <li key={id}><Link to={driveLink(id)}>{id}</Link></li>)}</ul>
    </details>
    {canManage && <details className="drive-options"><summary>Drive options</summary><div className="actions">
      <button className="text-button" aria-label={`Rename ${drive.name}`} onClick={() => setAction({ kind: "rename", drive })}>Rename / edit alias</button>
      <button className="text-button" aria-label={`Fork ${drive.name}`} onClick={() => setAction({ kind: "fork", drive })}>Fork drive…</button>
      <button className="text-button danger-text" aria-label={`Delete ${drive.name}`} onClick={() => setAction({ kind: "delete", drive })}>Delete</button>
      <button className="text-button danger-text" aria-label={`Permanently delete ${drive.name}`} onClick={() => setAction({ kind: "hard-delete", drive })}>Permanently delete</button>
    </div></details>}
    {action && <DriveDialog action={action} api={auth.api} onClose={() => setAction(null)} onDone={(created) => { setAction(null); onDone(created); }} />}
  </div>;
}

export function ForkNotice({ drive }: { drive: Drive }) {
  return <p className="notice" role="status">Created <Link to={driveLink(drive.id)}>{drive.name}</Link>{drive.forkOf && ` · Fork point: ${formatDate(drive.forkOf.forkPoint)}`}</p>;
}
