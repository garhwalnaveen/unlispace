import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Archive, EyeOff, Undo2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, type Api, type Drive, type Org } from "./api";
import "./settings/settings.css";
import { ErrorNotice } from "./ui";

export type DriveAction =
  | { kind: "create"; org: Org }
  | { kind: "rename" | "delete" | "hard-delete" | "fork"; drive: Drive };

const BUCKET_RULE = "3–63 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";
/** Plain wording for the failures these dialogs can hit; anything else falls back to the shared messages. */
function driveError(kind: DriveAction["kind"], reason: unknown): unknown {
  if (!(reason instanceof ApiError)) return reason;
  const messages: Record<string, string> = {
    alias_taken: "Another drive already uses that bucket name. Choose a different one.",
    invalid_alias: `Bucket names use ${BUCKET_RULE}`,
    drive_has_forks: "Copies of this drive still rely on its data, so it can't be erased. Delete those copies first, or delete the drive without erasing its data.",
    fork_depth_exceeded: "This drive is already a copy of a copy, eight levels deep, which is the limit. Copy one of the earlier drives instead.",
    slow_down: "The drive is busy right now. Try again in a moment.",
    ...(kind === "fork" ? { plan_limit: "This workspace already has 50 copies, which is the limit. Delete a copy you no longer need, then try again." } : {}),
  };
  return messages[reason.code] ?? reason;
}

/** Create, rename, copy or delete a drive. Opened from the sidebar's "+" and each drive's menu. */
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
  const [name, setName] = useState(action.kind === "rename" ? action.drive.name : action.kind === "fork" ? `${action.drive.name} copy` : "");
  const [alias, setAlias] = useState(action.kind === "rename" ? action.drive.alias || "" : "");
  const [confirmation, setConfirmation] = useState("");
  const [erase, setErase] = useState(action.kind === "hard-delete");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [opener] = useState(() => document.activeElement);
  const deleting = action.kind === "delete" || action.kind === "hard-delete";
  const hadAlias = action.kind === "rename" && Boolean(action.drive.alias);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (!deleting && action.kind !== "create" && /^d-[0-9a-z]{26}$/.test(alias)) throw new Error("That bucket name looks like a drive ID, which is reserved. Choose a different one.");
      if (action.kind === "create") return onDone(await api.createDrive(action.org.id, name.trim()));
      if (action.kind === "fork") return onDone(await api.forkDrive(action.drive.id, name.trim(), alias || undefined));
      if (action.kind === "rename") await api.renameDrive(action.drive.id, name.trim(), alias || undefined);
      else {
        if (confirmation !== action.drive.name) return;
        await api.deleteDrive(action.drive.id, erase);
      }
      onDone();
    } catch (reason) {
      setError(driveError(action.kind, reason));
    } finally {
      setBusy(false);
    }
  }
  const title = action.kind === "create" ? "New drive"
    : action.kind === "rename" ? "Rename drive"
    : action.kind === "fork" ? `Make a copy of “${action.drive.name}”`
    : `Delete “${action.drive.name}”?`;
  const lede = action.kind === "create" ? `A drive holds files for ${action.org.name}. Open it here, in Finder with the Mac app, or from S3 tools.`
    : action.kind === "rename" ? "Everyone sees the new name. Files and links keep working."
    : action.kind === "fork" ? "The copy is ready instantly. It shares this drive's files and history up to now; from then on the two change independently."
    : null;
  const submitLabel = action.kind === "create" ? "Create drive" : action.kind === "rename" ? "Save" : action.kind === "fork" ? "Make a copy" : erase ? "Delete and erase" : "Delete drive";
  const bucketField = !deleting && action.kind !== "create" && <div className="st-field">
    <label htmlFor="drive-alias">Bucket name for S3 tools{action.kind === "fork" ? " (optional)" : ""}</label>
    <Input id="drive-alias" value={alias} onChange={(event) => setAlias(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false}
      required={hadAlias} minLength={3} maxLength={63} pattern={"[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]"} aria-describedby="alias-help" />
    <p id="alias-help" className="st-help">
      Also called the drive's alias. {BUCKET_RULE}{" "}
      {action.kind === "fork" ? "Leave it empty and Orbit picks one from the name." : "Tools that use the old name stop finding the drive."}
    </p>
  </div>;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent {...(lede ? {} : { "aria-describedby": undefined })} onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (opener instanceof HTMLElement) opener.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {lede && <DialogDescription>{lede}</DialogDescription>}
        </DialogHeader>
        <form className="st-form st-dialog" onSubmit={submit}>
          {deleting ? <>
            <ul className="st-consequences">
              <li><EyeOff aria-hidden="true" /><span>The drive and everything in it disappear right away for everyone who uses it: on the web, in Finder and for S3 tools.</span></li>
              <li><Undo2 aria-hidden="true" /><span><strong>A deleted drive can't be brought back.</strong> Orbit has no restore for drives yet and no recovery period, so make a copy first if you might need the files.</span></li>
              <li><Archive aria-hidden="true" /><span>{erase
                ? "Its data is erased for good, including every earlier version."
                : "Its data is not erased and still counts towards your storage. Copies made from this drive keep working."}</span></li>
            </ul>
            <div className="st-field">
              <label htmlFor="confirmation">Type “{action.drive.name}” to confirm</label>
              <Input id="confirmation" autoComplete="off" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} autoFocus required />
            </div>
            <details className="st-advanced" open={action.kind === "hard-delete" || undefined}>
              <summary>Advanced</summary>
              <div>
                <label className="st-check plain">
                  <input type="checkbox" checked={erase} disabled={busy} onChange={(event) => setErase(event.target.checked)} />
                  Also erase this drive's data permanently
                </label>
                <p className="st-help">Not possible while copies (forks) of this drive exist, because they share its history.</p>
              </div>
            </details>
          </> : <>
            <div className="st-field">
              <label htmlFor="drive-name">{action.kind === "fork" ? "Name for the copy" : "Drive name"}</label>
              <Input id="drive-name" value={name} disabled={busy} maxLength={100} onChange={(event) => setName(event.target.value)} autoFocus required
                onFocus={(event) => { if (action.kind !== "create") event.target.select(); }} />
            </div>
            {action.kind !== "create" && <details className="st-advanced">
              <summary>Advanced</summary>
              <div>
                {bucketField}
                {action.kind === "fork" && <p className="st-help">A copy is a fork: it remembers this drive and the moment it was made (its fork point), and shares stored data with it instead of duplicating it.</p>}
              </div>
            </details>}
          </>}
          <ErrorNotice error={error} />
          <div className="st-actions end">
            <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant={deleting ? "destructive" : "default"} disabled={busy || (deleting ? confirmation !== action.drive.name : !name.trim())}>
              {busy ? (deleting ? "Deleting…" : "Saving…") : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
