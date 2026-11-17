import { Button } from "./components/ui/button";
import { Suspense, lazy, useEffect } from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { Callback, Desktop, Embed, Login } from "./AuthPages";
import { useAuth } from "./context";
import { DriveBrowser } from "./DriveBrowser";
import { Landing, LandingNavigation } from "./Landing";
import { OrbitMark } from "./OrbitMark";
import { AccessKeys } from "./AccessKeys";
import { Billing } from "./Billing";
import { AcceptInvitation, TeamPage } from "./Team";
import { Settings } from "./Settings";
import { ErrorNotice, Icon, Loading } from "./ui";
import { Welcome } from "./onboarding/Welcome";
import { SettingsLayout } from "./settings/SettingsLayout";
import { AppShell } from "./shell/AppShell";
import { Home } from "./shell/Home";
import { THEMES, useTheme, type Theme } from "./shell/theme";
import { useWorkspace, WorkspaceProvider } from "./shell/workspace";
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
/** `/billing` and `/team` open the page for the current workspace. */
function WorkspacePage({ page }: { page: "billing" | "team" }) {
  const { current, loaded, error, reload } = useWorkspace();
  if (current) return <Navigate to={`/orgs/${encodeURIComponent(current.id)}/${page}`} replace />;
  if (error) return <><ErrorNotice error={error} /><Button onClick={reload}>Try again</Button></>;
  if (!loaded) return <Loading>Loading your workspace…</Loading>;
  return <p className="notice">Your account has no workspaces. Contact your workspace owner.</p>;
}
function Shell({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  return <WorkspaceProvider><AppShell theme={theme} setTheme={setTheme}><Outlet /></AppShell></WorkspaceProvider>;
}
function Focused() {
  return <WorkspaceProvider><main id="main" className="focused" tabIndex={-1}><Outlet /></main></WorkspaceProvider>;
}
export function App() {
  const { auth, ready, user, error } = useAuth();
  const location = useLocation();
  const authPage = ["/login", "/auth/callback", "/desktop"].includes(location.pathname);
  const marketing = location.pathname === "/overview" || (location.pathname === "/" && ready && !user);
  // Pages embedded in the desktop app render without the web chrome; the app supplies its own.
  const embedded = location.pathname.startsWith("/embed/");
  const [theme, setTheme] = useTheme();
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
  const sessionError = Boolean(error) && <>
    <ErrorNotice error={error} />
    <Button onClick={() => void auth.retry().catch(() => {})}>Retry session</Button>
  </>;
  // Signed-in pages get the sidebar shell; sign-in, desktop connect and the public page keep a plain header.
  if (ready && user && !authPage && !marketing)
    return (
      <Routes>
        <Route element={<Focused />}>
          <Route path="/welcome" element={<Welcome />} />
        </Route>
        <Route element={<Shell theme={theme} setTheme={setTheme} />}>
          <Route path="/" element={<>{sessionError}<Home /></>} />
          <Route path="/billing" element={<WorkspacePage page="billing" />} />
          <Route path="/team" element={<WorkspacePage page="team" />} />
          <Route path="/drives/:id/*" element={<DriveBrowser />} />
          <Route path="/ai" element={askAI} />
          <Route element={<SettingsLayout />}>
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/access-keys" element={<AccessKeys />} />
            <Route path="/orgs/:id/billing" element={<Billing />} />
            <Route path="/orgs/:id/team" element={<TeamPage />} />
          </Route>
          <Route path="/invites/:token" element={<AcceptInvitation />} />
          <Route path="*" element={<section className="empty-state"><h1>Page not found</h1><p>That page could not be found.</p><Link to="/">Back to your files</Link></section>} />
        </Route>
      </Routes>
    );
  return (
    <div className={`app ${marketing ? "marketing" : "welcome"}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
        <Link className="brand" to={user ? "/" : "/overview"} aria-label={marketing ? "OrbitFS home" : "Orbit home"}>
          <OrbitMark className="brand-mark" />
          <span>{marketing ? "OrbitFS" : "Orbit"}</span>
        </Link>
        {marketing && <LandingNavigation />}
        <div className="topbar-right">
          {marketing ? (user ? <Link className="marketing-signin" to="/">Open workspace</Link> : <>
            <Link className="marketing-signin" to="/login">Sign in</Link>
            <Button asChild variant="default"><Link to="/login">Get Early Access</Link></Button>
          </>) : <div className="theme-switch" role="group" aria-label="Appearance">
            {THEMES.map((value) => (
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
        {sessionError}
        {!ready && location.pathname !== "/overview" ? (
          <Loading>Loading your account…</Loading>
        ) : (
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/overview" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<Callback />} />
            <Route path="/desktop" element={<Desktop />} />
            <Route path="*" element={<Protected />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
