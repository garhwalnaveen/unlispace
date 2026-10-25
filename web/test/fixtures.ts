import type { Drive, Session } from "../src/api";
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
