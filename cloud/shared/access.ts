// Drive/key access levels, shared by the control plane, data plane and S3 gateway.

export type Access = "read" | "write" | "admin";
/** Ordering only; 0 means "no access". */
export const ACCESS_RANK: Record<Access, number> = { read: 1, write: 2, admin: 3 };

export const isAccess = (v: unknown): v is Access => typeof v === "string" && Object.hasOwn(ACCESS_RANK, v);
export const hasAccess = (have: Access, need: Access): boolean => ACCESS_RANK[have] >= ACCESS_RANK[need];

export type Role = "owner" | "admin" | "member" | "viewer";
export const roleAccess = (role: string): Access => (role === "owner" || role === "admin" ? "admin" : role === "member" ? "write" : "read");
