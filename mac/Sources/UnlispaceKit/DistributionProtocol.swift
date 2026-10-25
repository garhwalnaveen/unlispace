import Foundation

public struct PendingUpload: Codable, Sendable, Equatable {
    public var driveId: String
    public var path: String
    public var bytes: Int64
    public init(driveId: String, path: String, bytes: Int64) {
        self.driveId = driveId; self.path = path; self.bytes = bytes
    }
}

public struct UploadsSnapshot: Codable, Sendable, Equatable {
    public var pending: [PendingUpload]
    public var journalBytes: Int64
    public var journalCapBytes: Int64
    public init(pending: [PendingUpload], journalBytes: Int64, journalCapBytes: Int64) {
        self.pending = pending; self.journalBytes = journalBytes; self.journalCapBytes = journalCapBytes
    }
}

public struct OfflinePin: Codable, Sendable, Equatable, Identifiable {
    public var driveId: String
    public var path: String
    public var bytes: Int64
    public var cachedBytes: Int64
    public var id: String { driveId + "\u{0}" + path }
    public var progress: Double { bytes > 0 ? min(1, max(0, Double(cachedBytes) / Double(bytes))) : 1 }
    public init(driveId: String, path: String, bytes: Int64, cachedBytes: Int64) {
        self.driveId = driveId; self.path = path; self.bytes = bytes; self.cachedBytes = cachedBytes
    }
}

public struct DaemonMount: Codable, Sendable, Equatable {
    public var driveId: String
    public var mountpoint: String
    public var readOnly: Bool
    // Keep adapter a string so future adapters don't break decoding.
    public var adapter: String
    public init(driveId: String, mountpoint: String, readOnly: Bool, adapter: String) {
        self.driveId = driveId; self.mountpoint = mountpoint; self.readOnly = readOnly; self.adapter = adapter
    }
}

public extension DaemonClient {
    func uploads() async throws -> UploadsSnapshot? { nil }
    func listPins(driveId: String? = nil) async throws -> [OfflinePin]? { nil }
    func listMounts() async throws -> [DaemonMount]? { nil }
    func pin(driveId: String, path: String, pinned: Bool) async throws {
        throw DaemonClientError.remote(DaemonError(code: "unknown_method", message: "drive.pin unavailable"))
    }
}

/// Fail closed if status is missing. Older daemons can omit the optional uploads method.
public enum UpdateSafety {
    public static func canInstall(status: DaemonStatus?, uploads: UploadsSnapshot?) -> Bool {
        guard let pending = status?.pendingOps else { return false }
        return pending == 0 && (uploads?.pending.isEmpty ?? true)
    }
}

public extension DaemonError {
    var isUnknownMethod: Bool {
        code == "unknown_method" || code == "method_not_found" ||
            (code == "bad_request" && message.lowercased().contains("unknown method"))
    }
}
