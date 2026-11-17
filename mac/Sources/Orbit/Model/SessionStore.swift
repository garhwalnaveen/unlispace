import Foundation
import Observation
import OrbitKit

/// Who is signed in and the browser sign-in flow.
/// The engine holds the session. The app keeps a copy in its Keychain only while the engine is unreachable.
@MainActor @Observable
final class SessionStore {
    /// Placeholder id for a signed-in account whose session has not reached the engine yet.
    nonisolated static let pendingAccountID = "pending"

    private(set) var account: AuthUser?
    private(set) var sessionPending = false
    private(set) var signingIn = false
    private(set) var hasDevToken = false
    private(set) var canRetrySavedSignIn = false
    private(set) var retryingSavedSignIn = false

    var isSignedIn: Bool { account != nil }
    /// A developer token works without an account.
    var hasCredentials: Bool { isSignedIn || hasDevToken }

    /// Called with the previous account id when the account changes.
    @ObservationIgnored var onAccountChange: (() -> Void)?

    @ObservationIgnored private let engine: EngineLink
    @ObservationIgnored private let messages: AppMessages
    @ObservationIgnored private let keychain: Keychain
    @ObservationIgnored private let handoff: SessionHandoff
    @ObservationIgnored private let auth = DesktopAuth()
    @ObservationIgnored private var signInTask: Task<Void, Never>?

    @ObservationIgnored private let defaults: UserDefaults
    /// Set when the user signs out while the engine is unreachable. The engine still holds the
    /// session, so the sign-out is delivered as soon as it connects.
    static let signOutPendingKey = "signOutPending"

    init(engine: EngineLink, messages: AppMessages, defaults: UserDefaults = .standard, keychain: Keychain = Keychain()) {
        self.engine = engine
        self.messages = messages
        self.defaults = defaults
        self.keychain = keychain
        handoff = SessionHandoff(keychain: keychain)
    }

    func setAccount(_ user: AuthUser?) {
        let changed = account?.id != user?.id
        account = user
        if changed { onAccountChange?() }
    }

    func setCanRetrySavedSignIn(_ value: Bool) { canRetrySavedSignIn = value }

    /// Reads what only this Mac knows: a saved developer token and a session waiting for the engine.
    func reloadLocalState() {
        hasDevToken = ((try? keychain.get(account: Keychain.Account.devToken)) ?? nil) != nil
        sessionPending = handoff.hasPending
    }

    /// Without the engine, show the session waiting to be handed over if there is one.
    /// Otherwise the last account the engine reported stays: its session is still in the engine.
    func showLocalAccount() {
        canRetrySavedSignIn = false
        if sessionPending, let pending = handoff.pending() {
            setAccount(AuthUser(id: Self.pendingAccountID, email: pending.email))
        } else if account?.id == Self.pendingAccountID {
            setAccount(nil)
        }
    }

    /// Removes the refresh token that pre-engine builds kept in the app Keychain.
    func deleteLegacyToken() { try? keychain.delete(account: Keychain.Account.legacyRefreshToken) }

    // MARK: Sign in

    func signIn(switchAccount: Bool = false) {
        guard !signingIn else { return }
        guard let api = AppSettings.validateEndpoint(AppSettings.apiEndpoint) else {
            messages.report("This build has no server address. Set one in Settings › Advanced.")
            return
        }
        signingIn = true
        messages.notice = nil
        signInTask = Task {
            defer { signingIn = false; signInTask = nil }
            do {
                let session = try await auth.signIn(api: api, switchAccount: switchAccount)
                defaults.removeObject(forKey: Self.signOutPendingKey)
                switch try await handoff.deliver(session, api: api, to: engine.client) {
                case .delivered(let user):
                    setAccount(user)
                    messages.notice = nil
                case .deferred:
                    setAccount(session.user)
                    messages.notice = "Signed in. Your drives appear once Orbit can run in the background."
                }
                messages.error = nil
            } catch AuthError.cancelled {
            } catch is CancellationError {
            } catch let error as URLError where error.code == .cancelled {
            } catch {
                messages.report("Sign-in failed: \(Format.problem(error))")
                Log.auth.error("sign-in failed: \(LogFormat.describe(error))")
            }
            await engine.refresh()
        }
    }

    func openSignInBrowser() {
        if !auth.openBrowser() { messages.report("Sign-in is still starting. Try again in a moment.") }
    }

    func cancelSignIn() {
        signInTask?.cancel()
        auth.cancel()
    }

    /// Returns false when the URL is not the callback this app is waiting for.
    func receiveCallback(_ url: URL) -> Bool { auth.receiveCallback(url) }

    /// Brings a newly connected engine in line with what happened while it was away:
    /// a sign-out it never saw, or a session saved for it.
    func reconcile(with client: any DaemonClient) async {
        if defaults.bool(forKey: Self.signOutPendingKey), !sessionPending {
            do {
                try await client.authSignOut()
                defaults.removeObject(forKey: Self.signOutPendingKey)
            } catch {
                Log.auth.error("deferred auth.signOut failed: \(LogFormat.describe(error))")
            }
            return
        }
        defaults.removeObject(forKey: Self.signOutPendingKey)
        do {
            if case .delivered(let user)? = try await handoff.retryPending(to: client) {
                setAccount(user)
                messages.notice = nil
            }
        } catch {
            messages.report("Could not finish sign-in: \(Format.problem(error))")
            Log.auth.error("pending auth.set failed: \(LogFormat.describe(error))")
        }
        sessionPending = handoff.hasPending
    }

    /// Asks the engine to read its saved session again, after macOS denied Keychain access.
    func retrySavedSignIn() {
        guard canRetrySavedSignIn, !retryingSavedSignIn, let client = engine.client else { return }
        retryingSavedSignIn = true
        Task {
            defer { retryingSavedSignIn = false }
            do {
                try await client.authRetryRestore()
                canRetrySavedSignIn = false
                await engine.refresh()
            } catch {
                messages.report("Could not restore sign-in: \(Format.problem(error))")
            }
        }
    }

    // MARK: Sign out

    /// Returns true when the session is gone. On failure the engine's view of the session wins.
    func signOut() async -> Bool {
        if let client = engine.client {
            do { try await client.authSignOut() }
            catch {
                await engine.refresh()
                if engine.isConnected && !isSignedIn { handoff.discardPending() }
                messages.report("Could not sign out: \(Format.problem(error))")
                Log.auth.error("auth.signOut failed: \(LogFormat.describe(error))")
                return false
            }
        } else {
            defaults.set(true, forKey: Self.signOutPendingKey)
        }
        handoff.discardPending()
        try? keychain.delete(account: Keychain.Account.devToken)
        setAccount(nil)
        return true
    }

    // MARK: Developer token

    var devToken: String? { (try? keychain.get(account: Keychain.Account.devToken)) ?? nil }

    func saveDevToken(_ token: String) throws {
        try keychain.set(token, account: Keychain.Account.devToken)
        hasDevToken = true
    }

    func clearDevToken() {
        try? keychain.delete(account: Keychain.Account.devToken)
        hasDevToken = false
    }
}
