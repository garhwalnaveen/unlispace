import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/ui/table";
import { NativeSelect } from "./components/ui/native-select";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./context";
import { ErrorNotice, Loading, Modal, formatDate, useLoad } from "./ui";
import type { Member, Role } from "./teams";
import { UserPlus } from "lucide-react";
import { Card } from "./onboarding/Card";
import { useWorkspace } from "./shell/workspace";

export function TeamPage() {
  const { id = "" } = useParams();
  const { auth, user } = useAuth();
  const api = auth.api.teams;
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
    <header className="page-heading"><div><h1>Team</h1><p className="muted">{data?.name || "Manage who can use this workspace and its drives."}</p></div><Link to="/">Back to drives</Link></header>
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
      {data.invitations.length > 0 && <section className="panel"><h2>Pending invitations</h2><ul className="invitation-list">{data.invitations.map(invite => <li key={invite.id}><div><strong>{invite.email}</strong><p className="muted small">{invite.role} · expires {formatDate(invite.expiresAt)}</p></div> { (data.role === "owner" || invite.role !== "admin") && <Button disabled={busy} onClick={() => void run(() => api.revoke(id, invite.id), "Invitation revoked.")}>Revoke</Button>}</li>)}</ul></section>}
    </>}
    {removing && <Modal title="Remove member?" onClose={() => { if (!busy) setRemoving(null); }}><p>{removing.email} will lose access to this workspace. Previously issued drive credentials may remain valid for up to 15 minutes. Existing files remain in the workspace.</p><ErrorNotice error={actionError} /><div className="actions"><Button disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void run(() => api.remove(id, removing.userId), "Member removed.", removing.userId === user?.id)}>Remove member</Button></div></Modal>}
  </>;
}

export function AcceptInvitation() {
  const { token = "" } = useParams();
  const { auth, user } = useAuth();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"joining" | "leaving" | null>(null);
  const [error, setError] = useState<unknown>();
  // Files are home: once the joined workspace is in the list, open it.
  const [joined, setJoined] = useState<string | null>(null);
  const reloading = useRef(false);
  useEffect(() => {
    if (!joined) return;
    if (workspace.loading) reloading.current = true;
    if (workspace.orgs.some((org) => org.id === joined) || (reloading.current && !workspace.loading)) navigate("/", { replace: true });
  }, [joined, workspace.orgs, workspace.loading, navigate]);
  async function accept() {
    setBusy("joining");
    setError(undefined);
    try {
      const { orgId } = await auth.api.teams.accept(token);
      workspace.setCurrent(orgId);
      workspace.reload();
      setJoined(orgId);
    } catch (reason) {
      setError(reason);
      setBusy(null);
    }
  }
  // Signing out returns here after sign-in, because this page is the saved destination.
  async function switchAccount() {
    setBusy("leaving");
    setError(undefined);
    try { await auth.logout(); }
    catch (reason) { setError(reason); setBusy(null); }
  }
  return (
    <div className="ob-page">
    <Card icon={<UserPlus />} title="Join a workspace" lead={<>You are signed in as <strong>{user?.email}</strong>. Accept if this is the address the invitation was sent to.</>}>
      <p className="ob-muted">People in the workspace will see your email address. Files you add to its drives belong to the workspace.</p>
      <ErrorNotice error={error} />
      <Button variant="default" className="ob-main" disabled={busy !== null} onClick={() => void accept()}>{busy === "joining" ? "Joining…" : "Accept invitation"}</Button>
      <div className="ob-row ob-center">
        <Link className="ob-link" to="/">Not now</Link>
        <button type="button" className="ob-link" disabled={busy !== null} onClick={() => void switchAccount()}>{busy === "leaving" ? "Signing out…" : "Use a different account"}</button>
      </div>
    </Card>
    </div>
  );
}
