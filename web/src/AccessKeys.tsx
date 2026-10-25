import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./context";
import { m2, type AccessKey, type KeySecret } from "./m2";
import { ErrorNotice, formatDate, Loading, useLoad } from "./ui";

export function AccessKeys() {
  const { auth } = useAuth();
  const api = useMemo(() => m2(auth.api), [auth]);
  const keys = useLoad(api.keys);
  const orgs = useLoad(auth.api.orgs);
  const [orgId, setOrgId] = useState("");
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<AccessKey["access"]>("read");
  const [allDrives, setAllDrives] = useState(false);
  const [drives, setDrives] = useState<string[]>([]);
  const [secret, setSecret] = useState<KeySecret | null>(null);
  const [revoke, setRevoke] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const org = orgs.data?.orgs.find((item) => item.id === orgId);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!org || (!allDrives && !drives.length) || secret) return;
    setBusy(true); setError(undefined);
    try {
      setSecret(await api.createKey({ workspaceId: orgId, label: label.trim(), access, drives: allDrives ? null : drives }));
      setCopied(false); setLabel(""); keys.reload();
    } catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true); setError(undefined);
    try { await api.revokeKey(id); setRevoke(null); keys.reload(); }
    catch (reason) { setError(reason); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!secret) return;
    try {
      // POSIX quoting also makes a malformed server value inert when pasted in a shell.
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      await navigator.clipboard.writeText(`export AWS_ACCESS_KEY_ID=${quote(secret.accessKeyId)}\nexport AWS_SECRET_ACCESS_KEY=${quote(secret.secretAccessKey)}`);
      setCopied(true);
    } catch { setError(new Error("Could not copy. Select the credentials below and copy them manually.")); }
  }
  const allKeys = keys.data?.keys || [];
  function renderKeys(parent: string | null, ancestors: string[] = []) {
    const children = allKeys.filter((key) => !ancestors.includes(key.accessKeyId) && (parent === null ? !key.parent || !allKeys.some((item) => item.accessKeyId === key.parent) : key.parent === parent));
    return <ul className="key-list">{children.map((key) => <li key={key.accessKeyId}>
      <h3>{key.label || "Untitled key"}</h3><code>{key.accessKeyId}</code>
      {key.parent && <p className="muted small">Child of <code>{key.parent}</code></p>}
      <p className="muted small">{key.access} · {key.drives === null ? "All accessible drives" : `${key.drives.length} selected drive(s)`}<br />Last used: {key.lastUsedAt === null ? "Never" : formatDate(key.lastUsedAt)}</p>
      {key.revokedAt ? <p>Revoked {formatDate(key.revokedAt)}</p> : revoke === key.accessKeyId ? <div><p>Revoke this key and all its descendants (child keys and their children)? Tools using them will lose access.</p><div className="actions"><button className="danger" disabled={busy} onClick={() => void remove(key.accessKeyId)}>Confirm revoke</button><button disabled={busy} onClick={() => setRevoke(null)}>Cancel</button></div></div> : <button disabled={busy} onClick={() => setRevoke(key.accessKeyId)}>Revoke {key.label || key.accessKeyId}</button>}
      {allKeys.some((child) => child.parent === key.accessKeyId && ![...ancestors, key.accessKeyId].includes(child.accessKeyId)) && renderKeys(key.accessKeyId, [...ancestors, key.accessKeyId])}
    </li>)}</ul>;
  }
  return <>
    <header className="page-heading"><div><Link to="/settings">Account</Link><h1>Access keys</h1><p className="muted">Connect S3 tools to the drives you choose.</p></div></header>
    <ErrorNotice error={error || keys.error || orgs.error} />
    {(keys.error || orgs.error) ? <button onClick={() => { keys.reload(); orgs.reload(); }}>Try again</button> : null}
    {secret && <section className="panel secret-reveal" aria-labelledby="secret-title">
      <h2 id="secret-title">Save your secret now</h2><p>This is the only time this secret is shown. Store it somewhere safe before closing.</p>
      <dl><dt>Access key ID</dt><dd><code>{secret.accessKeyId}</code></dd><dt>Secret access key</dt><dd><code>{secret.secretAccessKey}</code></dd></dl>
      <div className="actions"><button className="primary" onClick={() => void copy()}>Copy as env vars</button><button onClick={() => { setSecret(null); setCopied(false); }}>I saved it — close</button></div>
      {copied && <p role="status">Environment variables copied.</p>}
    </section>}
    <div className="settings-layout">
      <section className="panel" aria-labelledby="new-key-title"><h2 id="new-key-title">New access key</h2>
        {orgs.loading ? <Loading /> : <form className="stack" onSubmit={create}>
          <label htmlFor="key-org">Organization</label><select id="key-org" value={orgId} required disabled={busy || Boolean(secret)} onChange={(event) => { setOrgId(event.target.value); setDrives([]); setAllDrives(false); setAccess("read"); }}>
            <option value="">Choose an organization</option>{orgs.data?.orgs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <label htmlFor="key-label">Label</label><input id="key-label" required maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} disabled={busy || Boolean(secret)} placeholder="For example, laptop backup" />
          <label htmlFor="key-access">Access level</label><select id="key-access" value={access} disabled={busy || Boolean(secret)} onChange={(event) => setAccess(event.target.value as AccessKey["access"])}>
            <option value="read">Read</option>{org?.role !== "viewer" && <option value="write">Read and write</option>}{(org?.role === "owner" || org?.role === "admin") && <option value="admin">Admin</option>}
          </select>
          <fieldset disabled={busy || Boolean(secret) || !org}><legend>Drive allowlist</legend>
            <label className="check-row"><input type="checkbox" checked={allDrives} onChange={(event) => setAllDrives(event.target.checked)} />All accessible drives, including future drives</label>
            {!allDrives && org?.drives.filter((drive) => drive.status === "ready").map((drive) => <label className="check-row" key={drive.id}><input type="checkbox" checked={drives.includes(drive.id)} onChange={(event) => setDrives(event.target.checked ? [...drives, drive.id] : drives.filter((id) => id !== drive.id))} />{drive.name}</label>)}
            {!allDrives && <p className="muted small">Select at least one drive.</p>}
          </fieldset>
          <button className="primary" disabled={busy || Boolean(secret) || !org || !label.trim() || (!allDrives && !drives.length)}>{busy ? "Saving…" : "Create access key"}</button>
        </form>}
      </section>
      <section aria-labelledby="existing-keys-title"><h2 id="existing-keys-title">Your keys</h2>{keys.loading && <Loading />}
        {!keys.loading && keys.data?.keys.length === 0 && <p className="muted">No access keys yet.</p>}
        {renderKeys(null)}
      </section>
    </div>
  </>;
}
