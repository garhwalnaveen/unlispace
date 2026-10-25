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
import { Settings } from "./Settings";
import { ErrorNotice, Loading } from "./ui";
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
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("unlispace.theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("unlispace.theme", theme);
  }, [theme]);
  useEffect(() => {
    document.getElementById("main")?.focus();
  }, [location.pathname]);
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link className="brand" to="/" aria-label="Unlispace home">
          <span className="brand-mark" aria-hidden="true">
            u
          </span>
          unlispace<span className="brand-period">.</span>
        </Link>
        <div className="topbar-right">
          {user && (
            <nav aria-label="Main navigation">
              <NavLink to="/" end>
                Drives
              </NavLink>
              <NavLink to="/settings">Account</NavLink>
            </nav>
          )}
          <button
            className="theme-button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☼" : "◐"}
          </button>
        </div>
      </header>
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
        <span>A place for every version.</span>
        <span>Unlispace</span>
      </footer>
    </div>
  );
}
