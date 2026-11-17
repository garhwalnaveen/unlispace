import { Check, LoaderCircle, MailCheck, MonitorCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { API_URL, ApiError, publicPost, type Session } from "./api";
import type { AuthStore } from "./auth";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useAuth } from "./context";
import { desktopCallback, desktopParameters, safeReturn } from "./links";
import { Card } from "./onboarding/Card";
import { noteSignIn, readOnboarding, writeOnboarding } from "./onboarding/state";
import { ErrorNotice, Loading } from "./ui";

const RESEND_SECONDS = 30;

/** Accepts a session; a newly created account is marked so its first visit opens the welcome flow. */
function acceptSession(auth: AuthStore, session: Session) {
  noteSignIn(session.user.id, session.accountCreated);
  auth.accept(session);
}

/** Email sign-in: an address, then a six-digit code that is submitted as soon as it is complete. */
export function OtpForm({
  onSession,
  onStage,
}: {
  onSession: (session: Session) => void;
  /** Called with the address a code was sent to, or null on the email step. */
  onStage?: (sentTo: string | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"sending" | "verifying" | null>(null);
  const [error, setError] = useState<unknown>();
  const [cooldown, setCooldown] = useState(0);
  const [notice, setNotice] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const verifying = useRef(false);
  useEffect(() => {
    if (sentTo) codeInput.current?.focus();
  }, [sentTo]);
  useEffect(() => {
    if (cooldown === 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  function stage(address: string | null) {
    setSentTo(address);
    onStage?.(address);
  }
  async function requestCode(address: string, resend = false) {
    setBusy("sending");
    setError(undefined);
    setNotice("");
    try {
      await publicPost("/auth/otp/start", { email: address });
      stage(address);
      setCode("");
      setCooldown(RESEND_SECONDS);
      setNotice(resend ? "We sent a new code. Use the most recent email." : "");
      codeInput.current?.focus();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }
  async function verify(value: string) {
    if (!sentTo || verifying.current) return;
    verifying.current = true;
    setBusy("verifying");
    setError(undefined);
    setNotice("");
    try {
      onSession(await publicPost<Session>("/auth/otp/verify", { email: sentTo, code: value }));
    } catch (reason) {
      setError(reason);
      // A wrong code is retyped; anything else (offline, rate limit) can be retried with the same digits.
      if (reason instanceof ApiError && reason.code === "invalid_code") setCode("");
      codeInput.current?.focus();
    } finally {
      verifying.current = false;
      setBusy(null);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!sentTo) void requestCode(email.trim());
    else if (code.length === 6) void verify(code);
  }
  if (!sentTo)
    return (
      <form onSubmit={submit} className="ob-form">
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
        <ErrorNotice error={error} />
        <Button variant="default" className="ob-main" disabled={busy !== null}>
          {busy ? "Sending code…" : "Continue with email"}
        </Button>
      </form>
    );
  return (
    <form onSubmit={submit} className="ob-form">
      <label htmlFor="otp">Verification code</label>
      <Input
        ref={codeInput}
        id="otp"
        name="code"
        className="ob-code"
        value={code}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
          setCode(digits);
          if (digits.length === 6 && digits !== code) void verify(digits);
        }}
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        placeholder="••••••"
        aria-describedby="otp-help"
        readOnly={busy === "verifying"}
        required
      />
      <p id="otp-help" className="ob-muted">Enter the code from the email. It expires in 10 minutes.</p>
      <ErrorNotice error={error} />
      {notice && <p className="ob-muted" role="status">{notice}</p>}
      <Button variant="default" className="ob-main" disabled={busy !== null || code.length !== 6}>
        {busy === "verifying" ? "Signing in…" : "Sign in"}
      </Button>
      <div className="ob-row">
        <button type="button" className="ob-link" disabled={busy !== null || cooldown > 0} onClick={() => void requestCode(sentTo, true)}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
        </button>
        <button
          type="button"
          className="ob-link"
          disabled={busy !== null}
          onClick={() => {
            stage(null);
            setCode("");
            setError(undefined);
            setNotice("");
            setCooldown(0);
          }}
        >
          Use a different email
        </button>
      </div>
    </form>
  );
}
export const GOOGLE_VERIFIER_KEY = "orbit.googleVerifier";

export async function googleSignIn(returnTo: string): Promise<string> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  sessionStorage.setItem(GOOGLE_VERIFIER_KEY, verifier);
  sessionStorage.setItem("orbit.return", returnTo);
  return `${API_URL}/auth/google/start?${new URLSearchParams({ return: `${window.location.origin}/auth/callback`, web_code_challenge: challenge })}`;
}

export function Login() {
  const { auth, user } = useAuth();
  const [params] = useSearchParams();
  const returnTo = safeReturn(params.get("return"));
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<unknown>();
  const [sentTo, setSentTo] = useState<string | null>(null);
  if (user) return <Navigate to={returnTo} replace />;
  const purpose = returnTo.startsWith("/desktop")
    ? "Sign in to connect Orbit on this Mac."
    : returnTo.startsWith("/invites/")
      ? "Sign in to accept your invitation."
      : "Your files in Finder, in the browser and in your tools.";
  return (
    <Card
      icon={sentTo ? <MailCheck /> : undefined}
      title={sentTo ? "Check your email" : "Sign in to Orbit"}
      lead={sentTo ? <>We sent a six-digit code to <strong>{sentTo}</strong>.</> : purpose}
    >
      {!sentTo && <>
        <ErrorNotice error={googleError} />
        <Button
          variant="outline" className="ob-main"
          disabled={googleBusy}
          onClick={() => {
            setGoogleBusy(true);
            setGoogleError(undefined);
            void googleSignIn(returnTo).then(url => window.location.assign(url)).catch(error => { setGoogleError(error); setGoogleBusy(false); });
          }}
        >
          <svg className="ob-google" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>
          {googleBusy ? "Opening Google…" : "Continue with Google"}
        </Button>
        <div className="ob-divider">or</div>
      </>}
      <OtpForm onSession={(session) => acceptSession(auth, session)} onStage={setSentTo} />
      {!sentTo && <p className="ob-fine">New to Orbit? Signing in creates your account with a 7-day trial. No card needed.</p>}
    </Card>
  );
}

const GOOGLE_DENIED = "access_denied";
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
        providerError === GOOGLE_DENIED
          ? "Google sign-in was cancelled. Sign in again when you are ready."
          : providerError
            ? `Google could not sign you in (${providerError}). Try again, or use your email instead.`
            : "This sign-in link is incomplete. Sign in again.",
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
        acceptSession(auth, session);
        const returnTo = safeReturn(sessionStorage.getItem("orbit.return"));
        sessionStorage.removeItem("orbit.return");
        navigate(returnTo, { replace: true });
      })
      .catch(setError);
  }, [auth, navigate]);
  if (!error) return <Card title="Signing you in…"><Waiting>One moment while we finish with Google.</Waiting></Card>;
  return (
    <Card icon={<TriangleAlert />} title="Sign-in didn't finish" lead="Nothing was changed on your account.">
      <ErrorNotice error={error} />
      <Button asChild variant="default" className="ob-main">
        <Link to={`/login?${new URLSearchParams({ return: safeReturn(sessionStorage.getItem("orbit.return")) })}`}>Back to sign in</Link>
      </Button>
    </Card>
  );
}
function Waiting({ children }: { children: ReactNode }) {
  return <p className="ob-wait" role="status"><LoaderCircle className="animate-spin" aria-hidden="true" /><span>{children}</span></p>;
}

type DriveStatus = "checking" | "preparing" | "ready" | "waiting";
const DRIVE_CHECKS = 10;
const DRIVE_CHECK_MS = 2000;
/** Polls for the account's first ready drive, a bounded number of times, until `retry` is called. */
function useDriveStatus(auth: AuthStore) {
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<DriveStatus>("checking");
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
        } else if (++attempts < DRIVE_CHECKS && orgs.length > 0) {
          setStatus("preparing");
          timer = setTimeout(() => void check(), DRIVE_CHECK_MS);
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
  return { status, error, retry: () => setRevision(value => value + 1) };
}

/** The signed-in part of desktop connect. One state is shown at a time. */
function DesktopConnect({ state, codeChallenge }: { state: string; codeChallenge: string }) {
  const { auth, user } = useAuth();
  const drive = useDriveStatus(auth);
  const [busy, setBusy] = useState<"opening" | "leaving" | null>(null);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<unknown>();
  async function open() {
    setBusy("opening");
    setError(undefined);
    try {
      const { code } = await auth.api.desktopCode(state, codeChallenge);
      window.location.href = desktopCallback(code, state);
      setOpened(true);
      // Connecting the Mac app is what a new account came for, so the web welcome is not shown again.
      if (readOnboarding()) writeOnboarding({ status: "done", macOpened: true });
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }
  async function anotherAccount() {
    setBusy("leaving");
    setError(undefined);
    try {
      await auth.logout();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }
  const account = <p className="ob-muted">Signed in as <strong>{user?.email}</strong></p>;
  const switchAccount = (
    <button type="button" className="ob-link ob-skip" disabled={busy !== null} onClick={() => void anotherAccount()}>
      {busy === "leaving" ? "Signing out…" : "Use a different account"}
    </button>
  );
  if (busy === "opening")
    return <Card title="Opening Orbit…"><Waiting>Handing your sign-in to the Mac app.</Waiting></Card>;
  if (opened)
    return (
      <Card icon={<Check />} title="You can close this tab" lead="Orbit is opening on your Mac. Your drive appears in Finder once the app has connected.">
        <ErrorNotice error={error} />
        <Button variant="outline" className="ob-main" onClick={() => void open()}>Open Orbit again</Button>
        <p className="ob-muted">Nothing happened? Check that Orbit is installed on this Mac, then open it again.</p>
        <Link className="ob-link ob-skip" to="/">Open your files on the web</Link>
      </Card>
    );
  if (drive.status === "ready")
    return (
      <Card icon={<MonitorCheck />} title="Connect Orbit on this Mac" lead="Orbit will open, and your drive will appear in Finder.">
        {account}
        <ErrorNotice error={error} />
        <Button variant="default" className="ob-main" onClick={() => void open()} disabled={busy !== null}>Open Orbit</Button>
        {switchAccount}
      </Card>
    );
  if (drive.status === "waiting")
    return (
      <Card icon={<TriangleAlert />} title="Your drive isn't ready yet" lead="Your account is safe. Setting up the drive is taking longer than usual.">
        {account}
        <ErrorNotice error={error || drive.error} />
        <Button variant="default" className="ob-main" onClick={drive.retry} disabled={busy !== null}>Try again</Button>
        <div className="ob-row ob-center"><Link className="ob-link" to="/">Continue on the web</Link>{switchAccount}</div>
      </Card>
    );
  return (
    <Card title="Setting up your drive" lead="This usually takes a few seconds. Keep this tab open.">
      <Waiting>Orbit opens as soon as your drive is ready.</Waiting>
      {account}
      <ErrorNotice error={error} />
      {switchAccount}
    </Card>
  );
}

export function Desktop() {
  const { auth, user } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<unknown>();
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
    auth.logout().catch(setError);
  }, [switching, user, auth]);
  let params: ReturnType<typeof desktopParameters> | undefined;
  try {
    params = desktopParameters(location.search);
  } catch (reason) {
    return (
      <Card icon={<TriangleAlert />} title="Start again from the Mac app">
        <ErrorNotice error={reason} />
        <Link className="ob-link ob-skip" to="/">Open your files on the web</Link>
      </Card>
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
    return <Card title="Signing out…"><Waiting>Then you can choose another account.</Waiting></Card>;
  if (switching)
    return (
      <Card icon={<TriangleAlert />} title="Could not sign out" lead="You are still signed in on this browser.">
        <ErrorNotice error={error} />
        <Button asChild variant="default" className="ob-main"><Link to={desktopTarget}>Continue as {user.email}</Link></Button>
      </Card>
    );
  // Keyed so a different account or a new request starts from a clean state.
  return <DesktopConnect key={`${user.id} ${location.search}`} state={params.state} codeChallenge={params.codeChallenge} />;
}
/** Session storage key the desktop app's WebView sets before load; never put in a URL. */
const EMBED_VERIFIER_KEY = "orbit.embedVerifier";
/**
 * Entry point for the desktop app's embedded pages. The app passes a one-time handoff in the
 * fragment and injects its PKCE verifier into session storage, then this signs in as that user.
 */
export function Embed({ children }: { children: ReactNode }) {
  const { auth, user } = useAuth();
  const started = useRef(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const handoff = new URLSearchParams(window.location.hash.slice(1)).get("handoff");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const webCodeVerifier = sessionStorage.getItem(EMBED_VERIFIER_KEY);
    sessionStorage.removeItem(EMBED_VERIFIER_KEY);
    if (!handoff || !webCodeVerifier) {
      if (!user) setError("Open Ask AI from the Orbit app to sign in.");
      return;
    }
    void publicPost<Session>("/auth/handoff/exchange", { handoff, webCodeVerifier })
      .then((session) => auth.accept(session))
      .catch(setError);
  }, [auth, user]);
  if (user) return <>{children}</>;
  return error ? <ErrorNotice error={error} /> : <Loading>Signing you in…</Loading>;
}
