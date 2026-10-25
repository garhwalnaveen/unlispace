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
            placeholder="you@example.com"
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
      <div className="auth-story">
        <p className="eyebrow">A little more room.</p>
        <h1>
          Your files.
          <br />
          Every version.
          <br />
          <span>One space.</span>
        </h1>
        <p>
          A cloud drive that feels at home.
          <br />
          Pick up exactly where you left off.
        </p>
        <div className="drive-drawing" aria-hidden="true">
          <div />
          <span>UNLISPACE</span>
          <i />
        </div>
      </div>
      <section className="auth-form" aria-labelledby="sign-in-title">
        <h2 id="sign-in-title">Make yourself at home.</h2>
        <p className="muted">Sign in or create your Unlispace account.</p>
        <OtpForm onSession={auth.accept} />
        <div className="divider">or</div>
        <a
          className="button secondary"
          href={googleUrl}
          onClick={() => sessionStorage.setItem("unlispace.return", returnTo)}
        >
          Continue with Google
        </a>
        <p className="fine-print">
          New here? Your first sign-in creates a personal space with a seven-day
          trial.
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
    const handoff = new URLSearchParams(window.location.hash.slice(1)).get(
      "handoff",
    );
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    if (!handoff) {
      setError(
        "The sign-in link is missing its handoff code. Please sign in again.",
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
