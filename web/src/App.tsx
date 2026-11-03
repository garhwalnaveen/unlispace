import { Button } from "./components/ui/button";
import { Suspense, lazy, useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Callback, Desktop, Embed, Login } from "./AuthPages";
import { useAuth } from "./context";
import { DriveBrowser } from "./DriveBrowser";
import { Home } from "./Home";
import { Landing, LandingNavigation } from "./Landing";
import { OrbitMark } from "./OrbitMark";
import { AccessKeys } from "./AccessKeys";
import { Billing } from "./Billing";
import { AcceptInvitation, TeamPage } from "./Team";
import { Settings } from "./Settings";
import { ErrorNotice, Icon, Loading } from "./ui";
// The chat UI (markdown renderer, AI SDK) is large, so it loads only when Ask AI opens.
const AskAI = lazy(() => import("./AskAI").then((m) => ({ default: m.AskAI })));
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
  const authPage = ["/login", "/auth/callback", "/desktop"].includes(location.pathname);
  const marketing = location.pathname === "/overview" || (location.pathname === "/" && ready && !user);
  // Pages embedded in the desktop app render without the web chrome; the app supplies its own.
  const embedded = location.pathname.startsWith("/embed/");
  const workspace = Boolean(user && !authPage && !marketing);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => setNavigationOpen(false), [location.pathname]);
  const section = location.pathname.startsWith("/drives/") ? "File browser"
    : location.pathname === "/ai" ? "Ask AI"
    : location.pathname.includes("access-keys") ? "Access keys"
    : location.pathname.includes("billing") ? "Billing"
    : location.pathname.includes("/team") ? "Team"
    : location.pathname === "/settings" ? "Account" : "Your drives";
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("orbit.theme");
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "dark";
  });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system"
        ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    localStorage.setItem("orbit.theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);
  const askAI = <Suspense fallback={<Loading>Loading Ask AI…</Loading>}><AskAI /></Suspense>;
  if (embedded)
    return (
      <main id="main" className="embedded" tabIndex={-1}>
        {!ready ? <Loading>Loading your account…</Loading> : (
          <Routes>
            <Route path="/embed/ai" element={<Embed>{askAI}</Embed>} />
          </Routes>
        )}
      </main>
    );
  return (
    <div className={`app ${marketing ? "marketing" : user && !authPage ? "workspace" : "welcome"}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        {workspace && <Button className="mobile-nav-toggle" variant="ghost" size="icon" aria-label={navigationOpen ? "Close navigation" : "Open navigation"} aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={() => setNavigationOpen(!navigationOpen)}><Icon name={navigationOpen ? "close" : "menu"} /></Button>}
        <Link className="brand" to={user ? "/" : "/overview"} aria-label={marketing ? "OrbitFS home" : "Orbit home"}>
          <OrbitMark className="brand-mark" />
          <span className="brand-name">{marketing ? "OrbitFS" : "orbit"}</span>
        </Link>
        {workspace && <div className="workspace-context"><span>Workspace</span><Icon name="chevron" /><strong>{section}</strong></div>}
        {marketing && <LandingNavigation />}
        <div className="topbar-right">
          {marketing ? (user ? <Link className="marketing-signin" to="/">Open workspace</Link> : <>
            <Link className="marketing-signin" to="/login">Sign in</Link>
            <Button asChild variant="default"><Link to="/login">Get Early Access</Link></Button>
          </>) : <div className="theme-switch" role="group" aria-label="Appearance">
            {(["system", "light", "dark"] as const).map((value) => (
              <Button
                key={value}
                variant="ghost" size="icon"
                onClick={() => setTheme(value)}
                aria-label={`Use ${value} theme`}
                aria-pressed={theme === value}
                title={`${value[0].toUpperCase()}${value.slice(1)} theme`}
              >
                <Icon name={value === "system" ? "monitor" : value === "light" ? "sun" : "moon"} />
              </Button>
            ))}
          </div>}
        </div>
      </header>
      {user && !authPage && !marketing && (
        <aside id="workspace-navigation" className="sidebar" hidden={mobile && !navigationOpen} onKeyDown={(event) => { if (event.key === "Escape" && mobile) { setNavigationOpen(false); document.querySelector<HTMLButtonElement>(".mobile-nav-toggle")?.focus(); } }}>
          <Link className="brand sidebar-brand" to="/" aria-label="Orbit workspace"><OrbitMark className="brand-mark" /><span className="brand-name">orbit<span className="brand-caption">Your cloud workspace</span></span></Link>
          <nav aria-label="Main navigation">
            <div className="nav-group">
              <p className="nav-heading">Workspace</p>
              {location.pathname.startsWith("/drives/") ? <Link to="/" className="active" aria-current="page"><Icon name="drive" />Your drives</Link> : <NavLink to="/" end><Icon name="drive" />Your drives</NavLink>}
              <NavLink to="/ai"><Icon name="sparkles" />Ask AI</NavLink>
            </div>
            <div className="nav-group">
              <p className="nav-heading">Manage</p>
              <NavLink to="/settings" end><Icon name="user" />Account</NavLink>
              <NavLink to="/settings/access-keys"><Icon name="key" />Access keys</NavLink>
            </div>
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-hint"><Icon name="monitor" /><div><strong>Made for your desktop</strong><p>Open any drive in Finder to work with your files.</p></div></div>
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
          <Button onClick={() => void auth.retry().catch(() => {})}>
            Retry session
          </Button>
        )}
        {!ready && location.pathname !== "/overview" ? (
          <Loading>Loading your account…</Loading>
        ) : (
          <Routes>
            <Route path="/" element={user ? <Home /> : <Landing />} />
            <Route path="/overview" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<Callback />} />
            <Route path="/desktop" element={<Desktop />} />
            <Route element={<Protected />}>
              <Route path="/drives/:id/*" element={<DriveBrowser />} />
              <Route path="/ai" element={askAI} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/access-keys" element={<AccessKeys />} />
              <Route path="/orgs/:id/billing" element={<Billing />} />
              <Route path="/orgs/:id/team" element={<TeamPage />} />
              <Route path="/invites/:token" element={<AcceptInvitation />} />
            </Route>
            <Route
              path="*"
              element={
                <section className="empty">
                  <h1>Page not found</h1>
                  <p>That page could not be found.</p>
                  <Link to="/">Back to drives</Link>
                </section>
              }
            />
          </Routes>
        )}
      </main>
    </div>
  );
}
