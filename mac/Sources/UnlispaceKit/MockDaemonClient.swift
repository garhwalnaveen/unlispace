import Foundation

/// In-memory daemon used when the real socket is absent. Mounting is simulated.
public actor MockDaemonClient: DaemonClient {
    private var drives: [DriveInfo]
    private var state: EngineState
    private var activeTransfers: [TransferInfo] = []
    private var offlinePins: [OfflinePin] = []
    private var uploadSnapshot = UploadsSnapshot(pending: [], journalBytes: 0, journalCapBytes: 10 * 1024 * 1024 * 1024)
    private var user: AuthUser?
    private var apiEndpoint: String?
    private let demoEmail: String
    private var subscribers: [UUID: AsyncStream<DaemonEvent>.Continuation] = [:]

    public init(drives: [DriveInfo]? = nil, state: EngineState = .idle, signedInAs email: String? = nil,
                demoEmail: String = "demo@unlispace.local") {
        self.demoEmail = demoEmail
        if let email { self.user = AuthUser(id: "u_mock", email: email) }
        self.drives = drives ?? [
            DriveInfo(driveId: "demo", name: "Demo Drive", mountState: .unmounted),
            DriveInfo(driveId: "work", name: "Work", mountState: .unmounted),
        ]
        self.state = state
    }

    public func connect() async throws {}
    public func disconnect() async {
        for (_, c) in subscribers { c.finish() }
        subscribers = [:]
    }

    public func status() async throws -> DaemonStatus {
        let state = user == nil && self.state == .idle ? EngineState.signedOut : self.state
        return DaemonStatus(version: "mock", state: state, message: "Mock engine", pendingOps: activeTransfers.count + uploadSnapshot.pending.count)
    }

    public func listDrives() async throws -> [DriveInfo] { drives }

    public func mount(driveId: String) async throws {
        try setMount(driveId, .mounted, path: "/Volumes/" + (drives.first { $0.driveId == driveId }?.name ?? driveId))
    }

    public func unmount(driveId: String) async throws {
        try setMount(driveId, .unmounted, path: nil)
    }

    private func setMount(_ id: String, _ ms: MountState, path: String?) throws {
        guard let i = drives.firstIndex(where: { $0.driveId == id }) else {
            throw DaemonClientError.remote(DaemonError(code: "no_such_drive", message: id))
        }
        drives[i].mountState = ms
        drives[i].mountPath = path
        emit(.state(StateEvent(state: state)))
    }

    public func transfers() async throws -> [TransferInfo] { activeTransfers }

    public func uploads() async throws -> UploadsSnapshot? { uploadSnapshot }
    public func setUploads(_ snapshot: UploadsSnapshot) { uploadSnapshot = snapshot }
    public func listPins(driveId: String? = nil) async throws -> [OfflinePin]? {
        offlinePins.filter { driveId == nil || $0.driveId == driveId }
    }
    public func listMounts() async throws -> [DaemonMount]? {
        drives.compactMap { d in
            d.mountPath.map { DaemonMount(driveId: d.driveId, mountpoint: $0, readOnly: false, adapter: "smb") }
        }
    }
    public func pin(driveId: String, path: String, pinned: Bool) async throws {
        offlinePins.removeAll { $0.driveId == driveId && $0.path == path }
        if pinned { pushPin(OfflinePin(driveId: driveId, path: path, bytes: 0, cachedBytes: 0)) }
    }
    public func pushPin(_ pin: OfflinePin) {
        offlinePins.removeAll { $0.id == pin.id }
        offlinePins.append(pin)
        emit(.pin(pin))
    }

    public private(set) var lastConfig: DaemonConfig?
    public func setConfig(_ config: DaemonConfig) async throws { lastConfig = config }

    public func authSet(_ params: AuthSetParams) async throws -> AuthSetResult {
        guard !params.accessToken.isEmpty, !params.refreshToken.isEmpty else {
            throw DaemonClientError.remote(DaemonError(code: "bad_request", message: "empty token"))
        }
        let u = AuthUser(id: "u_mock", email: demoEmail)
        user = u
        apiEndpoint = params.apiEndpoint
        state = .idle
        emit(.state(StateEvent(state: .idle)))
        return AuthSetResult(user: u)
    }

    public func authStatus() async throws -> AuthStatus {
        AuthStatus(signedIn: user != nil, user: user, apiEndpoint: user == nil ? nil : apiEndpoint)
    }

    public func authSignOut() async throws {
        user = nil
        apiEndpoint = nil
        for i in drives.indices { drives[i].mountState = .unmounted; drives[i].mountPath = nil }
        state = .signedOut
        emit(.state(StateEvent(state: .signedOut)))
    }

    public func pushChange(_ c: ChangeEvent) { emit(.change(c)) }

    public func setState(_ s: EngineState) {
        state = s
        emit(.state(StateEvent(state: s)))
    }

    public func pushTransfer(_ t: TransferInfo) {
        activeTransfers.removeAll { $0.id == t.id }
        if !t.isFinished { activeTransfers.append(t) }
        emit(.transfer(t))
    }

    private func emit(_ e: DaemonEvent) {
        for (_, c) in subscribers { c.yield(e) }
    }

    nonisolated public func events() -> AsyncStream<DaemonEvent> {
        AsyncStream { continuation in
            let key = UUID()
            Task { await self.add(key, continuation) }
            continuation.onTermination = { _ in Task { await self.remove(key) } }
        }
    }

    private func add(_ k: UUID, _ c: AsyncStream<DaemonEvent>.Continuation) { subscribers[k] = c }
    private func remove(_ k: UUID) { subscribers.removeValue(forKey: k) }
}
