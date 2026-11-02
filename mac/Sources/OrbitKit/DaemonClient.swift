import Foundation

public protocol DaemonClient: Sendable {
    /// Opens the connection. Throws if the daemon is unreachable.
    func connect() async throws
    func disconnect() async
    func status() async throws -> DaemonStatus
    func listDrives() async throws -> [DriveInfo]
    func mount(driveId: String) async throws
    func unmount(driveId: String) async throws
    func transfers() async throws -> [TransferInfo]
    func uploads() async throws -> UploadsSnapshot?
    func listPins(driveId: String?) async throws -> [OfflinePin]?
    func listMounts() async throws -> [DaemonMount]?
    func pin(driveId: String, path: String, pinned: Bool) async throws
    func apiRequest(method: String, path: String, body: JSONValue?) async throws -> JSONValue
    func searchFiles(driveId: String, query: String, cursor: String?) async throws -> FileSearchPage
    func setConfig(_ config: DaemonConfig) async throws
    /// `auth.set`: hands the M1 session to the daemon, which becomes the only refresh-token holder.
    func authSet(_ params: AuthSetParams) async throws -> AuthSetResult
    func authStatus() async throws -> AuthStatus
    func authSignOut() async throws
    func authRetryRestore() async throws
    /// Server-push events. Finishes when the connection drops.
    func events() -> AsyncStream<DaemonEvent>
}

public enum DaemonClientError: Error, Equatable, Sendable {
    case notConnected
    case socketMissing
    case connectFailed(String)
    case remote(DaemonError)
    case malformedResponse
    case disconnected
}

public enum AppPaths {
    public static var supportDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Orbit", isDirectory: true)
    }
    public static var socketURL: URL { supportDirectory.appendingPathComponent("ulsd.sock") }
    public static var logsDirectory: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Orbit", isDirectory: true)
    }
}

public extension DaemonClient {
    func authRetryRestore() async throws {
        throw DaemonClientError.remote(DaemonError(code: "unsupported", message: "Update the engine to retry saved sign-in."))
    }

    func apiRequest(method: String, path: String, body: JSONValue?) async throws -> JSONValue {
        throw DaemonClientError.remote(DaemonError(code: "unsupported", message: "Update the engine to manage workspaces."))
    }
    func searchFiles(driveId: String, query: String, cursor: String?) async throws -> FileSearchPage {
        throw DaemonClientError.remote(DaemonError(code: "unsupported", message: "Update the engine to search files."))
    }
}
