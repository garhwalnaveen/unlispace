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
    func setConfig(_ config: DaemonConfig) async throws
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
            .appendingPathComponent("Unlispace", isDirectory: true)
    }
    public static var socketURL: URL { supportDirectory.appendingPathComponent("ulsd.sock") }
    public static var logsDirectory: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Unlispace", isDirectory: true)
    }
}
