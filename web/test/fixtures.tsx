import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach } from "vitest";
import { App } from "../src/App";
import type { Drive, Session } from "../src/api";
import { AuthStore } from "../src/auth";
import { AuthContext } from "../src/context";
export const session: Session = {
  accessToken: "access-old",
  refreshToken: "rt_old",
  expiresIn: 900,
  user: { id: "u_test", email: "you@example.com" },
  accountCreated: false,
};
export const rotated: Session = {
  ...session,
  accessToken: "access-new",
  refreshToken: "rt_new",
};
export const drive: Drive = {
  id: "d-test",
  orgId: "o_test",
  name: "Space",
  placement: "weur",
  status: "ready",
  createdAt: 1000,
  access: "admin",
};
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const org = {
  id: drive.orgId,
  name: "My Space",
  role: "owner",
  tier: "individual",
  trialEndsAt: Date.now() + 86_400_000,
  drives: [drive],
};
export const catalog = {
  plans: [
    { id: "individual", name: "Individual", bytesPerSeat: 500e9, minSeats: 1, maxSeats: 1 },
    { id: "teams", name: "Teams", bytesPerSeat: 1e12, minSeats: 2, maxSeats: 1000 },
  ],
  storageAddon: { bytes: 500e9, maxQuantity: 1000 },
  checkoutAvailable: true,
  trialDays: 7,
  checkoutStartsImmediately: true,
  checkoutEndsTrial: true,
};

const stores: AuthStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));
/** An AuthStore that is disposed after the test; signed in as `session` unless `signedIn` is false. */
export function authStore({ signedIn = true, channel = null }: { signedIn?: boolean; channel?: BroadcastChannel | null } = {}) {
  const auth = new AuthStore(localStorage, channel);
  stores.push(auth);
  if (signedIn) auth.accept(session);
  return auth;
}
/** A signed-out AuthStore that has finished session recovery. */
export async function signedOutStore() {
  const auth = authStore({ signedIn: false });
  await auth.start();
  return auth;
}
export function renderWithAuth(ui: ReactNode, path = "/", auth = authStore()) {
  return Object.assign(
    render(<MemoryRouter initialEntries={[path]}><AuthContext value={auth}>{ui}</AuthContext></MemoryRouter>),
    { auth },
  );
}
export function renderApp(path = "/", auth = authStore()) {
  return renderWithAuth(<App />, path, auth);
}
