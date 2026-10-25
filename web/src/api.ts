export const API_URL = (
  import.meta.env.VITE_API_URL || "http://127.0.0.1:8788"
).replace(/\/$/, "");
export interface User {
  id: string;
  email: string;
}
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
  accountCreated: boolean;
}
export interface Profile extends User {
  displayName: string | null;
  createdAt: number;
}
export interface Drive {
  id: string;
  orgId: string;
  name: string;
  placement: string | null;
  status: "ready" | "provisioning_failed" | "deleted";
  createdAt: number;
  access: "read" | "write" | "admin";
}
export interface Org {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  tier: "individual" | "teams";
  trialEndsAt: number | null;
  drives: Drive[];
}
export interface DriveToken {
  token: string;
  expiresAt: number;
  endpoint: string;
  driveId: string;
}
export interface Entry {
  name: string;
  type: "file" | "folder";
  versionId: string;
  size: number;
  mtimeMs: number;
}
export interface ListPage {
  entries: Entry[];
  cursor: string | null;
}
export interface FileStat {
  path: string;
  type: "file" | "folder";
  versionId: string;
  size: number;
  contentType: string;
  mtimeMs: number;
  seq: number;
}
export interface Manifest {
  path: string;
  versionId: string;
  size: number;
  contentType: string;
  mtimeMs: number;
  shards: { h: string; n: number }[];
}
export interface Version {
  versionId: string;
  op: string;
  size: number;
  seq: number;
  ts: number;
  actor: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message || code);
  }
}
export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(
      response.status,
      body.error || "request_failed",
      body.message,
    );
  }
  return response.json() as Promise<T>;
}
export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  return readResponse<T>(
    await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
export type AuthRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export class Api {
  constructor(private request: AuthRequest) {}
  me = () => this.request<Profile>("/me");
  updateMe = (displayName: string) =>
    this.request<Profile>("/me", this.json("PATCH", { displayName }));
  orgs = () => this.request<{ orgs: Org[] }>("/orgs");
  drive = (id: string) =>
    this.request<Drive>(`/drives/${encodeURIComponent(id)}`);
  createDrive = (orgId: string, name: string) =>
    this.request<Drive>(
      `/orgs/${encodeURIComponent(orgId)}/drives`,
      this.json("POST", { name }),
    );
  renameDrive = (id: string, name: string) =>
    this.request<Drive>(
      `/drives/${encodeURIComponent(id)}`,
      this.json("PATCH", { name }),
    );
  deleteDrive = (id: string) =>
    this.request<{ ok: true }>(`/drives/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  driveToken = (id: string) =>
    this.request<DriveToken>(
      `/drives/${encodeURIComponent(id)}/token`,
      this.json("POST", { access: "read" }),
    );
  desktopCode = (state: string, codeChallenge: string) =>
    this.request<{ code: string }>(
      "/auth/desktop/code",
      this.json("POST", { state, codeChallenge }),
    );
  private json(method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }
}

export class DriveApi {
  private grant: DriveToken | null = null;
  private minting: Promise<DriveToken> | null = null;
  constructor(
    private api: Api,
    readonly id: string,
  ) {}
  private async token(): Promise<DriveToken> {
    if (this.grant && this.grant.expiresAt > Date.now() + 30_000)
      return this.grant;
    this.minting ??= this.api
      .driveToken(this.id)
      .then((grant) => (this.grant = grant))
      .finally(() => {
        this.minting = null;
      });
    return this.minting;
  }
  private async fetch(path: string): Promise<Response> {
    const send = (grant: DriveToken) =>
      fetch(
        `${grant.endpoint.replace(/\/$/, "")}/v0/drives/${encodeURIComponent(this.id)}/${path}`,
        { headers: { Authorization: `Bearer ${grant.token}` } },
      );
    const grant = await this.token();
    let response = await send(grant);
    if (response.status === 401) {
      if (this.grant === grant) this.grant = null;
      response = await send(await this.token());
    }
    return response;
  }
  list = (path: string, cursor: string | null = null) =>
    this.json<ListPage>(
      `list?${new URLSearchParams({ path, limit: "100", ...(cursor ? { cursor } : {}) })}`,
    );
  stat = (path: string) =>
    this.json<FileStat>(`stat?${new URLSearchParams({ path })}`);
  versions = (path: string, cursor: string | null = null) =>
    this.json<{ versions: Version[]; cursor: string | null }>(
      `versions?${new URLSearchParams({ path, limit: "100", ...(cursor ? { cursor } : {}) })}`,
    );
  manifest = (path: string, versionId?: string) =>
    this.json<Manifest>(
      `manifest?${new URLSearchParams({ path, ...(versionId ? { versionId } : {}) })}`,
    );
  async shard(hash: string): Promise<ArrayBuffer> {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid shard hash in manifest.");
    const response = await this.fetch(`shards/${hash}`);
    if (!response.ok) await readResponse(response);
    return response.arrayBuffer();
  }
  private async json<T>(path: string): Promise<T> {
    return readResponse<T>(await this.fetch(path));
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      plan_limit:
        "Your Individual plan includes one drive. Additional drives require a Teams plan.",
      invalid_code:
        "That code is invalid or has expired. Try again or request a new code.",
      rate_limited: "Too many attempts. Please wait before trying again.",
      unauthorized: "Your session has expired. Please sign in again.",
      invalid_refresh: "Your session has expired. Please sign in again.",
      not_configured:
        "Google sign-in is not configured on this server. Please use email.",
      no_such_path: "This item could not be found. It may have moved.",
      no_such_drive: "This drive is no longer available.",
    };
    return messages[error.code] || error.message;
  }
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
