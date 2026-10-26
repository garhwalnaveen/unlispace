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
import { ErrorNotice, Loading } from "./ui";

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
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sentTo) codeInput.current?.focus();
  }, [sentTo]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (!sentTo) {
        await publicPost("/auth/otp/start", { email: email.trim() });
        setSentTo(email.trim());
      } else {
        onSession(
          await publicPost<Session>("/auth/otp/verify", {
            email: sentTo,
            code,
          }),
        );
      }
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
          <input
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
          <input
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
      <button
        className="primary"
        disabled={busy || (!!sentTo && code.length !== 6)}
      >
        {busy
          ? "Please wait…"
          : sentTo
            ? "Verify & sign in"
            : "Continue with email"}
      </button>
      {sentTo && (
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            setSentTo(null);
            setCode("");
            setError(undefined);
          }}
        >
          Use another email or request a new code
        </button>
      )}
    </form>
  );
}
export function Login() {
  const { auth, user } = useAuth();
  const [params] = useSearchParams();
  const returnTo = safeReturn(params.get("return"));
  const googleUrl = `${API_URL}/auth/google/start?${new URLSearchParams({ return: `${window.location.origin}/auth/callback` })}`;
  if (user) return <Navigate to={returnTo} replace />;
  return (
    <div className="auth-layout">
      <section className="auth-form" aria-labelledby="sign-in-title">
        <div className="auth-heading">
          <h1 id="sign-in-title">Welcome to Unlispace</h1>
          <p className="muted">A little more space for everything you do.</p>
        </div>
        <a
          className="button secondary"
          href={googleUrl}
          onClick={() => sessionStorage.setItem("unlispace.return", returnTo)}
        >
          <svg className="google-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z"/></svg>
          Continue with Google
        </a>
        <div className="divider">or continue with email</div>
        <OtpForm onSession={auth.accept} />
        <p className="fine-print">
          Your first sign-in creates an account.<br />
          Seven days to make yourself at home.
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
    void publicPost<Session>("/auth/handoff/exchange", { handoff })
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
          <Link to="/login">Return to sign in</Link>
        </>
      ) : (
        <Loading>Securely opening your space…</Loading>
      )}
    </section>
  );
}
export function Desktop() {
  const { auth, user } = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<unknown>();
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
        to={`/login?${new URLSearchParams({ return: location.pathname + location.search })}`}
        replace
      />
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
    <section className="narrow panel desktop">
      <span className="desktop-symbol" aria-hidden="true">
        ▱
      </span>
      <h1>Meet your new drive.</h1>
      <p className="muted">Continue to the Unlispace desktop app as</p>
      <p>
        <strong>{user.email}</strong>
      </p>
      <ErrorNotice error={error} />
      <button className="primary" onClick={() => void open()} disabled={busy}>
        {busy ? "Please wait…" : "Open Unlispace"}
      </button>
      {opened && (
        <p role="status">
          Your browser was asked to open Unlispace. If nothing happened, check
          that the desktop app is installed, then try again.
        </p>
      )}
      <button
        className="text-button"
        onClick={() => void anotherAccount()}
        disabled={busy}
      >
        Use another account
      </button>
    </section>
  );
}
