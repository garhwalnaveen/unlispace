import Foundation

public enum HandoffOutcome: Sendable, Equatable {
    /// The daemon acknowledged `auth.set`; no copy of the session remains in the app.
    case delivered(AuthUser)
    /// The daemon is not reachable. The session sits in the app Keychain item `pending-session`
    /// until `retryPending` succeeds.
    case deferred
}

/// Moves a freshly obtained session to the daemon without the app keeping the refresh token.
///
/// Policy:
///  1. Try `auth.set` immediately. On acknowledgement, delete the app-side Keychain copy
///     (`pending-session` and the legacy `refresh-token`). Nothing is ever written on this path.
///  2. If the daemon is unreachable (no socket, connection lost, or it reports `offline`/`internal`),
///     store ONE Keychain item `pending-session` and return `.deferred`. `AppModel` calls
///     `retryPending` every time a real daemon connection is established.
///  3. If the daemon rejects the session (`unauthorized`, `bad_request`), drop any pending copy and
///     throw: retrying the same tokens cannot help.
public struct SessionHandoff: Sendable {
    private let keychain: Keychain
    public init(keychain: Keychain = Keychain()) { self.keychain = keychain }

    public var hasPending: Bool { ((try? keychain.get(account: Keychain.Account.pendingSession)) ?? nil) != nil }

    public func pending() -> PendingSession? {
        guard let raw = (try? keychain.get(account: Keychain.Account.pendingSession)) ?? nil,
              let p = try? JSONDecoder().decode(PendingSession.self, from: Data(raw.utf8)) else { return nil }
        return p
    }

    public func deliver(_ session: Session, api: URL, to client: (any DaemonClient)?) async throws -> HandoffOutcome {
        let p = PendingSession(apiEndpoint: api.absoluteString, accessToken: session.accessToken,
                               refreshToken: session.refreshToken, email: session.user.email)
        return try await deliver(p, to: client)
    }

    /// Re-sends a stored session. Returns `nil` when nothing is pending.
    public func retryPending(to client: any DaemonClient) async throws -> HandoffOutcome? {
        guard let p = pending() else {
            clearLocalCopies()
            return nil
        }
        return try await deliver(p, to: client)
    }

    public func discardPending() { clearLocalCopies() }

    private func deliver(_ p: PendingSession, to client: (any DaemonClient)?) async throws -> HandoffOutcome {
        guard let client else { try store(p); return .deferred }
        do {
            let res = try await client.authSet(p.authParams)
            clearLocalCopies()
            Log.auth.info("session handed to daemon")
            return .delivered(res.user)
        } catch {
            if Self.isRetryable(error) {
                try store(p)
                Log.auth.info("daemon unreachable; session kept in app keychain until it connects")
                return .deferred
            }
            clearLocalCopies()
            throw error
        }
    }

    static func isRetryable(_ error: Error) -> Bool {
        guard let e = error as? DaemonClientError else { return false }
        switch e {
        case .notConnected, .socketMissing, .connectFailed, .disconnected, .malformedResponse: return true
        case .remote(let d): return d.code == "offline" || d.code == "internal"
        }
    }

    private func store(_ p: PendingSession) throws {
        let data = try JSONEncoder().encode(p)
        try keychain.set(String(decoding: data, as: UTF8.self), account: Keychain.Account.pendingSession)
    }

    private func clearLocalCopies() {
        try? keychain.delete(account: Keychain.Account.pendingSession)
        try? keychain.delete(account: Keychain.Account.legacyRefreshToken)
    }
}
