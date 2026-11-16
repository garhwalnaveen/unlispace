export interface AccessKey {
  accessKeyId: string;
  workspaceId: string;
  label: string | null;
  access: "read" | "write" | "admin";
  drives: string[] | null;
  parent: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export interface NewKey {
  workspaceId: string;
  label: string;
  access: AccessKey["access"];
  drives: string[] | null;
}
export interface KeySecret extends AccessKey { secretAccessKey: string }
