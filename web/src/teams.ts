import type { Api, Org } from "./api";
export type Role = Org["role"];
export interface Member { userId: string; email: string; displayName: string | null; role: Role; createdAt: number }
export interface Invitation { id: string; email: string; role: Exclude<Role, "owner">; expiresAt: number }
export interface Team { name: string; role: Role; canManage: boolean; members: Member[]; invitations: Invitation[]; seats: number; teamAvailable: boolean }
export function teams(api: Api) {
  const path = (id: string) => `/orgs/${encodeURIComponent(id)}`;
  const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    members: (id: string) => api.request<Team>(`${path(id)}/members`),
    invite: (id: string, email: string, role: Role) => api.request<Invitation>(`${path(id)}/invites`, json("POST", { email, role })),
    revoke: (id: string, inviteId: string) => api.request(`${path(id)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }),
    change: (id: string, userId: string, role: Role) => api.request(`${path(id)}/members/${encodeURIComponent(userId)}`, json("PATCH", { role })),
    remove: (id: string, userId: string) => api.request(`${path(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    accept: (token: string) => api.request<{ orgId: string }>(`/invites/${encodeURIComponent(token)}/accept`, json("POST", {})),
  };
}
