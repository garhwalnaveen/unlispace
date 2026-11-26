import AppKit
import Observation
import OrbitKit

/// Owns the stores and the few operations that span more than one of them:
/// applying an engine snapshot, routing engine events, signing out, and opening `uls://` links.
/// Each store owns its own state and actions; views read the store they need.
@MainActor @Observable
final class AppModel: EngineLinkDelegate {
    let engine: EngineLink
    let messages = AppMessages()
    let session: SessionStore
    let activation: ActivationStore
    let drives: DriveStore
    let activity = ActivityStore()
    let permissions = PermissionsStore()
    let config: EngineConfigStore
    let workspaces: WorkspaceDirectory
    let shortcut: ShortcutStore
    let updates = UpdateController()

    private(set) var status: AppStatus = .signedOut
    /// First-run setup was finished (not merely opened). Until then the menu offers to continue it.
    var setupCompleted: Bool { didSet { defaults.set(setupCompleted, forKey: Preference.setupCompleted) } }

    @ObservationIgnored private let prompts: any UserPrompts
    @ObservationIgnored private let defaults: UserDefaults
    /// Opens a web page in the browser. Tests replace it so nothing leaves the process.
    @ObservationIgnored var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    @ObservationIgnored private var reconcileTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard, engine: EngineLink = EngineLink(),
         prompts: any UserPrompts = AppKitPrompts(), keychain: Keychain = Keychain()) {
        self.engine = engine
        self.prompts = prompts
        self.defaults = defaults
        setupCompleted = defaults.bool(forKey: Preference.setupCompleted)
        session = SessionStore(engine: engine, messages: messages, defaults: defaults, keychain: keychain)
        activation = ActivationStore(defaults: defaults)
        drives = DriveStore(engine: engine, session: session, messages: messages, activation: activation, prompts: prompts)
        config = EngineConfigStore(engine: engine, session: session)
        workspaces = WorkspaceDirectory(engine: engine, session: session)
        shortcut = ShortcutStore(defaults: defaults)
        session.onAccountChange = { [weak self] in self?.accountChanged() }
        engine.delegate = self
    }

    func start(onShortcut: @escaping @MainActor () -> Void) {
        updates.start()
        shortcut.start(onPress: onShortcut)
        session.deleteLegacyToken()
        engine.start()
    }

    func refresh() async { await engine.refresh() }

    // MARK: Derived state

    /// The engine is connected and has credentials, so drives and activity are current.
    var isLive: Bool { engine.isConnected && session.hasCredentials }
    /// The engine holds this account's session, so account actions (uploads, workspace requests) work.
    var isAccountLive: Bool { engine.isConnected && session.isSignedIn && !session.sessionPending }

    /// The same sentence the menu-bar panel leads with, so every window agrees on the state.
    var statusTitle: String { headline.title }

    // MARK: Engine snapshot

    func engineWillRefresh() { session.reloadLocalState() }

    func engineDidConnect(_ client: any DaemonClient) async {
        await session.reconcile(with: client)
    }

    /// Reads everything in two rounds of concurrent requests: identity first, then the account's data.
    func engineRefresh(_ client: any DaemonClient) async throws {
        async let statusReply = client.status()
        async let authReply = client.authStatus()
        let (daemon, auth) = try await (statusReply, authReply)
        session.setAccount(auth.signedIn ? auth.user : nil)
        session.setCanRetrySavedSignIn(daemon.canRetrySignIn == true)
        messages.engineMessage = daemon.message
        config.uploadBandwidthBps = daemon.uploadBandwidthBps
        status = AppStatus(engine: daemon.state)
        guard session.hasCredentials else {
            drives.clear()
            activity.clear()
            messages.setRefreshError(nil)
            return
        }
        async let driveReply = client.listDrives()
        async let transferReply = client.transfers()
        async let uploadReply = client.uploads()
        async let pinReply = client.listPins(driveId: nil)
        async let mountReply = client.listMounts()
        let (list, transfers, uploads, pins, mounts) = try await (driveReply, transferReply, uploadReply, pinReply, mountReply)
        drives.apply(drives: list, mounts: mounts, pins: pins)
        activity.apply(transfers: transfers, uploads: uploads)
        messages.setRefreshError(nil)
    }

    func engineRefreshFailed(_ error: Error) {
        status = .error
        messages.setRefreshError(Format.problem(error))
        Log.app.error("refresh failed: \(LogFormat.describe(error))")
    }

    /// Without the engine nothing about drives or transfers is known, so nothing is shown.
    func engineIsUnavailable(error: Error?) {
        session.showLocalAccount()
        drives.clear()
        activity.clear()
        messages.engineMessage = nil
        messages.setRefreshError(nil)
        if !session.hasCredentials { status = .signedOut }
        else { status = engine.install == .notInstalled ? .engineMissing : .engineStopped }
        if let error { Log.app.error("engine connection lost: \(LogFormat.describe(error))") }
    }

    var engineIsBusy: Bool {
        status == .syncing || session.signingIn || activity.hasActiveTransfers || drives.hasTransition
            || activity.uploads?.pending.isEmpty == false
    }

    // MARK: Engine events

    func engineReceived(_ events: [DaemonEvent]) {
        for event in events { apply(event) }
    }

    func apply(_ event: DaemonEvent) {
        switch event {
        case .state(let state):
            let previous = status
            status = AppStatus(engine: state.state)
            messages.engineMessage = state.message
            if state.state == .signedOut {
                session.setAccount(nil)
                drives.clear()
                activity.clear()
                messages.conflict = nil
            }
            if status != previous { reconcileSoon() }
        case .transfer(let transfer):
            let ownUpload = transfer.direction == .upload && isAccountLive && drives.drive(id: transfer.driveId) != nil
            activity.apply(transfer, countsAsUpload: ownUpload)
            if ownUpload { recordFirstUpload(transfer) }
            if transfer.status == .failed {
                messages.report("“\(TransferSummary.fileTitle(path: transfer.path))” didn't finish \(transfer.direction == .upload ? "uploading" : "downloading").")
            }
        case .change(let change):
            let name = drives.drive(id: change.driveId)?.name ?? change.driveId
            messages.lastChange = "\(name): \(change.paths.count) remote change\(change.paths.count == 1 ? "" : "s")"
        case .conflict(let conflict):
            messages.conflict = conflict
            permissions.notify(conflict)
        case .pin(let pin):
            drives.apply(pin)
        case .unknown:
            break
        }
    }

    /// Only a real file counts. The per-drive aggregate (`/`) and Finder metadata do not.
    private func recordFirstUpload(_ transfer: TransferInfo) {
        let name = transfer.path.split(separator: "/").last ?? ""
        guard !name.isEmpty, name != ".DS_Store", !name.hasPrefix("._"), transfer.status != .failed else { return }
        activation.record {
            $0.fileAdded = true
            if transfer.status == .done { $0.cloudSaveConfirmed = true }
        }
    }

    /// State events do not carry drive or mount changes, so follow one with a single delayed refresh.
    private func reconcileSoon() {
        guard engine.isConnected, reconcileTask == nil else { return }
        reconcileTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            self?.reconcileTask = nil
            await self?.engine.refresh()
        }
    }

    // MARK: Account

    private func accountChanged() {
        activation.load(accountID: session.account?.id)
        activity.clearHistory()
        messages.fileCopy = nil
        workspaces.reset()
    }

    func signOut() {
        guard !drives.copyingFile else {
            messages.report("Wait for the file copy to finish before signing out.")
            return
        }
        Task {
            if await session.signOut() {
                drives.clear()
                activity.clear()
                messages.clearForSignOut()
            }
            await engine.refresh()
        }
    }

    /// Starts a browser sign-in that lets the user pick another account.
    /// The current session stays until the new one replaces it, so cancelling changes nothing.
    func useDifferentAccount() {
        guard !session.signingIn else { return }
        guard !drives.copyingFile else {
            messages.report("Wait for the file copy to finish before switching accounts.")
            return
        }
        let current = session.account?.email ?? "This account"
        guard prompts.confirm(title: "Use a different account?",
                              message: "\(current) stays signed in until you finish signing in with the other account.",
                              action: "Continue in Browser") else { return }
        session.signIn(switchAccount: true)
    }

    // MARK: Drive management

    /// Asks first, saying what deleting does, then ejects the drive and deletes it.
    func deleteDrive(_ drive: DriveInfo) {
        guard prompts.confirm(title: "Delete “\(drive.name)”?", message: DriveManagement.deleteWarning(for: drive),
                              action: "Delete Drive") else { return }
        Task {
            do {
                try await workspaces.deleteDrive(drive)
                messages.notice = "“\(drive.name)” was deleted."
            } catch {
                reportDriveChange(error, drive: drive, verb: "delete")
            }
        }
    }

    /// An engine that predates drive management hands the change to the web instead of failing.
    func reportDriveChange(_ error: Error, drive: DriveInfo, verb: String) {
        if DriveManagement.isUnsupported(error), let url = workspaces.config?.drivePage(driveId: drive.driveId) {
            openURL(url)
            messages.notice = "This version of Orbit can't \(verb) a drive from the Mac yet. “\(drive.name)” is open on the web so you can \(verb) it there."
        } else {
            messages.report(DriveManagement.message(for: error, verb: verb))
        }
    }

    // MARK: uls:// links

    func handle(url: URL) {
        do {
            switch try DeepLink.parse(url) {
            case .authCallback:
                if !session.receiveCallback(url) { Log.auth.info("ignoring unmatched auth callback") }
            case .open(let driveId, let path):
                Task { await open(driveId: driveId, path: path) }
            }
        } catch {
            messages.report("Could not open that link: \(Format.problem(error))")
            Log.app.error("rejected url \(LogFormat.url(url)): \(String(describing: error))")
        }
    }

    /// Mounts the drive if needed and opens the path, or its nearest existing parent folder.
    func open(driveId: String, path: String) async {
        guard session.isSignedIn else { messages.report("Sign in to open this link."); return }
        do {
            let client = try engine.connectedClient()
            var list = try await client.listDrives()
            guard var drive = list.first(where: { $0.driveId == driveId }) else {
                messages.report("This account does not have access to that drive.")
                return
            }
            if drive.mountState != .mounted {
                try await client.mount(driveId: driveId)
                list = try await client.listDrives()
                drives.setDrives(list)
                guard let mounted = list.first(where: { $0.driveId == driveId }) else { return }
                drive = mounted
            }
            guard let mountPath = drive.mountPath, let target = DeepLink.resolve(mountPath: mountPath, path: path) else {
                messages.report("That link does not point inside the drive.")
                return
            }
            var url = target
            while !FileManager.default.fileExists(atPath: url.path), url.path.count > mountPath.count {
                url.deleteLastPathComponent()
            }
            NSWorkspace.shared.open(url)
            messages.error = nil
        } catch {
            messages.report(Format.problem(error))
            Log.app.error("open link failed: \(LogFormat.describe(error))")
        }
    }
}
