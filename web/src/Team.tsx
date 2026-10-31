import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/ui/table";
import { NativeSelect } from "./components/ui/native-select";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./context";
import { ErrorNotice, Loading, Modal, formatDate, useLoad } from "./ui";
import { teams, type Member, type Role } from "./teams";

export function TeamPage() {
  const { id = "" } = useParams();
  const { auth, user } = useAuth();
  const api = useMemo(() => teams(auth.api), [auth.api]);
  const load = useCallback(() => api.members(id), [api, id]);
  const { data, loading, error, reload } = useLoad(load);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const navigate = useNavigate();
  async function run(action: () => Promise<unknown>, message: string, leave = false) {
    setBusy(true); setActionError(undefined); setNotice("");
    try {
      await action(); setNotice(message); setRemoving(null);
      if (leave) navigate("/"); else reload();
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }
  const roles: Role[] = data?.role === "owner" ? ["owner", "admin", "member", "viewer"] : ["member", "viewer"];
  return <>
    <header className="page-heading"><div><h1>{data?.name || "Team"}</h1><p className="muted">Manage who can use this workspace and its drives.</p></div><Link to="/">Back to drives</Link></header>
    <ErrorNotice error={(!removing && actionError) || error} />
    {notice && <p className="notice" role="status">{notice}</p>}
    {loading && <Loading>Loading team…</Loading>}
    {Boolean(error) && <Button onClick={reload}>Try again</Button>}
    {data && <>
      <section className="panel"><h2>Members</h2><p className="muted">{data.members.length} of {data.seats} seats used{data.invitations.length > 0 ? ` · ${data.invitations.length} reserved by pending invitations` : ""}</p>
        <Table><TableHeader><TableRow><TableHead scope="col">Account</TableHead><TableHead scope="col">Role</TableHead><TableHead scope="col">Actions</TableHead></TableRow></TableHeader><TableBody>{data.members.map(member => {
          const allowed = data.canManage && (data.role === "owner" || !["owner", "admin"].includes(member.role));
          return <TableRow key={member.userId}><TableCell>{member.displayName && <strong>{member.displayName}<br /></strong>}{member.email}{member.userId === user?.id && " (you)"}</TableCell><TableCell>{allowed ? <NativeSelect aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={event => void run(() => api.change(id, member.userId, event.target.value as Role), "Role updated.")}>{roles.map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect> : member.role}</TableCell><TableCell>{allowed && <Button disabled={busy} onClick={() => setRemoving(member)}>Remove</Button>}</TableCell></TableRow>;
        })}</TableBody></Table>
      </section>
      {data.canManage && <section className="panel"><h2>Invite a teammate</h2><p className="muted">An invitation reserves one seat for seven days. The recipient must sign in with the invited email.</p>
        {!data.teamAvailable && <p className="notice">An active Teams plan is required to invite members. <Link to={`/orgs/${encodeURIComponent(id)}/billing`}>Manage plan and seats</Link></p>}
        <form className="stack" onSubmit={event => { event.preventDefault(); void run(() => api.invite(id, email.trim(), role).then(result => { setEmail(""); return result; }), "Invitation sent."); }}>
          <label htmlFor="invite-email">Email address</label><Input id="invite-email" type="email" required value={email} disabled={busy || !data.teamAvailable} onChange={event => setEmail(event.target.value)} />
          <label htmlFor="invite-role">Role</label><NativeSelect id="invite-role" value={role} disabled={busy || !data.teamAvailable} onChange={event => setRole(event.target.value as Role)}>{roles.filter(value => value !== "owner").map(value => <option key={value} value={value}>{value}</option>)}</NativeSelect>
          <p className="muted small">Viewers can read; members can write; admins can also manage drives and ordinary members.</p>
          <Button variant="default" disabled={busy || !data.teamAvailable}>{busy ? "Working…" : "Send invitation"}</Button>
        </form>
      </section>}
      {data.invitations.length > 0 && <section className="panel"><h2>Pending invitations</h2><ul>{data.invitations.map(invite => <li key={invite.id}><strong>{invite.email}</strong> · {invite.role} · expires {formatDate(invite.expiresAt)} { (data.role === "owner" || invite.role !== "admin") && <Button disabled={busy} onClick={() => void run(() => api.revoke(id, invite.id), "Invitation revoked.")}>Revoke</Button>}</li>)}</ul></section>}
    </>}
    {removing && <Modal title="Remove member?" onClose={() => { if (!busy) setRemoving(null); }}><p>{removing.email} will lose access to this workspace. Previously issued drive credentials may remain valid for up to 15 minutes. Existing files remain in the workspace.</p><ErrorNotice error={actionError} /><div className="actions"><Button disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void run(() => api.remove(id, removing.userId), "Member removed.", removing.userId === user?.id)}>Remove member</Button></div></Modal>}
  </>;
}

export function AcceptInvitation() {
  const { token = "" } = useParams();
  const { auth, user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return <section className="panel"><h1>Join a workspace</h1><p>You are signed in as <strong>{user?.email}</strong>. Accept only if this is the email address that received the invitation.</p><p>Joining gives the workspace access to your email address. Files you add to its drives belong to that workspace.</p><ErrorNotice error={error} /><div className="actions"><Button variant="default" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void teams(auth.api).accept(token).then(result => navigate(`/orgs/${encodeURIComponent(result.orgId)}/team`)).catch(setError).finally(() => setBusy(false)); }}>{busy ? "Joining…" : "Accept invitation"}</Button><Link to="/">Back to drives</Link></div><p className="muted small">If this is the wrong account, <Link to="/settings">sign out in Account</Link> and reopen the invitation.</p></section>;
}
