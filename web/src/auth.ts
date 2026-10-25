import {
  API_URL,
  Api,
  ApiError,
  publicPost,
  readResponse,
  errorMessage,
  type Session,
  type User,
} from "./api";

export const REFRESH_KEY = "unlispace.refreshToken";
interface MemorySession {
  familyId: string;
  accessToken: string;
  expiresAt: number;
  user: User;
}
interface AuthState {
  user: User | null;
  ready: boolean;
  error: string | null;
}
type ChannelMessage =
  | { type: "session"; session: MemorySession; refreshToken: string }
  | { type: "request" }
  | { type: "logout"; familyId: string | null };

export class AuthStore {
  private memory: MemorySession | null = null;
  private memoryRefreshToken: string | null = null;
  private state: AuthState = { user: null, ready: false, error: null };
  private listeners = new Set<() => void>();
  private refreshing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private channel: BroadcastChannel | null;
  private revokedFamilies = new Set<string>();
  readonly api = new Api(<T>(path: string, init?: RequestInit) =>
    this.request<T>(path, init),
  );

  constructor(
    storage: Storage = localStorage,
    channel: BroadcastChannel | null = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("unlispace.auth"),
  ) {
    // Discard legacy persisted credentials; never read them back into a session.
    storage.removeItem(REFRESH_KEY);
    this.channel = channel;
    if (channel)
      channel.onmessage = ({ data }: MessageEvent<ChannelMessage>) => {
        if (data.type === "session") this.apply(data.session, data.refreshToken);
        if (data.type === "logout") {
          if (data.familyId) this.revokedFamilies.add(data.familyId);
          this.clear(false);
        }
        if (data.type === "request") this.broadcast();
      };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(state: AuthState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private apply(session: MemorySession, refreshToken: string) {
    if (this.revokedFamilies.has(session.familyId)) return;
    this.memory = session;
    this.memoryRefreshToken = refreshToken;
    this.emit({ user: session.user, ready: true, error: null });
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.refresh().catch(() => {});
      },
      Math.max(1000, session.expiresAt - Date.now() - 60_000),
    );
  }
  private broadcast() {
    const refreshToken = this.memoryRefreshToken;
    if (this.memory && refreshToken)
      this.channel?.postMessage({
        type: "session",
        session: this.memory,
        refreshToken,
      } satisfies ChannelMessage);
  }
  accept = (session: Session, familyId: string = crypto.randomUUID()) => {
    this.apply(
      {
        familyId,
        accessToken: session.accessToken,
        expiresAt: Date.now() + session.expiresIn * 1000,
        user: session.user,
      },
      session.refreshToken,
    );
    this.broadcast();
  };
  private async requestSession() {
    if (!this.channel) return;
    this.channel.postMessage({ type: "request" } satisfies ChannelMessage);
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  async start() {
    await this.requestSession();
    if (!this.memoryRefreshToken) {
      this.emit({ user: null, ready: true, error: null });
      return;
    }
    try { await this.refresh(); } catch { /* Snapshot carries the recoverable error. */ }
  }
  refresh(rejectedToken?: string): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const rotate = async () => {
      // Every rotation asks peers inside the lock, so waiters use the latest token.
      await this.requestSession();
      if (!this.memoryRefreshToken) throw new ApiError(401, "invalid_refresh");
      if (
        this.memory &&
        this.memory.expiresAt > Date.now() + 60_000 &&
        this.memory.accessToken !== rejectedToken
      )
        return;
      const refreshToken = this.memoryRefreshToken;
      if (!refreshToken) throw new ApiError(401, "invalid_refresh");
      const familyId = this.memory?.familyId;
      const session = await publicPost<Session>("/auth/refresh", {
        refreshToken,
      });
      // Signing out while the network request was pending must not resurrect a session.
      if (this.memoryRefreshToken === refreshToken)
        this.accept(session, familyId);
    };
    this.refreshing = (async () => {
      try {
        if (!navigator.locks)
          throw new Error(
            "This browser cannot safely refresh sessions across tabs. Use a current browser with Web Locks support.",
          );
        await navigator.locks.request("unlispace.auth.refresh", rotate);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) this.clear();
        this.emit({
          ...this.state,
          ready: true,
          error: errorMessage(error),
        });
        throw error;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  retry = () => this.refresh(this.memory?.accessToken);
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.memory || this.memory.expiresAt <= Date.now() + 60_000)
      await this.refresh();
    const rejectedToken = this.memory?.accessToken;
    const send = () =>
      fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${this.memory?.accessToken || ""}`,
        },
      });
    let response = await send();
    if (response.status === 401) {
      await this.refresh(rejectedToken);
      response = await send();
    }
    return readResponse<T>(response);
  }
  async logout() {
    // Logout and rotation share a lock so logout always revokes the latest refresh token.
    await navigator.locks.request("unlispace.auth.refresh", async () => {
      await this.requestSession();
      const refreshToken = this.memoryRefreshToken;
      if (refreshToken) await publicPost("/auth/logout", { refreshToken });
      this.clear();
    });
  }
  private clear(broadcast = true) {
    const familyId = this.memory?.familyId || null;
    if (familyId) this.revokedFamilies.add(familyId);
    clearTimeout(this.timer);
    this.memory = null;
    this.memoryRefreshToken = null;
    this.emit({ user: null, ready: true, error: null });
    if (broadcast)
      this.channel?.postMessage({ type: "logout", familyId } satisfies ChannelMessage);
  }
  dispose() {
    clearTimeout(this.timer);
    this.channel?.close();
    this.listeners.clear();
  }
}
