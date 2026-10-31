import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { API_URL, publicPost, type Session } from "./api";
import { useAuth } from "./context";
import { desktopCallback, desktopParameters, safeReturn } from "./links";
import { ErrorNotice, Icon, Loading } from "./ui";

export function OtpForm({
  onSession,
}: {
  onSession: (session: Session) => void;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sentTo) codeInput.current?.focus();
  }, [sentTo]);
  useEffect(() => {
    if (cooldown === 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  async function requestCode(address: string, resend = false) {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await publicPost("/auth/otp/start", { email: address });
      setSentTo(address);
      setCode("");
      setCooldown(30);
      setNotice(resend ? "A new code has been sent. Use the most recent email." : "");
      codeInput.current?.focus();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!sentTo) { await requestCode(email.trim()); return; }
    setBusy(true);
    setError(undefined);
    try {
      onSession(await publicPost<Session>("/auth/otp/verify", { email: sentTo, code }));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="stack">
      {sentTo ? (
        <>
          <p className="muted">
            Enter the six-digit code sent to <strong>{sentTo}</strong>. It
            expires in 10 minutes.
          </p>
          <label htmlFor="otp">Verification code</label>
          <Input
            ref={codeInput}
            id="otp"
            name="code"
            className="otp"
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            required
          />
        </>
      ) : (
        <>
          <label htmlFor="email">Email address</label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </>
      )}
      <ErrorNotice error={error} />
      {notice && <p role="status">{notice}</p>}
      <Button
        variant="default"
        disabled={busy || (!!sentTo && code.length !== 6)}
      >
        {busy
          ? "Please wait…"
          : sentTo
            ? "Verify & sign in"
            : "Continue with email"}
      </Button>
      {sentTo && (<>
        <Button type="button" variant="ghost" disabled={busy || cooldown > 0} onClick={() => void requestCode(sentTo, true)}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setSentTo(null);
            setCode("");
            setError(undefined);
            setNotice("");
            setCooldown(0);
          }}
        >
          Change email
        </Button>
      </>)}
    </form>
  );
}
export const GOOGLE_VERIFIER_KEY = "unlispace.googleVerifier";

export async function googleSignIn(returnTo: string): Promise<string> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  sessionStorage.setItem(GOOGLE_VERIFIER_KEY, verifier);
  sessionStorage.setItem("unlispace.return", returnTo);
  return `${API_URL}/auth/google/start?${new URLSearchParams({ return: `${window.location.origin}/auth/callback`, web_code_challenge: challenge })}`;
}

export function Login() {
  const { auth, user } = useAuth();
  const [params] = useSearchParams();
  const returnTo = safeReturn(params.get("return"));
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<unknown>();
  if (user) return <Navigate to={returnTo} replace />;
  return (
    <div className="auth-layout">
      <section className="auth-form" aria-labelledby="sign-in-title">
        <div className="auth-heading">
          <h1 id="sign-in-title">Welcome to Unlispace</h1>
          <p className="muted">Sign in to access your drives and connect your Mac.</p>
        </div>
        <ErrorNotice error={googleError} />
        <Button
          variant="outline" className="w-full"
          disabled={googleBusy}
          onClick={() => {
            setGoogleBusy(true);
            void googleSignIn(returnTo).then(url => window.location.assign(url)).catch(error => { setGoogleError(error); setGoogleBusy(false); });
          }}
        >
          <svg className="google-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>
          Continue with Google
        </Button>
        <div className="divider">or</div>
        <OtpForm onSession={auth.accept} />
        <p className="fine-print">
          Your first sign-in creates an account.<br />
          Your seven-day trial starts when your drive is ready.
        </p>
      </section>
    </div>
  );
}
export function Callback() {
  const { auth } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const handoff = fragment.get("handoff");
    const providerError = fragment.get("error");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    if (!handoff) {
      setError(
        providerError
          ? `Google sign-in failed (${providerError}). Please try again.`
          : "The sign-in link is missing its handoff code. Please sign in again.",
      );
      return;
    }
    const webCodeVerifier = sessionStorage.getItem(GOOGLE_VERIFIER_KEY);
    sessionStorage.removeItem(GOOGLE_VERIFIER_KEY);
    if (!webCodeVerifier) {
      setError(new Error("Start Google sign-in in this browser before opening a sign-in link."));
      return;
    }
    void publicPost<Session>("/auth/handoff/exchange", { handoff, webCodeVerifier })
      .then((session) => {
        auth.accept(session);
        const returnTo = safeReturn(sessionStorage.getItem("unlispace.return"));
        sessionStorage.removeItem("unlispace.return");
        navigate(returnTo, { replace: true });
      })
      .catch(setError);
  }, [auth, navigate]);
  return (
    <section className="narrow panel">
      <h1>Finishing sign-in</h1>
      {error ? (
        <>
          <ErrorNotice error={error} />
          <Link to={`/login?${new URLSearchParams({ return: safeReturn(sessionStorage.getItem("unlispace.return")) })}`}>Return to sign in</Link>
        </>
      ) : (
        <Loading>Signing you in…</Loading>
      )}
    </section>
  );
}
function DesktopStorage({ busy, onOpen }: { busy: boolean; onOpen: () => void }) {
  const { auth, user } = useAuth();
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<"checking" | "preparing" | "ready" | "waiting">("checking");
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setStatus("checking");
    setError(undefined);
    async function check() {
      try {
        const { orgs } = await auth.api.orgs();
        if (!active) return;
        if (orgs.some(org => org.drives.some(drive => drive.status === "ready"))) {
          setStatus("ready");
        } else if (++attempts < 10 && orgs.length > 0) {
          setStatus("preparing");
          timer = setTimeout(() => void check(), 2000);
        } else {
          setStatus("waiting");
        }
      } catch (reason) {
        if (active) { setError(reason); setStatus("waiting"); }
      }
    }
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [auth, revision]);
  return <>
    <h1>{status === "ready" ? "Your Unlispace is ready" : "Preparing your Unlispace"}</h1>
    <p className="muted">Connecting as <strong>{user?.email}</strong></p>
    <ol className="connection-progress" aria-label="Connection progress">
      <li><span aria-hidden="true">✓</span> Account verified</li>
      <li aria-current={status === "ready" ? undefined : "step"}><span aria-hidden="true">{status === "ready" ? "✓" : "2"}</span> {status === "ready" ? "Drive ready" : "Preparing drive"}</li>
      <li><span aria-hidden="true">3</span> Connect your Mac</li>
    </ol>
    {(status === "checking" || status === "preparing") && <Loading>Preparing your drive… New trials start when storage is ready.</Loading>}
    {status === "ready" && <p className="muted">Open the desktop app to finish connecting your Mac.</p>}
    {status === "waiting" && <p role="status">Your drive could not be prepared yet. Try again, or check your drives in the browser.</p>}
    <ErrorNotice error={error} />
    {status === "waiting" && <Button onClick={() => setRevision(value => value + 1)}>Retry drive setup</Button>}
    <Button variant="default" onClick={onOpen} disabled={busy || status !== "ready"}>
      {busy ? "Please wait…" : "Open Unlispace"}
    </Button>
    <Link className="desktop-browser-link" to="/">View drives in browser</Link>
  </>;
}

export function Desktop() {
  const { auth, user } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => { setOpened(false); setError(undefined); }, [user?.id, location.search]);
  // `switch=1` (from the desktop app's "Use a different account") signs the web session out once,
  // then continues to sign-in with the desktop parameters but without `switch`, so it cannot loop.
  const query = new URLSearchParams(location.search);
  const switching = query.get("switch") === "1";
  query.delete("switch");
  const desktopTarget = `${location.pathname}${query.toString() ? `?${query}` : ""}`;
  const switched = useRef(false);
  useEffect(() => {
    if (!switching || !user || switched.current) return;
    switched.current = true;
    setBusy(true);
    auth.logout().catch(setError).finally(() => setBusy(false));
  }, [switching, user, auth]);
  let params: ReturnType<typeof desktopParameters> | undefined;
  try {
    params = desktopParameters(location.search);
  } catch (reason) {
    return (
      <section className="narrow panel">
        <h1>Desktop sign-in</h1>
        <ErrorNotice error={reason} />
        <Link to="/">Back to drives</Link>
      </section>
    );
  }
  if (!user)
    return (
      <Navigate
        to={`/login?${new URLSearchParams({ return: desktopTarget })}`}
        replace
      />
    );
  if (switching && !error)
    return (
      <section className="narrow panel desktop">
        <Loading>Signing out so you can choose another account…</Loading>
      </section>
    );
  const { state, codeChallenge } = params;
  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      const { code } = await auth.api.desktopCode(state, codeChallenge);
      window.location.href = desktopCallback(code, state);
      setOpened(true);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  async function anotherAccount() {
    setBusy(true);
    setError(undefined);
    try {
      await auth.logout();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="desktop-setup desktop">
      <span className="desktop-symbol" aria-hidden="true">
        <Icon name="monitor" />
      </span>
      <ErrorNotice error={error} />
      <DesktopStorage key={user.id} busy={busy} onOpen={() => void open()} />
      {opened && (
        <p role="status">
          Your browser was asked to open Unlispace. If nothing happened, check
          that the desktop app is installed, then try again.
        </p>
      )}
      <Button
        variant="ghost"
        onClick={() => void anotherAccount()}
        disabled={busy}
      >
        Use a different account
      </Button>
    </section>
  );
}
