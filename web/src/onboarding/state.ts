// Onboarding progress is a per-browser convenience, not account state: it only decides whether to
// show the welcome flow and which checklist items are ticked.
const KEY = "orbit.onboarding";
export const ONBOARDING_EVENT = "orbit:onboarding";
export type OnboardingPath = "mac" | "tools" | "browser";
export interface OnboardingState {
  /** `pending` is set when an account is created in this browser. */
  status: "pending" | "done";
  /** The account this progress belongs to, so a second person in the same browser starts clean. */
  user?: string;
  path?: OnboardingPath;
  /** The Mac app was connected from this browser. */
  macOpened?: boolean;
  keyCreated?: boolean;
  uploaded?: boolean;
  /** The sidebar list is folded to its heading. */
  collapsed?: boolean;
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
  window.dispatchEvent(new Event(ONBOARDING_EVENT));
  return next;
}
/** Marks a newly created account so its first visit opens the welcome flow. */
export const startOnboarding = (user?: string) => {
  if (!readOnboarding()) writeOnboarding({ status: "pending", ...(user ? { user } : {}) });
};
/** Call when a session is accepted: drops another account's progress, then starts onboarding for a new account. */
export function noteSignIn(user: string, accountCreated: boolean) {
  const current = readOnboarding();
  if (current?.user && current.user !== user) {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(ONBOARDING_EVENT));
  }
  if (accountCreated) startOnboarding(user);
}
/** Subscribes to changes made in this tab and in other tabs. */
export function watchOnboarding(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener(ONBOARDING_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ONBOARDING_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
