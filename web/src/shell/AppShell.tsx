import { Check, ChevronsUpDown, HardDrive, LogOut, Menu, MoreHorizontal, Plus, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { Drive } from "../api";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useAuth } from "../context";
import { DriveDialog, type DriveAction } from "../DriveTools";
import { driveLink, finderLink } from "../links";
import { Checklist } from "../onboarding/Checklist";
import { OrbitMark } from "../OrbitMark";
import { ErrorNotice, formatBytes, Icon } from "../ui";
import { THEMES, type Theme } from "./theme";
import { rememberDrive, useWorkspace } from "./workspace";
import "./shell.css";

const DAY = 86_400_000;

function StorageMeter() {
  const { current, access } = useWorkspace();
  if (!current || !access || !access.quotaBytes) return null;
  const ratio = Math.min(1, access.usedBytes / access.quotaBytes);
  return (
    <Link className="storage-meter" to={`/orgs/${encodeURIComponent(current.id)}/billing`} aria-label="Storage">
      <span className="storage-bar" aria-hidden="true"><span style={{ width: `${Math.max(ratio * 100, 1)}%` }} data-full={ratio > 0.9 || undefined} /></span>
      <span>{formatBytes(access.usedBytes)} of {formatBytes(access.quotaBytes)} used</span>
    </Link>
  );
}

function PlanNotice() {
  const { current, access } = useWorkspace();
  if (!current) return null;
  const billing = `/orgs/${encodeURIComponent(current.id)}/billing`;
  const state = access?.state;
  const trialEndsAt = access ? access.trialEndsAt : current.trialEndsAt;
  if (state === "expired") return <Link className="plan-notice warn" to={billing}><strong>Trial ended</strong>Files are read-only. Choose a plan to keep uploading.</Link>;
  if (state === "paid" || trialEndsAt === null) return null;
  const days = Math.max(0, Math.ceil((trialEndsAt - Date.now()) / DAY));
  return <Link className="plan-notice" to={billing}><strong>{days > 0 ? `${days} trial day${days === 1 ? "" : "s"} left` : "Trial ended"}</strong>Choose a plan</Link>;
}

function DriveItem({ drive, onAction }: { drive: Drive; onAction: (action: DriveAction) => void }) {
  const { canManage } = useWorkspace();
  const location = useLocation();
  const base = driveLink(drive.id);
  const active = location.pathname === base.slice(0, -1) || location.pathname.startsWith(base);
  if (drive.status !== "ready")
    return <div className="side-item side-item-disabled" title="This drive could not be set up yet."><HardDrive aria-hidden="true" /><span>{drive.name}</span><span className="side-badge">Setting up</span></div>;
  return (
    <div className={`side-item-row${active ? " active" : ""}`}>
      <Link className="side-item" to={base} aria-current={active ? "page" : undefined}><HardDrive aria-hidden="true" /><span>{drive.name}</span></Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><button className="side-more" aria-label={`Options for ${drive.name}`}><MoreHorizontal aria-hidden="true" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem asChild><a href={finderLink(drive.id, "")}>Open in Finder</a></DropdownMenuItem>
          {canManage && <>
            <DropdownMenuItem onSelect={() => onAction({ kind: "rename", drive })}>Rename…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction({ kind: "fork", drive })}>Make a copy (fork)…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onAction({ kind: "delete", drive })}>Delete drive…</DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function AppShell({ children, theme, setTheme }: { children: ReactNode; theme: Theme; setTheme: (theme: Theme) => void }) {
  const { auth, user } = useAuth();
  const workspace = useWorkspace();
  const { orgs, current, drives, canManage } = workspace;
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<DriveAction | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<unknown>();
  useEffect(() => setOpen(false), [location.pathname]);
  // Opening a drive or a workspace page makes its workspace the current one.
  const driveId = location.pathname.match(/^\/drives\/([^/]+)/)?.[1];
  const routeOrg = location.pathname.match(/^\/orgs\/([^/]+)/)?.[1];
  useEffect(() => {
    const id = driveId ? decodeURIComponent(driveId) : null;
    const owner = id ? orgs.find((org) => org.drives.some((drive) => drive.id === id)) : orgs.find((org) => org.id === (routeOrg && decodeURIComponent(routeOrg)));
    if (id && owner) rememberDrive(id);
    if (owner && owner.id !== current?.id) workspace.setCurrent(owner.id);
  }, [driveId, routeOrg, orgs]); // eslint-disable-line react-hooks/exhaustive-deps
  async function signOut() {
    setSigningOut(true);
    setSignOutError(undefined);
    try { await auth.logout(); }
    catch (reason) { setSignOutError(reason); }
    finally { setSigningOut(false); }
  }
  const settingsActive = /^\/(settings|orgs\/|billing$|team$)/.test(location.pathname);
  return (
    <div className="shell" data-open={open || undefined}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="shell-bar">
        <Button variant="ghost" size="icon" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? <X /> : <Menu />}</Button>
        <Link className="brand" to="/" aria-label="Orbit home"><OrbitMark className="brand-mark" /><span>Orbit</span></Link>
      </header>
      <div className="shell-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <aside className="sidebar">
        <div className="sidebar-head">
          <Link className="brand" to="/" aria-label="Orbit home"><OrbitMark className="brand-mark" /></Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="workspace-switch" aria-label="Switch workspace"><span>{current?.name ?? "Orbit"}</span><ChevronsUpDown aria-hidden="true" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {orgs.map((org) => (
                <DropdownMenuItem key={org.id} onSelect={() => { workspace.setCurrent(org.id); navigate("/"); }}>
                  <span className="truncate">{org.name}</span>{org.id === current?.id && <Check className="ml-auto" aria-label="Current" />}
                </DropdownMenuItem>
              ))}
              {current && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild><Link to={`/orgs/${encodeURIComponent(current.id)}/team`}>Members</Link></DropdownMenuItem>
                <DropdownMenuItem asChild><Link to={`/orgs/${encodeURIComponent(current.id)}/billing`}>Plan and billing</Link></DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <nav className="side-nav" aria-label="Main navigation">
          <div className="side-label"><span>Drives</span>
            {canManage && current && <button className="side-more" aria-label="New drive" title="New drive" onClick={() => setAction({ kind: "create", org: current })}><Plus aria-hidden="true" /></button>}
          </div>
          {drives.map((drive) => <DriveItem key={drive.id} drive={drive} onAction={setAction} />)}
          {workspace.loaded && !drives.length && <p className="side-empty">{canManage ? "No drives yet." : "No drives shared with you yet."}</p>}
          {!workspace.loaded && workspace.loading && <div className="side-skeleton" aria-hidden="true"><span /><span /></div>}
          <div className="side-gap" />
          <NavLink className="side-item" to="/ai"><Sparkles aria-hidden="true" /><span>Ask AI</span></NavLink>
          <Link className="side-item" to="/settings" aria-current={settingsActive ? "page" : undefined}><SettingsIcon aria-hidden="true" /><span>Settings</span></Link>
        </nav>
        <div className="sidebar-foot">
          <Checklist />
          <PlanNotice />
          <StorageMeter />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="account-switch" aria-label="Account menu"><span className="avatar" aria-hidden="true">{user?.email[0]?.toUpperCase()}</span><span className="truncate">{user?.email}</span><ChevronsUpDown aria-hidden="true" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-56">
              <DropdownMenuItem asChild><Link to="/settings">Account settings</Link></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Appearance</DropdownMenuLabel>
              {THEMES.map((value) => (
                <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
                  <Icon name={value === "system" ? "monitor" : value === "light" ? "sun" : "moon"} />{value[0].toUpperCase() + value.slice(1)}{theme === value && <Check className="ml-auto" aria-label="Selected" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={signingOut} onSelect={() => void signOut()}><LogOut aria-hidden="true" />{signingOut ? "Signing out…" : "Sign out"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <main id="main" className="shell-main" tabIndex={-1}>
        <ErrorNotice error={signOutError} />
        {children}
      </main>
      {action && (
        <DriveDialog action={action} api={auth.api} onClose={() => setAction(null)} onDone={(created) => {
          const deleted = action.kind === "delete" || action.kind === "hard-delete" ? action.drive.id : null;
          setAction(null);
          workspace.reload();
          if (created) navigate(driveLink(created.id));
          else if (deleted && deleted === (driveId && decodeURIComponent(driveId))) navigate("/");
        }} />
      )}
    </div>
  );
}
