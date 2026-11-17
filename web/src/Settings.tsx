import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "./context";
import { PageHeader, Section } from "./settings/parts";
import { THEMES, useTheme, type Theme } from "./shell/theme";
import { ErrorNotice, Loading, useLoad } from "./ui";

const APPEARANCE: Record<Theme, { label: string; hint: string; icon: typeof Sun }> = {
  system: { label: "System", hint: "Follows your device", icon: Monitor },
  light: { label: "Light", hint: "Always light", icon: Sun },
  dark: { label: "Dark", hint: "Always dark", icon: Moon },
};

interface ThemeProps { theme: Theme; setTheme: (theme: Theme) => void }

/** Account: profile, appearance and sign out. The app passes its theme state; on its own the page keeps one. */
export function Settings(props: Partial<ThemeProps>) {
  return props.theme && props.setTheme ? <Account theme={props.theme} setTheme={props.setTheme} /> : <StandaloneAccount />;
}
function StandaloneAccount() {
  const [theme, setTheme] = useTheme();
  return <Account theme={theme} setTheme={setTheme} />;
}

function Account({ theme, setTheme }: ThemeProps) {
  const { auth } = useAuth();
  const { data, loading, error, reload } = useLoad(auth.api.me);
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<unknown>();
  useEffect(() => {
    if (data) { setName(data.displayName || ""); setSavedName(data.displayName || ""); }
  }, [data]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setSaved(false); setActionError(undefined);
    try {
      await auth.api.updateMe(name.trim());
      setSavedName(name.trim()); setName(name.trim()); setSaved(true);
    } catch (reason) { setActionError(reason); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setSigningOut(true); setSignOutError(undefined);
    try { await auth.logout(); }
    catch (reason) { setSignOutError(reason); }
    finally { setSigningOut(false); }
  }
  return <>
    <PageHeader title="Account" description="Your profile, how Orbit looks, and this browser's session." />
    <Section title="Profile" labelledBy="account-profile">
      <div className="st-card-body">
        <ErrorNotice error={error} />
        {Boolean(error) && <Button onClick={reload}>Try again</Button>}
        {loading && <Loading />}
        {data && <form className="st-form" onSubmit={save}>
          <div className="st-field">
            <span className="st-label" id="account-email-label">Email</span>
            <p className="st-static" aria-labelledby="account-email-label">{data.email}</p>
            <p className="st-help">You sign in with this address. It can't be changed here.</p>
          </div>
          <div className="st-field">
            <label htmlFor="display-name">Display name</label>
            <Input id="display-name" autoComplete="name" maxLength={100} value={name} placeholder="How your name appears to teammates"
              onChange={(event) => { setName(event.target.value); setSaved(false); }} />
          </div>
          <ErrorNotice error={actionError} />
          <div className="st-actions">
            <Button variant="default" disabled={busy || name.trim() === savedName}>{busy ? "Saving…" : "Save changes"}</Button>
            {saved && <p className="st-inline-status" role="status">Saved.</p>}
          </div>
        </form>}
      </div>
    </Section>
    <Section title="Appearance" description="Applies to Orbit in this browser." labelledBy="account-appearance">
      <div className="st-card-body">
        <div className="st-choices" role="radiogroup" aria-labelledby="account-appearance">
          {THEMES.map((value) => {
            const { label, hint, icon: Glyph } = APPEARANCE[value];
            return <label className="st-choice" key={value}>
              <input type="radio" name="appearance" value={value} checked={theme === value} onChange={() => setTheme(value)} />
              <Glyph aria-hidden="true" />
              <span><strong>{label}</strong><small>{hint}</small></span>
            </label>;
          })}
        </div>
      </div>
    </Section>
    <Section title="Sign out" description="Signs you out of Orbit in this browser. Your files stay where they are." labelledBy="account-session"
      action={<Button disabled={signingOut} onClick={() => void signOut()}><LogOut aria-hidden="true" />{signingOut ? "Signing out…" : "Sign out"}</Button>}>
      <div className="st-card-body"><ErrorNotice error={signOutError} /></div>
    </Section>
  </>;
}
