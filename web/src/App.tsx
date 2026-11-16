import { Button } from "./components/ui/button";
import { ChevronsUpDown, CreditCard, Users } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
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
import { ErrorNotice, Icon, Loading, useLoad } from "./ui";
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
function WorkspacePage({ page }: { page: "billing" | "team" }) {
  const { auth } = useAuth();
  const { data, loading, error, reload } = useLoad(auth.api.orgs);
  const title = page === "billing" ? "Billing" : "Team";
  if (data?.orgs.length === 1) return <Navigate to={`/orgs/${encodeURIComponent(data.orgs[0].id)}/${page}`} replace />;
  return <>
    <header className="page-heading"><div><h1>{title}</h1><p>Choose a workspace to {page === "billing" ? "manage its subscription" : "manage its members"}.</p></div></header>
    <ErrorNotice error={error} />
    {Boolean(error) && <Button onClick={reload}>Try again</Button>}
    {loading && <Loading>Loading workspaces…</Loading>}
    {data?.orgs.length === 0 && <p className="notice">Your account has no workspaces. Contact your workspace owner.</p>}
    {data?.orgs.map((org) => <section className="panel" key={org.id}><div className="section-heading"><h2>{org.name}</h2><Button asChild><Link to={`/orgs/${encodeURIComponent(org.id)}/${page}`} aria-label={`Open ${page} for ${org.name}`}>Open {page}</Link></Button></div></section>)}
  </>;
}
export function App() {
  const { auth, ready, user, error } = useAuth();
  const location = useLocation();
  const authPage = ["/login", "/auth/callback", "/desktop"].includes(location.pathname);
  const marketing = location.pathname === "/overview" || (location.pathname === "/" && ready && !user);
  // Pages embedded in the desktop app render without the web chrome; the app supplies its own.
  const embedded = location.pathname.startsWith("/embed/");
  const workspace = Boolean(user && !authPage && !marketing);
  const orgPath = location.pathname.match(/^\/orgs\/[^/]+(?=\/(?:billing|team)$)/)?.[0];
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<unknown>();
  async function signOut() {
    setSigningOut(true);
    setSignOutError(undefined);
    try { await auth.logout(); }
    catch (reason) { setSignOutError(reason); }
    finally { setSigningOut(false); }
  }
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
        <div className="topbar-inner">
        <Link className="brand" to={user ? "/" : "/overview"} aria-label="Orbit home">
          <OrbitMark className="brand-mark" />
          {!workspace && <span>Orbit</span>}
        </Link>
        {workspace && <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" className="workspace-switch">Your workspace <ChevronsUpDown size={13} /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem asChild><Link to="/settings">Your account</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link to="/settings/access-keys">Access keys</Link></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Appearance</DropdownMenuLabel>
              {(["system", "light", "dark"] as const).map((value) => <DropdownMenuItem key={value} onSelect={() => setTheme(value)}><Icon name={value === "system" ? "monitor" : value === "light" ? "sun" : "moon"} />{value[0].toUpperCase() + value.slice(1)}{theme === value && <span className="ml-auto" aria-label="Selected">✓</span>}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <nav className="workspace-nav" aria-label="Main navigation">
            {location.pathname.startsWith("/drives/") ? <Link to="/" className="active" aria-current="page"><Icon name="drive" /><span>Your drives</span></Link> : <NavLink to="/" end><Icon name="drive" /><span>Your drives</span></NavLink>}
            <NavLink to="/ai"><Icon name="sparkles" /><span>Ask AI</span></NavLink>
            <NavLink to={orgPath ? `${orgPath}/billing` : "/billing"}><CreditCard aria-hidden="true" /><span>Billing</span></NavLink>
            <NavLink to={orgPath ? `${orgPath}/team` : "/team"}><Users aria-hidden="true" /><span>Team</span></NavLink>
          </nav>
        </>}
        {marketing && <LandingNavigation />}
        <div className="topbar-right">
          {workspace ? <><Link className="session-email" to="/settings">{user!.email}</Link><Button variant="ghost" className="session-signout" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</Button></> : marketing ? (user ? <Link className="marketing-signin" to="/">Your drives</Link> : <>
            <Link className="marketing-signin" to="/login">Sign in</Link>
            <Button asChild variant="default"><Link to="/login">Create an account</Link></Button>
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
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <ErrorNotice error={signOutError} />
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
              <Route path="/billing" element={<WorkspacePage page="billing" />} />
              <Route path="/team" element={<WorkspacePage page="team" />} />
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
