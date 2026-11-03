import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
          <h1>Account</h1>
          <p className="muted">Manage your profile and browser session.</p>
        </div>
      </header>
      <section className="panel settings">
        <h2>Profile</h2>
        <p className="muted">Your email identifies your account. Choose how your name appears.</p>
        <ErrorNotice error={error} />
        {Boolean(error) && <Button onClick={reload}>Try again</Button>}
        {loading && <Loading />}
        {data && (
          <form className="stack" onSubmit={save}>
            <label htmlFor="account-email">Email address</label>
            <Input
              id="account-email"
              type="email"
              autoComplete="email"
              value={data.email}
              readOnly
            />
            <label htmlFor="display-name">Display name</label>
            <Input
              id="display-name"
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
            />
            <Button variant="default" disabled={busy}>
              {busy ? "Please wait…" : "Save changes"}
            </Button>
            {saved && <p role="status">Your display name has been saved.</p>}
          </form>
        )}
        <ErrorNotice error={actionError} />
        <div className="signout">
          <h2>End this session</h2>
          <p className="muted small">
            Sign out of this browser, including its other tabs.
          </p>
          <Button disabled={busy} onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
        <div className="signout">
          <h2>Connected tools</h2>
          <p className="muted small">Manage credentials for apps that access your drives.</p>
          <Button asChild><Link to="/settings/access-keys">Manage access keys</Link></Button>
        </div>
      </section>
    </>
  );
}
