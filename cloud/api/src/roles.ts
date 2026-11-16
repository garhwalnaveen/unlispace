export { roleAccess, type Role } from "../../shared/access";

/** Owners and admins manage a workspace: drives, members, billing. */
export const canManage = (role: string): boolean => role === "owner" || role === "admin";
