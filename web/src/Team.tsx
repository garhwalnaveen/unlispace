import { NativeSelect } from "./components/ui/native-select";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { ChevronDown, MoreHorizontal, Users } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { errorMessage } from "./api";
import { useAuth } from "./context";
import { formatDay, PageHeader, Section } from "./settings/parts";
import { ErrorNotice, Loading, Modal, useLoad } from "./ui";
import type { Invitation, Member, Role } from "./teams";

/** One sentence per role, in order of increasing access. */
const ROLE_HELP: Record<Role, string> = {
  viewer: "Can open and download files.",
  member: "Can also add, change and delete files.",
  admin: "Can also manage drives, billing, members and viewers.",
  owner: "Can also add or remove admins and owners.",
};
const ROLE_ORDER: Role[] = ["viewer", "member", "admin", "owner"];
const roleName = (role: Role) => role[0].toUpperCase() + role.slice(1);

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
  const billing = `/orgs/${encodeURIComponent(id)}/billing`;
  async function run(action: () => Promise<unknown>, message: string, leave = false) {
    setBusy(true); setActionError(undefined); setNotice("");
    try {
      await action(); setNotice(message); setRemoving(null);
      if (leave) navigate("/"); else reload();
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }
  function invite(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    void run(() => api.invite(id, address, role).then(() => setEmail("")), `Invitation sent to ${address}. They'll get an email with a link to join.`);
  }
  /** The API has no resend, so a new invitation replaces the old one: the earlier link stops working and a fresh email goes out. */
  function resend(invitation: Invitation) {
    void run(async () => {
      await api.revoke(id, invitation.id);
      try { await api.invite(id, invitation.email, invitation.role); }
      catch (reason) {
        reload();
        throw new Error(`The earlier invitation to ${invitation.email} was cancelled, but a new one could not be sent: ${errorMessage(reason)} Invite them again below.`);
      }
    }, `A new invitation was sent to ${invitation.email}. The earlier link no longer works.`);
  }
  // Owners may set any role; admins manage members and viewers only.
  const assignable: Role[] = data?.role === "owner" ? ROLE_ORDER : ["viewer", "member"];
  const used = data ? data.members.length + data.invitations.length : 0;
  const full = Boolean(data && used >= data.seats);
  const self = removing?.userId === user?.id;
  return <>
    <PageHeader title="Members" description={data ? `People who can use ${data.name} and its drives.` : "People who can use this workspace and its drives."} />
    <ErrorNotice error={(!removing && actionError) || error} />
    {notice && <p className="notice" role="status">{notice}</p>}
    {loading && <Loading>Loading members…</Loading>}
    {Boolean(error) && <Button onClick={reload}>Try again</Button>}
    {data && <>
      {data.canManage && !data.teamAvailable && <div className="st-callout">
        <Users aria-hidden="true" />
        <div>
          <strong>Inviting people needs an active Teams plan</strong>
          <p>Nothing changes for the people already here. Switch to Teams to add teammates and choose how many seats you need.</p>
          <div className="st-actions"><Button asChild variant="default"><Link to={billing}>See plans</Link></Button></div>
        </div>
      </div>}
      <Section title="People" labelledBy="team-people"
        description={<>{data.members.length} of {data.seats} seat{data.seats === 1 ? "" : "s"} used{data.invitations.length > 0 ? `, ${data.invitations.length} held for pending invitation${data.invitations.length === 1 ? "" : "s"}` : ""}.</>}>
        {data.canManage && data.teamAvailable && <div className="st-card-body" style={{ paddingBottom: 0 }}>
          {full
            ? <p className="st-help">Every seat is taken. <Link to={billing}>Add a seat in Plan and billing</Link> to invite someone else.</p>
            : <form onSubmit={invite}>
              <div className="st-invite">
                <div className="st-field"><label htmlFor="invite-email">Invite by email</label><Input id="invite-email" type="email" required placeholder="name@example.com" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></div>
                <div className="st-field"><label htmlFor="invite-role">Role</label><NativeSelect id="invite-role" value={role} disabled={busy} onChange={(event) => setRole(event.target.value as Role)}>
                  {assignable.filter((value) => value !== "owner").map((value) => <option key={value} value={value}>{roleName(value)}</option>)}
                </NativeSelect></div>
                <Button variant="default" disabled={busy || !email.trim()}>{busy ? "Working…" : "Send invitation"}</Button>
              </div>
              <p className="st-help" style={{ marginTop: 8 }}>They get an email with a link that works for 7 days, and must sign in with this address. The invitation holds a seat until then.</p>
            </form>}
        </div>}
        <div className="st-scroll"><table className="st-table">
          <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{data.members.map((member) => {
            const you = member.userId === user?.id;
            const allowed = data.canManage && (data.role === "owner" || !["owner", "admin"].includes(member.role));
            return <tr key={member.userId}>
              <td><div className="st-person">
                <span className="st-avatar" aria-hidden="true">{(member.displayName || member.email)[0]}</span>
                <div className="st-primary-cell"><strong>{member.displayName || member.email}{you && <span className="st-badge" style={{ display: "inline-flex", marginLeft: 8 }}>You</span>}</strong>{member.displayName && <span>{member.email}</span>}</div>
              </div></td>
              <td>{allowed ? <DropdownMenu>
                <DropdownMenuTrigger asChild><button className="st-role-trigger" disabled={busy} aria-label={`Role for ${member.email}: ${roleName(member.role)}`}>{member.role}<ChevronDown aria-hidden="true" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup value={member.role} onValueChange={(value) => { if (value !== member.role) void run(() => api.change(id, member.userId, value as Role), `${member.displayName || member.email} is now ${value === "owner" || value === "admin" ? "an" : "a"} ${value}.`); }}>
                    {assignable.map((value) => <DropdownMenuRadioItem key={value} value={value}><span className="st-role-item"><strong>{value}</strong><small>{ROLE_HELP[value]}</small></span></DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu> : roleName(member.role)}</td>
              <td>{allowed && <DropdownMenu>
                <DropdownMenuTrigger asChild><button className="st-icon-button" disabled={busy} aria-label={`Options for ${member.email}`}><MoreHorizontal aria-hidden="true" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onSelect={() => { setActionError(undefined); setRemoving(member); }}>{you ? "Leave workspace…" : "Remove from workspace…"}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </Section>
      {data.invitations.length > 0 && <Section title="Pending invitations" description="Not joined yet. Each one holds a seat until it is accepted, revoked or expires." labelledBy="team-pending">
        <ul className="st-list">{data.invitations.map((invitation) => {
          const allowed = data.role === "owner" || invitation.role !== "admin";
          return <li key={invitation.id}>
            <div className="st-primary-cell"><strong>{invitation.email}</strong><span>{roleName(invitation.role)} · link expires {formatDay(invitation.expiresAt)}</span></div>
            {allowed && <div className="st-actions">
              {data.teamAvailable && <Button size="sm" disabled={busy} aria-label={`Send again to ${invitation.email}`} onClick={() => resend(invitation)}>Send again</Button>}
              <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} aria-label={`Revoke invitation for ${invitation.email}`} onClick={() => void run(() => api.revoke(id, invitation.id), `Invitation for ${invitation.email} revoked. The link no longer works.`)}>Revoke</Button>
            </div>}
          </li>;
        })}</ul>
      </Section>}
      <Section title="What each role can do" labelledBy="team-roles">
        <div className="st-card-body"><dl className="st-roles">{ROLE_ORDER.map((value) => <div key={value} style={{ display: "contents" }}><dt>{roleName(value)}</dt><dd>{ROLE_HELP[value]}</dd></div>)}</dl></div>
      </Section>
    </>}
    {removing && <Modal title={self ? "Leave this workspace?" : `Remove ${removing.displayName || removing.email}?`} onClose={() => { if (!busy) setRemoving(null); }}>
      <div className="st-dialog">
        <p>{self ? "You lose" : `${removing.email} loses`} access to {data?.name || "this workspace"} and its drives. Apps that are already connected can keep working for up to 15 minutes. Files stay in the workspace.</p>
        <ErrorNotice error={actionError} />
        <div className="st-actions end">
          <Button disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void run(() => api.remove(id, removing.userId), "Member removed.", self)}>{busy ? "Removing…" : self ? "Leave workspace" : "Remove member"}</Button>
        </div>
      </div>
    </Modal>}
  </>;
}

export function AcceptInvitation() {
  const { token = "" } = useParams();
  const { auth, user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return <section className="panel"><h1>Join a workspace</h1><p>You are signed in as <strong>{user?.email}</strong>. Accept only if this is the email address that received the invitation.</p><p>Joining gives the workspace access to your email address. Files you add to its drives belong to that workspace.</p><ErrorNotice error={error} /><div className="actions"><Button variant="default" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void auth.api.teams.accept(token).then(result => navigate(`/orgs/${encodeURIComponent(result.orgId)}/team`)).catch(setError).finally(() => setBusy(false)); }}>{busy ? "Joining…" : "Accept invitation"}</Button><Link to="/">Back to drives</Link></div><p className="muted small">If this is the wrong account, <Link to="/settings">sign out in Account</Link> and reopen the invitation.</p></section>;
}
