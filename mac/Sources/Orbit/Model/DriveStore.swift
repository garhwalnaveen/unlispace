import AppKit
import Observation
import OrbitKit

/// Drives, their mounts, and offline pins, plus the actions that change them.
/// Lookups by drive id are indexed so rows stay cheap when an account has many drives.
@MainActor @Observable
final class DriveStore {
    private(set) var drives: [DriveInfo] = []
    /// Nil when the engine does not report mounts or pins (older engines).
    private(set) var mounts: [DaemonMount]?
    private(set) var pins: [OfflinePin]?
    private(set) var pendingActions: Set<String> = []
    private(set) var copyingFile = false

    @ObservationIgnored private var driveIndex: [String: Int] = [:]
    @ObservationIgnored private var mountIndex: [String: DaemonMount] = [:]
    @ObservationIgnored private var pinList = IndexedList<OfflinePin>()
    @ObservationIgnored private var pinsByDrive: [String: [OfflinePin]] = [:]

    @ObservationIgnored private let engine: EngineLink
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let messages: AppMessages
    @ObservationIgnored private let activation: ActivationStore
    @ObservationIgnored private let prompts: any UserPrompts

    init(engine: EngineLink, session: SessionStore, messages: AppMessages, activation: ActivationStore, prompts: any UserPrompts) {
        self.engine = engine
        self.session = session
        self.messages = messages
        self.activation = activation
        self.prompts = prompts
    }

    // MARK: State

    var mountedCount: Int { drives.reduce(0) { $0 + ($1.mountState == .mounted ? 1 : 0) } }
    var hasTransition: Bool {
        !pendingActions.isEmpty || drives.contains { $0.mountState == .mounting || $0.mountState == .unmounting }
    }

    func drive(id: String) -> DriveInfo? { driveIndex[id].map { drives[$0] } }
    func mount(for driveID: String) -> DaemonMount? { mountIndex[driveID] }
    func isReadOnly(_ driveID: String) -> Bool { mountIndex[driveID]?.readOnly == true }
    func pins(for driveID: String) -> [OfflinePin] { pinsByDrive[driveID] ?? [] }
    func isKeptOffline(_ driveID: String) -> Bool { pinList[driveID + "\u{0}/"] != nil }

    func isBusy(_ drive: DriveInfo) -> Bool {
        pendingActions.contains(drive.driveId) || drive.mountState == .mounting || drive.mountState == .unmounting
    }

    /// Replaces everything from one engine snapshot. A reported mount list is authoritative for mount state.
    func apply(drives newDrives: [DriveInfo], mounts newMounts: [DaemonMount]?, pins newPins: [OfflinePin]?) {
        mounts = newMounts
        mountIndex = Dictionary((newMounts ?? []).map { ($0.driveId, $0) }, uniquingKeysWith: { first, _ in first })
        var merged = newDrives
        if newMounts != nil {
            for index in merged.indices {
                let mount = mountIndex[merged[index].driveId]
                merged[index].mountPath = mount?.mountpoint
                merged[index].mountState = mount == nil ? .unmounted : .mounted
            }
        }
        setDrives(merged)
        setPins(newPins)
    }

    func setDrives(_ newDrives: [DriveInfo]) {
        drives = newDrives
        driveIndex = Dictionary(newDrives.enumerated().map { ($1.driveId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    func setPins(_ newPins: [OfflinePin]?) {
        pinList = IndexedList(newPins ?? [])
        publishPins(supported: newPins != nil)
    }

    /// A pin event only matters once the engine has said it supports pins.
    func apply(_ pin: OfflinePin) {
        guard pins != nil else { return }
        pinList.upsert(pin)
        publishPins(supported: true)
    }

    private func publishPins(supported: Bool) {
        pins = supported ? pinList.elements : nil
        pinsByDrive = Dictionary(grouping: pinList.elements, by: \.driveId)
    }

    func clear() {
        setDrives([])
        mounts = nil
        mountIndex = [:]
        setPins(nil)
    }

    // MARK: Actions

    func mount(_ drive: DriveInfo) { run(drive.driveId) { try await $0.mount(driveId: drive.driveId) } }
    func unmount(_ drive: DriveInfo) { run(drive.driveId) { try await $0.unmount(driveId: drive.driveId) } }

    func setPin(driveId: String, path: String, pinned: Bool) {
        let needsMount = pinned && drive(id: driveId)?.mountState != .mounted
        run(driveId) { client in
            if needsMount { try await client.mount(driveId: driveId) }
            try await client.pin(driveId: driveId, path: path, pinned: pinned)
        }
    }

    /// "Open in Finder" for any drive: one that is not in Finder yet is put there first.
    func open(_ drive: DriveInfo) {
        if drive.mountState == .mounted {
            openInFinder(drive)
            return
        }
        run(drive.driveId, { try await $0.mount(driveId: drive.driveId) }) { [weak self] in
            guard let self, let mounted = self.drive(id: drive.driveId) else { return }
            self.openInFinder(mounted)
        }
    }

    /// One action per drive at a time; the lock is released whether or not the engine accepts it.
    private func run(_ driveID: String, _ operation: @escaping @Sendable (any DaemonClient) async throws -> Void,
                     then: (@MainActor () -> Void)? = nil) {
        guard let client = engine.client, !pendingActions.contains(driveID) else { return }
        if let drive = drive(id: driveID), isBusy(drive) { return }
        pendingActions.insert(driveID)
        Task {
            defer { pendingActions.remove(driveID) }
            do {
                try await operation(client)
                await engine.refresh()
                then?()
            } catch {
                messages.report(Format.problem(error))
                Log.app.error("daemon op failed: \(LogFormat.describe(error))")
            }
        }
    }

    /// Mounts the drives chosen during setup, after checking they still exist.
    func mountSelected(_ ids: Set<String>) async throws {
        guard session.isSignedIn else { throw DaemonClientError.notConnected }
        let client = try engine.connectedClient()
        let available = try await client.listDrives()
        guard ids.isSubset(of: Set(available.map(\.driveId))) else {
            throw DaemonClientError.remote(DaemonError(code: "no_such_drive", message: "The drive list changed. Choose again."))
        }
        for drive in available where ids.contains(drive.driveId) && drive.mountState != .mounted {
            try await client.mount(driveId: drive.driveId)
        }
        await engine.refresh()
    }

    @discardableResult func openInFinder(_ drive: DriveInfo) -> Bool {
        guard engine.isConnected, drive.mountState == .mounted, let path = drive.mountPath else { return false }
        guard NSWorkspace.shared.open(URL(fileURLWithPath: path)) else {
            messages.report("Finder could not open \(drive.name). Eject it, then open it again.")
            return false
        }
        activation.record { $0.finderOpened = true }
        return true
    }

    func canAddFile(to drive: DriveInfo) -> Bool {
        engine.isConnected && session.isSignedIn && !copyingFile && !isBusy(drive)
            && drive.mountState == .mounted && drive.mountPath != nil && !isReadOnly(drive.driveId)
    }

    /// Asks for one file and copies it into the drive after confirmation.
    func addFile(to drive: DriveInfo) {
        guard canAddFile(to: drive), let mountPath = drive.mountPath else { return }
        guard let source = prompts.chooseFile(message: "Choose a file to copy to \(drive.name).", action: "Copy") else { return }
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init)
        guard prompts.confirm(title: "Copy “\(source.lastPathComponent)” to \(drive.name)?",
                              message: CopyConfirmation.details(name: source.lastPathComponent, size: size, driveName: drive.name),
                              action: "Copy") else { return }
        copyFile(source, to: drive, mountPath: mountPath)
    }

    /// Copies one regular file and never replaces an existing one. Upload confirmation comes from engine events.
    func copyFile(_ source: URL, to drive: DriveInfo, mountPath: String) {
        guard canAddFile(to: drive), drive.mountPath == mountPath,
              let destination = DeepLink.resolve(mountPath: mountPath, path: source.lastPathComponent) else { return }
        let name = source.lastPathComponent
        copyingFile = true
        pendingActions.insert(drive.driveId)
        messages.fileCopy = "Copying \(name) to \(drive.name)…"
        let owner = session.account?.id
        let scoped = source.startAccessingSecurityScopedResource()
        Task {
            defer {
                if scoped { source.stopAccessingSecurityScopedResource() }
                copyingFile = false
                pendingActions.remove(drive.driveId)
            }
            do {
                try await Task.detached(priority: .userInitiated) {
                    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                    guard values.isRegularFile == true, values.isSymbolicLink != true else {
                        throw CocoaError(.fileReadUnsupportedScheme)
                    }
                    // copyItem fails if the destination exists, so a file is never replaced.
                    try FileManager.default.copyItem(at: source, to: destination)
                }.value
                guard owner == session.account?.id else { return }
                activation.record { $0.fileAdded = true }
                messages.fileCopy = "Copied \(name) to \(drive.name). Activity shows when it has uploaded."
            } catch {
                guard owner == session.account?.id else { return }
                messages.fileCopy = "Could not copy \(name): \(Format.problem(error))"
            }
        }
    }
}
