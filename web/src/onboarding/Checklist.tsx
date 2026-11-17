import { ChevronDown, Circle, CircleCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Org } from "../api";
import { useAuth } from "../context";
import { driveLink } from "../links";
import { useWorkspace } from "../shell/workspace";
import { readOnboarding, watchOnboarding, writeOnboarding, type OnboardingState } from "./state";
import "./onboarding.css";

function useOnboarding(): OnboardingState | null {
  const [state, setState] = useState(readOnboarding);
  useEffect(() => watchOnboarding(() => setState(readOnboarding())), []);
  return state;
}

/**
 * Sidebar "Get started" list. It appears for an account that started in this browser, ticks steps
 * from real data where the server knows the answer, and goes away once everything is done or hidden.
 */
export function Checklist() {
  const { user } = useAuth();
  const { current, loaded } = useWorkspace();
  const state = useOnboarding();
  if (!state || state.dismissed || !loaded || !current || (state.user && state.user !== user?.id)) return null;
  return <Steps key={current.id} org={current} state={state} />;
}

function Steps({ org, state }: { org: Org; state: OnboardingState }) {
  const { auth } = useAuth();
  const { access, drives, canManage } = useWorkspace();
  const location = useLocation();
  const [hasKey, setHasKey] = useState(false);
  const [hasTeammate, setHasTeammate] = useState(false);
  const [hasFiles, setHasFiles] = useState(false);
  const [focused, setFocused] = useState(0);
  const drive = drives.find((item) => item.status === "ready");
  const team = canManage && (access?.tier ?? org.tier) === "teams";
  const filesDone = Boolean(state.uploaded) || hasFiles || (access?.usedBytes ?? org.usedBytes ?? 0) > 0 || drives.some((item) => (item.usageBytes ?? 0) > 0);
  const keyDone = Boolean(state.keyCreated) || hasKey;
  // Progress made elsewhere is picked up when the person moves to another area or returns to the tab.
  const area = location.pathname.split("/").slice(1, 3).join("/");
  useEffect(() => {
    const refresh = () => setFocused((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    let active = true;
    // The list is a convenience: a failed check leaves the step open rather than showing an error.
    if (!keyDone)
      void auth.api.keys.list().then((result) => {
        if (active && Array.isArray(result?.keys)) setHasKey(result.keys.some((key) => !key.revokedAt && key.workspaceId === org.id));
      }, () => {});
    if (team && !hasTeammate)
      void auth.api.teams.members(org.id).then((result) => {
        if (active && Array.isArray(result?.members)) setHasTeammate(result.members.length > 1 || (result.invitations?.length ?? 0) > 0);
      }, () => {});
    if (!filesDone && drive)
      void auth.api.drive(drive.id).then((result) => {
        if (active && (result?.usageBytes ?? 0) > 0) setHasFiles(true);
      }, () => {});
    return () => { active = false; };
  }, [auth, org.id, drive?.id, team, keyDone, hasTeammate, filesDone, area, focused]);
  const steps = [
    { id: "mac", label: "Install the Mac app", done: Boolean(state.macOpened), to: "/welcome?path=mac" },
    { id: "file", label: "Add your first file", done: filesDone, to: drive ? driveLink(drive.id) : "/" },
    { id: "tools", label: "Connect a tool or agent", done: keyDone, to: "/settings/access-keys" },
    ...(team ? [{ id: "invite", label: "Invite a teammate", done: hasTeammate, to: `/orgs/${encodeURIComponent(org.id)}/team` }] : []),
  ];
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;
  const collapsed = Boolean(state.collapsed);
  return (
    <section className="ob-checklist" aria-label="Get started">
      <div className="ob-checklist-head">
        <button type="button" className="ob-toggle" aria-expanded={!collapsed} aria-controls="ob-checklist-steps" onClick={() => writeOnboarding({ collapsed: !collapsed })}>
          <strong>Get started</strong><small>{done} of {steps.length} done</small><ChevronDown aria-hidden="true" />
        </button>
        <button type="button" className="ob-icon" aria-label="Dismiss Get started" title="Dismiss" onClick={() => writeOnboarding({ dismissed: true })}><X aria-hidden="true" /></button>
      </div>
      <span className="ob-meter" aria-hidden="true"><span style={{ width: `${(done / steps.length) * 100}%` }} /></span>
      {!collapsed && (
        <ul id="ob-checklist-steps">
          {steps.map((step) => (
            <li key={step.id} data-done={step.done || undefined}>
              {step.done
                ? <span><CircleCheck aria-hidden="true" />{step.label}<span className="sr-only"> (done)</span></span>
                : <Link to={step.to}><Circle aria-hidden="true" />{step.label}</Link>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
