import { NativeSelect } from "./components/ui/native-select";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { KeyRound, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Drive, Org } from "./api";
import { useAuth } from "./context";
import type { AccessKey, KeySecret } from "./keys";
import { CopyButton, formatAgo, formatDay, PageHeader } from "./settings/parts";
import { BUCKET_PLACEHOLDER, bucketName, S3_REGION, s3Endpoint, snippet, SNIPPET_LABELS, type SnippetKind } from "./settings/s3";
import { useWorkspace } from "./shell/workspace";
import { ErrorNotice, Loading, Modal, useLoad } from "./ui";

type Access = AccessKey["access"];
const ACCESS: Record<Access, { label: string; hint: string }> = {
  read: { label: "Read only", hint: "Can list and download files." },
  write: { label: "Read and write", hint: "Can also upload, change and delete files." },
  admin: { label: "Full control", hint: "Can also create and delete drives." },
};
/** What a workspace role may hand to a key: viewers read, members write, owners and admins manage. */
const allowedAccess = (role: Org["role"] | undefined): Access[] =>
  role === "owner" || role === "admin" ? ["read", "write", "admin"] : role === "member" ? ["read", "write"] : ["read"];
const keyName = (key: AccessKey) => key.label || "Untitled key";

/** Parents first, each followed by the keys made from it. */
function ordered(keys: AccessKey[]): { key: AccessKey; depth: number }[] {
  const ids = new Set(keys.map((key) => key.accessKeyId)), seen = new Set<string>(), rows: { key: AccessKey; depth: number }[] = [];
  const visit = (key: AccessKey, depth: number) => {
    if (seen.has(key.accessKeyId)) return;
    seen.add(key.accessKeyId); rows.push({ key, depth });
    keys.filter((child) => child.parent === key.accessKeyId).forEach((child) => visit(child, depth + 1));
  };
  keys.filter((key) => !key.parent || !ids.has(key.parent)).forEach((key) => visit(key, 0));
  keys.forEach((key) => visit(key, 0));
  return rows;
}
function descendants(keys: AccessKey[], id: string): AccessKey[] {
  const found: AccessKey[] = [];
  const visit = (parent: string) => keys.forEach((key) => {
    if (key.parent === parent && !found.includes(key) && key.accessKeyId !== id) { found.push(key); visit(key.accessKeyId); }
  });
  visit(id);
  return found;
}

export function AccessKeys() {
  const { auth } = useAuth();
  const workspace = useWorkspace();
  const keys = useLoad(auth.api.keys.list);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AccessKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const all = keys.data?.keys || [];
  const orgs = workspace.orgs;
  const drives = new Map(orgs.flatMap((org) => org.drives).map((drive) => [drive.id, drive]));
  const several = orgs.length > 1;
  function reach(key: AccessKey) {
    const org = orgs.find((item) => item.id === key.workspaceId);
    const where = several && org ? ` in ${org.name}` : "";
    if (key.drives === null) return `All drives${where}, including new ones`;
    const names = key.drives.map((id) => drives.get(id)?.name).filter((name): name is string => Boolean(name));
    const missing = key.drives.length - names.length;
    return [...names, ...(missing ? [`${missing} drive${missing === 1 ? "" : "s"} you can no longer open`] : [])].join(", ") + where;
  }
  async function revoke(key: AccessKey) {
    setBusy(true); setError(undefined);
    try { await auth.api.keys.revoke(key.accessKeyId); setRevoking(null); keys.reload(); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  const canCreate = workspace.loaded && orgs.length > 0;
  const newKey = <Button variant="default" disabled={!canCreate} onClick={() => setCreating(true)}><Plus aria-hidden="true" />New key</Button>;
  const lost = revoking ? descendants(all, revoking.accessKeyId).filter((key) => !key.revokedAt) : [];
  return <>
    <PageHeader title="Access keys" description="Let agents, scripts and S3 tools such as the AWS CLI or rclone use your drives." action={all.length > 0 ? newKey : undefined} />
    <ErrorNotice error={keys.error || workspace.error} />
    {Boolean(keys.error || workspace.error) && <Button onClick={() => { keys.reload(); workspace.reload(); }}>Try again</Button>}
    {keys.loading && <Loading>Loading access keys…</Loading>}
    {keys.data && all.length === 0 && <section className="st-card st-empty" aria-label="Access keys">
      <KeyRound aria-hidden="true" />
      <h2>No access keys yet</h2>
      <p>A key lets one tool reach the drives you pick, and you can revoke it at any time. Keys you create are listed here.</p>
      {newKey}
      {workspace.loaded && orgs.length === 0 && <p className="st-help">Create a drive first; a key needs a workspace to belong to.</p>}
    </section>}
    {all.length > 0 && <section className="st-card" aria-label="Access keys"><div className="st-scroll" style={{ marginTop: 0 }}>
      <table className="st-table st-stack">
        <thead><tr><th scope="col">Name</th><th scope="col">Can reach</th><th scope="col">Access</th><th scope="col" className="optional">Created</th><th scope="col" className="optional">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{ordered(all).map(({ key, depth }) => {
          const parent = key.parent ? all.find((item) => item.accessKeyId === key.parent) : undefined;
          return <tr key={key.accessKeyId} className={`${depth ? "st-child-key" : ""} ${key.revokedAt ? "st-revoked" : ""}`}>
            <td><div className="st-primary-cell" style={depth > 1 ? { marginLeft: (depth - 1) * 16 } : undefined}>
              <strong>{keyName(key)}</strong>
              <span className="st-mono">{key.accessKeyId}</span>
              {key.parent && <span>Made from {parent ? keyName(parent) : "another key"}</span>}
            </div></td>
            <td>{reach(key)}</td>
            <td><span className="st-badge">{ACCESS[key.access]?.label ?? key.access}</span></td>
            <td className="optional">{formatDay(key.createdAt)}</td>
            <td className="optional">{key.lastUsedAt === null ? "Never" : formatAgo(key.lastUsedAt)}</td>
            <td>{key.revokedAt
              ? <span className="st-badge">Revoked {formatDay(key.revokedAt)}</span>
              : <Button variant="ghost" size="sm" className="text-destructive" aria-label={`Revoke ${keyName(key)}`} onClick={() => { setError(undefined); setRevoking(key); }}>Revoke</Button>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div></section>}
    {creating && <NewKeyDialog orgs={orgs} current={workspace.current} onClose={() => setCreating(false)} onCreated={keys.reload} />}
    {revoking && <Modal title={`Revoke “${keyName(revoking)}”?`} onClose={() => { if (!busy) setRevoking(null); }}>
      <div className="st-dialog">
        <p>Anything using this key loses access right away. A revoked key can't be turned back on; create a new one if you need access again.</p>
        {lost.length > 0 && <p>{lost.length === 1 ? "1 key" : `${lost.length} keys`} made from it will be revoked too: {lost.map(keyName).join(", ")}.</p>}
        <ErrorNotice error={error} />
        <div className="st-actions end">
          <Button disabled={busy} onClick={() => setRevoking(null)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void revoke(revoking)}>{busy ? "Revoking…" : "Revoke key"}</Button>
        </div>
      </div>
    </Modal>}
  </>;
}

function NewKeyDialog({ orgs, current, onClose, onCreated }: { orgs: Org[]; current: Org | null; onClose: () => void; onCreated: () => void }) {
  const { auth } = useAuth();
  const initialOrg = current ?? orgs[0];
  const onlyReadyDrive = (org?: Org) => {
    const ready = org?.drives.filter((drive) => drive.status === "ready") ?? [];
    return ready.length === 1 ? [ready[0].id] : [];
  };
  const [orgId, setOrgId] = useState(initialOrg?.id ?? "");
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [scope, setScope] = useState<"all" | "some">("some");
  const [picked, setPicked] = useState<string[]>(() => onlyReadyDrive(initialOrg));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [secret, setSecret] = useState<KeySecret | null>(null);
  const org = orgs.find((item) => item.id === orgId);
  const ready = org?.drives.filter((drive) => drive.status === "ready") ?? [];
  const levels = allowedAccess(org?.role);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!org || !label.trim() || (scope === "some" && !picked.length)) return;
    setBusy(true); setError(undefined);
    try {
      setSecret(await auth.api.keys.create({ workspaceId: org.id, label: label.trim(), access, drives: scope === "all" ? null : picked }));
      onCreated();
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  if (secret) return <SecretDialog secret={secret} drives={ready} onClose={onClose} />;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New access key</DialogTitle>
        <DialogDescription>{orgs.length > 1 ? "The key works in one workspace." : org ? `The key works in ${org.name}.` : "The key works in one workspace."} You'll see its secret once, right after creating it.</DialogDescription>
      </DialogHeader>
      <form className="st-form st-dialog" onSubmit={create}>
        {orgs.length > 1 && <div className="st-field">
          <label htmlFor="key-org">Workspace</label>
          <NativeSelect id="key-org" value={orgId} disabled={busy} onChange={(event) => {
            const id = event.target.value;
            setOrgId(id); setScope("some"); setPicked(onlyReadyDrive(orgs.find((item) => item.id === id))); setAccess("read");
          }}>
            {orgs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </NativeSelect>
        </div>}
        <div className="st-field">
          <label htmlFor="key-label">Name</label>
          <Input id="key-label" required maxLength={100} autoFocus value={label} disabled={busy} placeholder="Laptop backup, reporting agent…" onChange={(event) => setLabel(event.target.value)} />
          <p className="st-help">Name it after the tool that will use it, so you know what to revoke later.</p>
        </div>
        <fieldset className="st-fieldset" disabled={busy}>
          <legend>Access</legend>
          <div className="st-choices">{levels.map((value) => <label className="st-choice" key={value}>
            <input type="radio" name="key-access" value={value} checked={access === value} onChange={() => setAccess(value)} />
            <span><strong>{ACCESS[value].label}</strong><small>{ACCESS[value].hint}</small></span>
          </label>)}</div>
          {levels.length < 3 && <p className="st-help">Your role in this workspace allows {levels.length === 1 ? "read-only keys" : "keys up to read and write"}.</p>}
        </fieldset>
        <fieldset className="st-fieldset" disabled={busy}>
          <legend>Drives</legend>
          <div className="st-choices">
            <label className="st-choice"><input type="radio" name="key-scope" checked={scope === "some"} onChange={() => setScope("some")} /><span><strong>Only selected drives</strong><small>Pick which ones below.</small></span></label>
            <label className="st-choice"><input type="radio" name="key-scope" checked={scope === "all"} onChange={() => setScope("all")} /><span><strong>All drives</strong><small>Including drives added later.</small></span></label>
          </div>
          {scope === "some" && (ready.length
            ? <div className="st-checks" role="group" aria-label="Drives this key can reach">{ready.map((drive) => <label className="st-check" key={drive.id}>
              <input type="checkbox" checked={picked.includes(drive.id)} onChange={(event) => setPicked(event.target.checked ? [...picked, drive.id] : picked.filter((id) => id !== drive.id))} />{drive.name}
            </label>)}</div>
            : <p className="st-help">This workspace has no drives yet.</p>)}
        </fieldset>
        <ErrorNotice error={error} />
        <div className="st-actions end">
          <Button type="button" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="default" disabled={busy || !org || !label.trim() || (scope === "some" && !picked.length)}>{busy ? "Creating…" : "Create key"}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

/** Shown once, straight after creation; it only closes through its own button so the secret is not lost by a stray click. */
function SecretDialog({ secret, drives, onClose }: { secret: KeySecret; drives: Drive[]; onClose: () => void }) {
  const [kind, setKind] = useState<SnippetKind>("env");
  const [error, setError] = useState<unknown>();
  const endpoint = s3Endpoint();
  const reachable = secret.drives === null ? drives : drives.filter((drive) => secret.drives!.includes(drive.id));
  const first = reachable[0];
  const text = snippet(kind, { ...secret, endpoint, bucket: first ? bucketName(first) : null });
  return <Dialog open>
    <DialogContent showCloseButton={false} className="sm:max-w-xl" onEscapeKeyDown={(event) => event.preventDefault()} onInteractOutside={(event) => event.preventDefault()}>
      <DialogHeader>
        <DialogTitle>Save your secret now</DialogTitle>
        <DialogDescription>This is the only time Orbit shows it. If you lose it, revoke “{keyName(secret)}” and create a new key.</DialogDescription>
      </DialogHeader>
      <div className="st-dialog">
        <dl className="st-secret">
          <div><dt>Access key ID</dt><dd className="st-mono">{secret.accessKeyId}</dd><CopyButton value={secret.accessKeyId} label="Copy access key ID" onError={setError} /></div>
          <div><dt>Secret access key</dt><dd className="st-mono">{secret.secretAccessKey}</dd><CopyButton value={secret.secretAccessKey} label="Copy secret access key" onError={setError} /></div>
          {endpoint && <div><dt>S3 endpoint · region {S3_REGION}</dt><dd className="st-mono">{endpoint}</dd><CopyButton value={endpoint} label="Copy S3 endpoint" onError={setError} /></div>}
        </dl>
        <div>
          <div className="st-tabs" role="tablist" aria-label="Ready-to-paste setup">
            {(Object.keys(SNIPPET_LABELS) as SnippetKind[]).map((value) => <button key={value} type="button" role="tab" id={`snippet-tab-${value}`} aria-selected={kind === value} aria-controls="snippet-panel" onClick={() => setKind(value)}>{SNIPPET_LABELS[value]}</button>)}
          </div>
          <div className="st-snippet" role="tabpanel" id="snippet-panel" aria-labelledby={`snippet-tab-${kind}`} style={{ marginTop: 12 }}>
            <pre data-testid="snippet">{text}</pre>
            <CopyButton value={text} label={`Copy ${SNIPPET_LABELS[kind]}`} onError={setError} />
          </div>
        </div>
        <p className="st-help">
          Each drive is a bucket. {first
            ? <>{reachable.slice(0, 4).map((drive, index) => <span key={drive.id}>{index > 0 && ", "}{drive.name} is <code className="st-mono">{bucketName(drive)}</code></span>)}{reachable.length > 4 && `, and ${reachable.length - 4} more`}.</>
            : <>Replace <code className="st-mono">{BUCKET_PLACEHOLDER}</code> with the drive's bucket name.</>}
          {!endpoint && " This build does not know the S3 endpoint; replace the placeholder with the address your Orbit administrator gives you."}
        </p>
        <ErrorNotice error={error} />
        <div className="st-actions end"><Button variant="default" onClick={onClose}>I've saved it</Button></div>
      </div>
    </DialogContent>
  </Dialog>;
}
