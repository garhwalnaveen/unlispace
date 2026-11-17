// Onboarding progress is a per-browser convenience, not account state: it only decides whether to
// show the welcome flow and which checklist items are ticked.
const KEY = "orbit.onboarding";
export type OnboardingPath = "mac" | "tools" | "browser";
export interface OnboardingState {
  /** `pending` is set when an account is created in this browser. */
  status: "pending" | "done";
  path?: OnboardingPath;
  macOpened?: boolean;
  keyCreated?: boolean;
  dismissed?: boolean;
}
export function readOnboarding(): OnboardingState | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null") as OnboardingState | null;
    return value && (value.status === "pending" || value.status === "done") ? value : null;
  } catch { return null; }
}
export function writeOnboarding(patch: Partial<OnboardingState>): OnboardingState {
  const next = { status: "done" as const, ...readOnboarding(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("orbit:onboarding"));
  return next;
}
export const startOnboarding = () => { if (!readOnboarding()) writeOnboarding({ status: "pending" }); };
