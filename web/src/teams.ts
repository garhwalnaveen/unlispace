import type { Org } from "./api";
export type Role = Org["role"];
export interface Member { userId: string; email: string; displayName: string | null; role: Role; createdAt: number }
export interface Invitation { id: string; email: string; role: Exclude<Role, "owner">; expiresAt: number }
export interface Team { name: string; role: Role; canManage: boolean; members: Member[]; invitations: Invitation[]; seats: number; teamAvailable: boolean }
