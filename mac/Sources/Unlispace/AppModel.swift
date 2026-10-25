import SwiftUI
import Observation
import UnlispaceKit

@MainActor
@Observable
final class AppModel {
    var status: AppStatus = .signedOut
    var drives: [DriveInfo] = []
    var transfers: [TransferInfo] = []
    var usingMock = false
    var engineInstall: EngineInstallState = .notInstalled
    var lastError: String?
    var hasDevToken = false
    /// Signed-in account (from `auth.status`, or the pending session while the engine is absent).
    var account: AuthUser?
    /// True while a session is stored in the app Keychain waiting for the daemon.
    var sessionPending = false
    var signingIn = false
    var lastChangeLine: String?
    var stateMessage: String?
    var notice: String?
    var lastConflict: ConflictEvent?
    var notificationMessage: String?

    private var client: any DaemonClient
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private let keychain = Keychain()
    private let handoff = SessionHandoff()
    private let auth = DesktopAuth()
    private let conflictNotifications = ConflictNotifications()

    init() {
        client = MockDaemonClient()
        usingMock = true
    }

    var isSignedIn: Bool { account != nil }
    var symbolName: String { status.symbolName }
    var transferLine: String? { TransferSummary.line(for: transfers) }

    func start() {
        guard pollTask == nil else { return }
        // M0 left a refresh token in the app Keychain; M1 apps never keep one.
        try? keychain.delete(account: Keychain.Account.legacyRefreshToken)
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    // MARK: refresh / connection

    /// Picks the real client if the socket is reachable, else the mock.
    func refresh() async {
        engineInstall = DaemonLifecycle.state()
        hasDevToken = ((try? keychain.get(account: Keychain.Account.devToken)) ?? nil) != nil
        sessionPending = handoff.hasPending

        if usingMock {
            let real = UnixSocketDaemonClient()
            if (try? await real.connect()) != nil {
                await client.disconnect()
                client = real
                usingMock = false
                subscribe()
                await retryPendingSession()
            }
        }
        do {
            let st = try await client.status()
            let a = try await client.authStatus()
            account = a.signedIn ? a.user : nil
            stateMessage = st.message
            if usingMock {
                // Mock mode: signed in only if a session is waiting for the engine, or a dev token exists.
                if sessionPending, account == nil, let p = handoff.pending() {
                    account = AuthUser(id: "pending", email: p.email)
                }
                status = (account != nil || hasDevToken) ? AppStatus(engine: st.state == .signedOut ? .idle : st.state) : .signedOut
            } else {
                status = AppStatus(engine: st.state)
            }
            if !usingMock, status != .signedOut {
                drives = try await client.listDrives()
                transfers = try await client.transfers()
            } else {
                drives = []
                transfers = []
            }
            lastError = nil
        } catch {
            if !usingMock {
                // Daemon went away: fall back to mock and say so.
                eventTask?.cancel()
                await client.disconnect()
                client = MockDaemonClient()
                usingMock = true
                drives = []
                transfers = []
            }
            status = .error
            lastError = LogFormat.describe(error)
            Log.app.error("refresh failed: \(LogFormat.describe(error))")
        }
        if engineInstall == .notInstalled && usingMock {
            status = (account != nil || hasDevToken) ? .engineMissing : .signedOut
        }
    }

    private func subscribe() {
        eventTask?.cancel()
        let stream = client.events()
        eventTask = Task { [weak self] in
            for await ev in stream {
                guard let self else { return }
                self.apply(ev)
            }
        }
    }

    func apply(_ ev: DaemonEvent) {
        switch ev {
        case .state(let s):
            status = AppStatus(engine: s.state)
            stateMessage = s.message
            if s.state == .signedOut { account = nil; drives = []; transfers = []; lastConflict = nil }
        case .transfer(let t):
            transfers.removeAll { $0.id == t.id }
            if !t.isFinished { transfers.append(t) }
            if t.status == .failed { lastError = "Transfer failed: \(t.path)" }
        case .change(let c):
            let name = drives.first { $0.driveId == c.driveId }?.name ?? c.driveId
            lastChangeLine = "\(name): \(c.paths.count) remote change\(c.paths.count == 1 ? "" : "s")"
        case .conflict(let conflict):
            lastConflict = conflict
            Task {
                do { try await conflictNotifications.post(conflict) }
                catch { notificationMessage = "Could not show conflict notification: \(LogFormat.describe(error))" }
            }
        case .unknown: break
        }
    }

    // MARK: sign in / out

    func signIn() {
        guard !signingIn else { return }
        guard let api = AppSettings.validateEndpoint(AppSettings.apiEndpoint) else {
            lastError = "API endpoint must be https:// (http:// only for localhost)."
            return
        }
        signingIn = true
        notice = nil
        Task {
            defer { signingIn = false }
            do {
                let session = try await auth.signIn(api: api)
                let target: (any DaemonClient)? = usingMock ? nil : client
                switch try await handoff.deliver(session, api: api, to: target) {
                case .delivered(let user):
                    account = user
                    notice = nil
                case .deferred:
                    account = AuthUser(id: session.user.id, email: session.user.email)
                    notice = "Signed in. Waiting for the engine to start; the session is kept in your Keychain until then."
                }
                lastError = nil
            } catch AuthError.cancelled {
                // user closed the sheet
            } catch {
                lastError = "Sign-in failed: \(LogFormat.describe(error))"
                Log.auth.error("sign-in failed: \(LogFormat.describe(error))")
            }
            await refresh()
        }
    }

    /// Called each time a real daemon connection is made.
    func retryPendingSession() async {
        guard !usingMock else { return }
        do {
            if case .delivered(let user)? = try await handoff.retryPending(to: client) {
                account = user
                notice = nil
            }
        } catch {
            lastError = "Could not hand session to the engine: \(LogFormat.describe(error))"
            Log.auth.error("pending auth.set failed: \(LogFormat.describe(error))")
        }
        sessionPending = handoff.hasPending
    }

    func signOut() {
        let c = client
        Task {
            do { try await c.authSignOut() }
            catch { Log.auth.error("auth.signOut failed: \(LogFormat.describe(error))") }
            handoff.discardPending()
            try? keychain.delete(account: Keychain.Account.devToken)
            account = nil
            drives = []
            transfers = []
            lastConflict = nil
            notice = nil
            await refresh()
        }
    }

    // MARK: drives

    /// Mount only after onboarding has explained Network Volumes privacy.
    func mountSelectedDrives(_ ids: Set<String>) async throws {
        guard !usingMock, isSignedIn else { throw DaemonClientError.notConnected }
        let available = try await client.listDrives()
        guard ids.isSubset(of: Set(available.map(\.driveId))) else {
            throw DaemonClientError.remote(DaemonError(code: "no_such_drive", message: "Refresh the drive list and choose again."))
        }
        for drive in available where ids.contains(drive.driveId) && drive.mountState != .mounted {
            try await client.mount(driveId: drive.driveId)
        }
        await refresh()
    }

    func enableConflictNotifications() async {
        do {
            let allowed = try await conflictNotifications.enable()
            notificationMessage = allowed ? "Conflict notifications enabled." : "Notifications are disabled. Conflicts will still appear in the menu."
        } catch {
            notificationMessage = "Could not enable notifications: \(LogFormat.describe(error))"
        }
    }

    func mount(_ d: DriveInfo) { run { try await $0.mount(driveId: d.driveId) } }
    func unmount(_ d: DriveInfo) { run { try await $0.unmount(driveId: d.driveId) } }

    private func run(_ op: @escaping @Sendable (any DaemonClient) async throws -> Void) {
        let c = client
        Task {
            do { try await op(c); await refresh() }
            catch { lastError = LogFormat.describe(error); Log.app.error("daemon op failed: \(LogFormat.describe(error))") }
        }
    }

    func openInFinder(_ d: DriveInfo) {
        guard let p = d.mountPath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: p))
    }

    // MARK: uls:// URLs

    func handle(url: URL) {
        do {
            switch try DeepLink.parse(url) {
            case .authCallback:
                // ASWebAuthenticationSession consumes the real callback. One arriving here has no
                // session waiting for it, so it is ignored.
                Log.auth.info("ignoring auth callback with no sign-in in progress")
            case .open(let driveId, let path):
                Task { await openDrive(driveId: driveId, path: path) }
            }
        } catch {
            lastError = "Ignored a link: \(LogFormat.describe(error))"
            Log.app.error("rejected url \(LogFormat.url(url)): \(String(describing: error))")
        }
    }

    func openDrive(driveId: String, path: String) async {
        guard isSignedIn else { lastError = "Sign in to Unlispace to open this link."; return }
        do {
            var list = try await client.listDrives()
            guard var drive = list.first(where: { $0.driveId == driveId }) else {
                lastError = "That drive is not available to this account."
                return
            }
            if drive.mountState != .mounted {
                try await client.mount(driveId: driveId)
                list = try await client.listDrives()
                drives = list
                guard let d = list.first(where: { $0.driveId == driveId }) else { return }
                drive = d
            }
            guard let mountPath = drive.mountPath,
                  let target = DeepLink.resolve(mountPath: mountPath, path: path) else {
                lastError = "Could not resolve that path."
                return
            }
            // Fall back to the nearest existing parent so a stale link still lands somewhere useful.
            var url = target
            while !FileManager.default.fileExists(atPath: url.path), url.path.count > mountPath.count {
                url.deleteLastPathComponent()
            }
            NSWorkspace.shared.open(url)
            lastError = nil
        } catch {
            lastError = LogFormat.describe(error)
            Log.app.error("open link failed: \(LogFormat.describe(error))")
        }
    }

    // MARK: engine + config

    func installEngine() {
        engineInstall = DaemonLifecycle.register()
        if engineInstall == .requiresApproval { DaemonLifecycle.openLoginItemsSettings() }
    }

    /// `config.set` with the cache cap only.
    func pushCacheCap() {
        let c = client
        let cfg = DaemonConfig(cacheCapBytes: AppSettings.cacheCapBytes)
        Task { try? await c.setConfig(cfg) }
    }

    /// Developer path: endpoint + static dev token via `config.set` (token never logged).
    func pushDevConfig() {
        let token = (try? keychain.get(account: Keychain.Account.devToken)) ?? nil
        let cfg = DaemonConfig(endpoint: AppSettings.endpoint, token: token, cacheCapBytes: AppSettings.cacheCapBytes)
        let c = client
        Task { try? await c.setConfig(cfg); await refresh() }
    }
}
