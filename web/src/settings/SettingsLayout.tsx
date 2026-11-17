import { NavLink, Outlet } from "react-router-dom";
import { useWorkspace } from "../shell/workspace";

/** One place for everything that is not files: account, access keys, members and billing. */
export function SettingsLayout() {
  const { current } = useWorkspace();
  const org = current ? `/orgs/${encodeURIComponent(current.id)}` : null;
  return (
    <div className="settings-area">
      <nav className="settings-nav" aria-label="Settings">
        <p className="side-label">You</p>
        <NavLink to="/settings" end>Account</NavLink>
        <NavLink to="/settings/access-keys">Access keys</NavLink>
        {org && <>
          <p className="side-label" title={current!.name}>{current!.name}</p>
          <NavLink to={`${org}/team`}>Members</NavLink>
          <NavLink to={`${org}/billing`}>Plan and billing</NavLink>
        </>}
      </nav>
      <div className="settings-content"><Outlet /></div>
    </div>
  );
}
