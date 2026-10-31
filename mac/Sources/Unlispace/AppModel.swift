import SwiftUI
import Observation
import ServiceManagement
import UnlispaceKit

@MainActor
@Observable
final class AppModel {
    var status: AppStatus = .signedOut
    var drives: [DriveInfo] = []
    var transfers: [TransferInfo] = []
    var uploads: UploadsSnapshot?
    var pins: [OfflinePin]?
    var mounts: [DaemonMount]?
    private(set) var activation = ActivationProgress()
    private(set) var recentUploads: [TransferInfo] = []
    private(set) var copyingFile = false
    var copyMessage: String?
    private(set) var pendingDriveActions: Set<String> = []
    let updates = UpdateController()
    var usingMock = false
    var engineInstall: EngineInstallState = .notInstalled
    var lastError: String?
    var hasDevToken = false
    /// Signed-in account (from `auth.status`, or the pending session while the engine is absent).
    var account: AuthUser? {
        didSet {
            if oldValue?.id != account?.id {
                activation = .load(accountID: account?.id, defaults: activationDefaults)
                recentUploads = []
                copyMessage = nil
            }
        }
    }
    /// True while a session is stored in the app Keychain waiting for the daemon.
    var sessionPending = false
    var signingIn = false
    var canRetrySignIn = false
    var retryingSavedSignIn = false
    var lastChangeLine: String?
    var stateMessage: String?
    var notice: String?
    var lastConflict: ConflictEvent?
    var notificationMessage: String?
    var notificationAccess: AccessStatus = .checking
    var loginAccess: AccessStatus = .checking
    var requestingNotifications = false
    var permissionMessage: String?
    /// Engine-reported upload limit in bytes/s (0 = unlimited); nil when the engine does not report it.
    var uploadBandwidthBps: Int64?
    /// Set when the engine rejects `uploadBandwidthBps`; the control is then disabled.
    var uploadLimitUnsupported = false
    var uploadLimitMessage: String?
    private(set) var workspaceShortcut: WorkspaceShortcut
    var shortcutMessage: String?
    private let workspaceHotKey = WorkspaceHotKey()

    private var client: any DaemonClient
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var signInTask: Task<Void, Never>?
    private let keychain = Keychain()
    private let handoff = SessionHandoff()
    private let auth = DesktopAuth()
    private let conflictNotifications = ConflictNotifications()
    private let activationDefaults: UserDefaults
    private var refreshing = false

    init(defaults: UserDefaults = .standard) {
        activationDefaults = defaults
        workspaceShortcut = WorkspaceShortcut(rawValue: defaults.string(forKey: "workspaceShortcut") ?? "") ?? .option
        client = MockDaemonClient()
        usingMock = true
    }

    func setWorkspaceShortcut(_ shortcut: WorkspaceShortcut) {
        guard workspaceHotKey.register(shortcut) else {
            shortcutMessage = "\(shortcut.label) is unavailable. Choose Option–Space, Control–Option–Space, or Command–Option–Space. Spotlight keeps Command–Space."
            return
        }
        workspaceShortcut = shortcut
        activationDefaults.set(shortcut.rawValue, forKey: "workspaceShortcut")
        shortcutMessage = "Press \(shortcut.label) from any app to open Unlispace. Spotlight keeps Command–Space."
    }

    func resumeWorkspaceShortcut() {
        if !workspaceHotKey.register(workspaceShortcut) {
            shortcutMessage = "\(workspaceShortcut.label) is unavailable. Change the shortcut or open Unlispace from the menu bar."
        }
    }

    func stopWorkspaceShortcut() { workspaceHotKey.stop() }

    var isSignedIn: Bool { account != nil }
    var symbolName: String { status.symbolName }
    var transferLine: String? { TransferSummary.line(for: transfers) }
    var connectionTitle: String {
        if usingMock { return isSignedIn ? "Mac not connected" : status.title }
        if sessionPending { return "Connecting account…" }
        if !isSignedIn && !hasDevToken { return status.title }
        return TransferSummary.uploadTitle(uploads: uploads, transfers: transfers, state: status, available: true, recentUploads: recentUploads)
    }

    func start() {
        guard pollTask == nil else { return }
        updates.start()
        setWorkspaceShortcut(workspaceShortcut)
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
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
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
            try await refreshConnected(using: client)
            lastError = nil
        } catch {
            if !usingMock {
                // Daemon went away: fall back to mock and say so.
                eventTask?.cancel()
                await client.disconnect()
                client = MockDaemonClient()
                usingMock = true
                canRetrySignIn = false
                drives = []
                transfers = []
                clearDistribution()
            }
            status = .error
            lastError = LogFormat.describe(error)
            Log.app.error("refresh failed: \(LogFormat.describe(error))")
        }
        if engineInstall == .notInstalled && usingMock {
            status = (account != nil || hasDevToken) ? .engineMissing : .signedOut
        }
    }

    /// A connected engine can be reachable while its saved credentials are unavailable.
    func refreshConnected(using source: any DaemonClient) async throws {
        let st = try await source.status()
        let a = try await source.authStatus()
        account = a.signedIn ? a.user : nil
        stateMessage = st.message
        canRetrySignIn = st.canRetrySignIn == true
        uploadBandwidthBps = st.uploadBandwidthBps
        if usingMock {
            // Mock mode: signed in only if a session is waiting for the engine, or a dev token exists.
            if sessionPending, account == nil, let p = handoff.pending() {
                account = AuthUser(id: "pending", email: p.email)
            }
            status = (account != nil || hasDevToken) ? AppStatus(engine: st.state == .signedOut ? .idle : st.state) : .signedOut
        } else {
            status = AppStatus(engine: st.state)
        }
        if !usingMock, a.signedIn || hasDevToken {
            drives = try await source.listDrives()
            transfers = try await source.transfers()
            try await refreshDistribution(using: source)
        } else {
            drives = []
            transfers = []
            clearDistribution()
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
            if s.state == .signedOut { account = nil; drives = []; transfers = []; lastConflict = nil; clearDistribution() }
        case .transfer(let t):
            transfers.removeAll { $0.id == t.id }
            if !t.isFinished { transfers.append(t) }
            recordUpload(t)
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
        case .pin(let pin):
            if pins != nil {
                pins?.removeAll { $0.id == pin.id }
                pins?.append(pin)
            }
        case .unknown: break
        }
    }

    func clearDistribution() { uploads = nil; pins = nil; mounts = nil }

    func refreshDistribution(using client: any DaemonClient) async throws {
        uploads = try await client.uploads()
        pins = try await client.listPins(driveId: nil)
        mounts = try await client.listMounts()
        if let mounts {
            for i in drives.indices {
                let mount = mounts.first { $0.driveId == drives[i].driveId }
                drives[i].mountPath = mount?.mountpoint
                drives[i].mountState = mount == nil ? .unmounted : .mounted
            }
        }
    }

    func setPin(driveId: String, path: String, pinned: Bool) {
        run(driveId: driveId) { try await $0.pin(driveId: driveId, path: path, pinned: pinned) }
    }

    func workspaceRequest(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> JSONValue {
        guard !usingMock, isSignedIn else { throw DaemonClientError.notConnected }
        return try await client.apiRequest(method: method, path: path, body: body)
    }

    func searchFiles(driveId: String, query: String, cursor: String?) async throws -> FileSearchPage {
        guard !usingMock, isSignedIn || hasDevToken else { throw DaemonClientError.notConnected }
        return try await client.searchFiles(driveId: driveId, query: query, cursor: cursor)
    }

    func retrySavedSignIn() {
        guard canRetrySignIn, !retryingSavedSignIn, !usingMock else { return }
        retryingSavedSignIn = true
        Task {
            defer { retryingSavedSignIn = false }
            do {
                try await client.authRetryRestore()
                canRetrySignIn = false
                await refresh()
            } catch { lastError = "Could not retry saved sign-in: \(LogFormat.describe(error))" }
        }
    }

    // MARK: sign in / out

    func signIn(switchAccount: Bool = false) {
        guard !signingIn else { return }
        guard let api = AppSettings.validateEndpoint(AppSettings.apiEndpoint) else {
            lastError = "Set your API endpoint in Settings → Advanced → Connection overrides, or use an app build configured for your service. HTTPS is required except for localhost."
            return
        }
        signingIn = true
        notice = nil
        signInTask = Task {
            defer { signingIn = false; signInTask = nil }
            do {
                let session = try await auth.signIn(api: api, switchAccount: switchAccount)
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
            } catch is CancellationError {
            } catch let error as URLError where error.code == .cancelled {
            } catch {
                lastError = "Sign-in failed: \(LogFormat.describe(error))"
                Log.auth.error("sign-in failed: \(LogFormat.describe(error))")
            }
            await refresh()
        }
    }

    func openSignInBrowser() {
        if !auth.openBrowser() { lastError = "Sign-in is still preparing. Wait a moment, then try Open browser again." }
    }

    func cancelSignIn() { signInTask?.cancel(); auth.cancel() }

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
        guard !copyingFile else { lastError = "Wait for the selected file to finish copying before signing out."; return }
        Task { await performSignOut() }
    }

    /// Asks for confirmation, then starts a browser sign-in that makes the web forget its own session
    /// (`switch=1`) so another account can be chosen. The current session stays until the new one
    /// replaces it, so cancelling leaves the user signed in.
    func useDifferentAccount() {
        guard !signingIn else { return }
        guard !copyingFile else { lastError = "Wait for the selected file to finish copying before switching accounts."; return }
        let alert = NSAlert()
        alert.messageText = "Use a different account?"
        alert.informativeText = "Your browser opens so you can choose another account. \(account?.email ?? "This account") stays signed in on this Mac until you finish; if you cancel, nothing changes. Files already saved to the cloud are not affected."
        alert.addButton(withTitle: "Continue in Browser")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        // The daemon replaces the session when the new one arrives (`auth.set` unmounts and
        // resets a different user's state), so the current account is kept until then.
        signIn(switchAccount: true)
    }

    private func performSignOut() async {
        let c = client
        do { try await c.authSignOut() }
        catch {
            let message = "Could not finish signing out: \(LogFormat.describe(error))"
            await refresh()
            if !usingMock && !isSignedIn { handoff.discardPending() }
            lastError = message
            Log.auth.error("auth.signOut failed: \(LogFormat.describe(error))")
            return
        }
        handoff.discardPending()
        try? keychain.delete(account: Keychain.Account.devToken)
        account = nil
        drives = []
        transfers = []
        lastConflict = nil
        notice = nil
        await refresh()
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

    func refreshPermissions() async {
        engineInstall = DaemonLifecycle.state()
        let login = AccessStatus.loginItem(SMAppService.mainApp.status)
        let notifications = AccessStatus.notifications(await conflictNotifications.authorizationStatus())
        if loginAccess != login { permissionMessage = nil }
        if notificationAccess != notifications { notificationMessage = nil }
        loginAccess = login
        notificationAccess = notifications
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            try LaunchAtLogin.set(enabled)
            loginAccess = .loginItem(SMAppService.mainApp.status)
            permissionMessage = loginAccess == .needsApproval
                ? "Review Unlispace in System Settings → General → Login Items."
                : enabled ? "Launch at login enabled." : "Launch at login disabled."
        } catch {
            loginAccess = .loginItem(SMAppService.mainApp.status)
            permissionMessage = "Could not change launch at login: \(LogFormat.describe(error))"
        }
    }

    func enableConflictNotifications() async {
        guard !requestingNotifications else { return }
        requestingNotifications = true
        permissionMessage = nil
        defer { requestingNotifications = false }
        let feedback: String
        do {
            let allowed = try await conflictNotifications.enable()
            feedback = allowed ? "Conflict notifications enabled." : "You can enable alerts in System Settings → Notifications → Unlispace."
        } catch {
            feedback = "Could not enable notifications: \(LogFormat.describe(error))"
        }
        await refreshPermissions()
        notificationMessage = feedback
    }

    func mount(_ d: DriveInfo) { run(driveId: d.driveId) { try await $0.mount(driveId: d.driveId) } }
    func unmount(_ d: DriveInfo) { run(driveId: d.driveId) { try await $0.unmount(driveId: d.driveId) } }

    func isDriveBusy(_ drive: DriveInfo) -> Bool {
        pendingDriveActions.contains(drive.driveId) || drive.mountState == .mounting || drive.mountState == .unmounting
    }

    private func run(driveId: String, _ op: @escaping @Sendable (any DaemonClient) async throws -> Void) {
        guard !usingMock, !pendingDriveActions.contains(driveId) else { return }
        if let drive = drives.first(where: { $0.driveId == driveId }), isDriveBusy(drive) { return }
        pendingDriveActions.insert(driveId)
        let c = client
        Task {
            defer { pendingDriveActions.remove(driveId) }
            do { try await op(c); await refresh() }
            catch { lastError = LogFormat.describe(error); Log.app.error("daemon op failed: \(LogFormat.describe(error))") }
        }
    }

    func openInFinder(_ d: DriveInfo) {
        guard !usingMock, d.mountState == .mounted, let p = d.mountPath else { return }
        if NSWorkspace.shared.open(URL(fileURLWithPath: p)) {
            activation.finderOpened = true
            saveActivation()
        } else {
            lastError = "Finder could not open this drive. Refresh its connection and try again."
        }
    }

    func dismissActivation(_ dismissed: Bool) {
        activation.dismissed = dismissed
        saveActivation()
    }

    private func saveActivation() { activation.save(accountID: account?.id, defaults: activationDefaults) }

    /// Only an actual upload event advances file milestones. An empty queue does not.
    private func recordUpload(_ transfer: TransferInfo) {
        guard !usingMock, isSignedIn, !sessionPending, transfer.direction == .upload,
              drives.contains(where: { $0.driveId == transfer.driveId }) else { return }
        if transfer.status != .failed {
            activation.fileAdded = true
            if transfer.status == .done { activation.cloudSaveConfirmed = true }
            saveActivation()
        }
        recentUploads.removeAll { $0.id == transfer.id }
        if transfer.isFinished { recentUploads.insert(transfer, at: 0) }
        recentUploads = Array(recentUploads.prefix(5))
    }

    func addFile(to drive: DriveInfo) {
        guard !usingMock, isSignedIn, !isDriveBusy(drive), !copyingFile,
              drive.mountState == .mounted, let mountPath = drive.mountPath,
              mounts?.first(where: { $0.driveId == drive.driveId })?.readOnly != true else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Copy to drive"
        panel.message = "Choose one file to copy into \(drive.name). The original stays where it is. Unlispace uploads the copy to your configured service; follow its cloud save in Transfers."
        guard panel.runModal() == .OK, let source = panel.url else { return }
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init)
        let alert = NSAlert()
        alert.messageText = "Copy \(source.lastPathComponent) to \(drive.name)?"
        alert.informativeText = "\(CopyConfirmation.details(name: source.lastPathComponent, size: size, driveName: drive.name))"
        alert.addButton(withTitle: "Copy")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        copyFile(source, to: drive, mountPath: mountPath)
    }

    /// Copy only the selected file, refuse replacement, and leave cloud acknowledgement to events.
    func copyFile(_ source: URL, to drive: DriveInfo, mountPath: String) {
        guard !usingMock, isSignedIn, !copyingFile, !isDriveBusy(drive),
              drive.mountState == .mounted, drive.mountPath == mountPath,
              mounts?.first(where: { $0.driveId == drive.driveId })?.readOnly != true,
              let destination = DeepLink.resolve(mountPath: mountPath, path: source.lastPathComponent) else { return }
        copyingFile = true
        pendingDriveActions.insert(drive.driveId)
        copyMessage = "Copying \(source.lastPathComponent) to \(drive.name)… The original stays where it is."
        let owner = account?.id
        let scoped = source.startAccessingSecurityScopedResource()
        Task {
            defer {
                if scoped { source.stopAccessingSecurityScopedResource() }
                copyingFile = false
                pendingDriveActions.remove(drive.driveId)
            }
            do {
                try await Task.detached(priority: .userInitiated) {
                    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                    guard values.isRegularFile == true, values.isSymbolicLink != true else {
                        throw CocoaError(.fileReadUnsupportedScheme)
                    }
                    // copyItem refuses an existing destination. Never silently replace a user's file.
                    try FileManager.default.copyItem(at: source, to: destination)
                }.value
                guard owner == account?.id else { return }
                activation.fileAdded = true
                saveActivation()
                copyMessage = "\(source.lastPathComponent) copied to \(drive.name). The original is unchanged. Check Transfers for cloud confirmation."
            } catch {
                guard owner == account?.id else { return }
                copyMessage = "Could not finish copying \(source.lastPathComponent). The original is unchanged. Check the destination before retrying. \(LogFormat.describe(error))"
            }
        }
    }

    // MARK: uls:// URLs

    func handle(url: URL) {
        do {
            switch try DeepLink.parse(url) {
            case .authCallback:
                if !auth.receiveCallback(url) { Log.auth.info("ignoring unmatched auth callback") }
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

    /// `config.set` with `uploadBandwidthBps` (0 = unlimited). Older engines reject it; the control is then disabled.
    func setUploadLimit(_ bps: Int64) {
        guard !usingMock, !uploadLimitUnsupported else { return }
        let c = client
        Task {
            do {
                try await c.setConfig(DaemonConfig(uploadBandwidthBps: bps))
                uploadBandwidthBps = bps
                uploadLimitMessage = nil
            } catch {
                if UploadLimit.isUnsupported(error) { uploadLimitUnsupported = true }
                else { uploadLimitMessage = "Could not change the upload limit: \(LogFormat.describe(error))" }
            }
            await refresh()
        }
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
