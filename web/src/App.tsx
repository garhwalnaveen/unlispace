import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Callback, Desktop, Login } from "./AuthPages";
import { useAuth } from "./context";
import { DriveBrowser } from "./DriveBrowser";
import { Home } from "./Home";
import { AccessKeys } from "./AccessKeys";
import { Billing } from "./Billing";
import { Settings } from "./Settings";
import { ErrorNotice, Icon, Loading } from "./ui";
function Protected() {
  const { user } = useAuth();
  const location = useLocation();
  return user ? (
    <Outlet />
  ) : (
    <Navigate
      to={`/login?${new URLSearchParams({ return: location.pathname + location.search })}`}
      replace
    />
  );
}
export function App() {
  const { auth, ready, user, error } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("unlispace.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system"
        ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    localStorage.setItem("unlispace.theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    document.getElementById("main")?.focus();
  }, [location.pathname]);
  return (
    <div className={`app ${user ? "workspace" : "welcome"}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link className="brand" to="/" aria-label="Unlispace home">
          <span className="brand-mark" aria-hidden="true">u</span>
          <span className="brand-name">unlispace</span>
        </Link>
        <div className="topbar-right">
          <div className="theme-switch" role="group" aria-label="Appearance">
            {(["system", "light", "dark"] as const).map((value) => (
              <button
                key={value}
                className="theme-button"
                onClick={() => setTheme(value)}
                aria-label={`Use ${value} theme`}
                aria-pressed={theme === value}
                title={`${value[0].toUpperCase()}${value.slice(1)} theme`}
              >
                <Icon name={value === "system" ? "monitor" : value === "light" ? "sun" : "moon"} />
              </button>
            ))}
          </div>
        </div>
      </header>
      {user && (
        <aside className="sidebar">
          <p className="sidebar-label">WORKSPACE</p>
          <nav aria-label="Main navigation">
            <NavLink to="/" end><Icon name="drive" />Your drives</NavLink>
            <NavLink to="/settings" end><Icon name="user" />Account</NavLink>
            <NavLink to="/settings/access-keys"><Icon name="key" />Access keys</NavLink>
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-tip"><Icon name="monitor" /><strong>At home in Finder.</strong><p>Your cloud files, right alongside everything else.</p></div>
            <Link className="profile-link" to="/settings">
              <span className="profile-avatar" aria-hidden="true">{user.email.charAt(0).toUpperCase()}</span>
              <span><strong>Your account</strong><span>{user.email}</span></span>
              <Icon name="chevron" />
            </Link>
          </div>
        </aside>
      )}
      <main id="main" tabIndex={-1}>
        <ErrorNotice error={error} />
        {Boolean(error) && (
          <button onClick={() => void auth.retry().catch(() => {})}>
            Retry session
          </button>
        )}
        {!ready ? (
          <Loading>Opening your space…</Loading>
        ) : (
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<Callback />} />
            <Route path="/desktop" element={<Desktop />} />
            <Route element={<Protected />}>
              <Route path="/" element={<Home />} />
              <Route path="/drives/:id/*" element={<DriveBrowser />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/access-keys" element={<AccessKeys />} />
              <Route path="/orgs/:id/billing" element={<Billing />} />
            </Route>
            <Route
              path="*"
              element={
                <section className="empty">
                  <h1>This space is empty.</h1>
                  <p>That page could not be found.</p>
                  <Link to="/">Back to drives</Link>
                </section>
              }
            />
          </Routes>
        )}
      </main>
      <footer className="footer">
        <span>Your files. Every version. One space.</span>
        <span>Unlispace</span>
      </footer>
    </div>
  );
}
