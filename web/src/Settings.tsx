import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./context";
import { ErrorNotice, Loading, useLoad } from "./ui";
export function Settings() {
  const { auth } = useAuth();
  const { data, loading, error, reload } = useLoad(auth.api.me);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setName(data.displayName || "");
  }, [data]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setActionError(undefined);
    try {
      await auth.api.updateMe(name.trim());
      setSaved(true);
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setActionError(undefined);
    try {
      await auth.logout();
    } catch (reason) {
      setActionError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">PERSONAL DETAILS</p>
          <h1>Account</h1>
          <p className="muted">A few details to make this space yours.</p>
        </div>
      </header>
      <section className="panel settings">
        <ErrorNotice error={error} />
        {Boolean(error) && <button onClick={reload}>Try again</button>}
        {loading && <Loading />}
        {data && (
          <form className="stack" onSubmit={save}>
            <label htmlFor="account-email">Email address</label>
            <input
              id="account-email"
              type="email"
              autoComplete="email"
              value={data.email}
              readOnly
            />
            <label htmlFor="display-name">Display name</label>
            <input
              id="display-name"
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
            <button className="primary" disabled={busy}>
              {busy ? "Please wait…" : "Save changes"}
            </button>
            {saved && <p role="status">Your display name has been saved.</p>}
          </form>
        )}
        <ErrorNotice error={actionError} />
        <div className="signout">
          <h2>End this session</h2>
          <p className="muted small">
            Sign out of this browser, including its other tabs.
          </p>
          <button disabled={busy} onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>
    </>
  );
}
