import Foundation

/// App-level state shown by the menu-bar icon.
public enum AppStatus: Sendable, Equatable {
    case signedOut
    case idle
    case syncing
    case offline
    case error
    /// The app bundle has no engine.
    case engineMissing
    /// The engine is installed but not reachable.
    case engineStopped

    public init(engine: EngineState) {
        switch engine {
        case .signedOut: self = .signedOut
        case .idle: self = .idle
        case .syncing: self = .syncing
        case .offline: self = .offline
        case .error: self = .error
        }
    }

    /// SF Symbol name for the menu-bar icon.
    public var symbolName: String {
        switch self {
        case .signedOut: return "icloud.slash"
        case .idle: return "icloud"
        case .syncing: return "arrow.triangle.2.circlepath.icloud"
        case .offline: return "wifi.slash"
        case .error, .engineMissing, .engineStopped: return "exclamationmark.icloud"
        }
    }

    public var title: String {
        switch self {
        case .signedOut: return "Signed out"
        case .idle: return "Connected"
        case .syncing: return "Syncing"
        case .offline: return "Offline"
        case .error: return "Sync error"
        case .engineMissing: return "Background service not installed"
        case .engineStopped: return "Background service not running"
        }
    }
}

public enum TransferSummary {
    public static func phase(for transfer: TransferInfo) -> String {
        switch (transfer.direction, transfer.status) {
        case (.upload, .queued): "Waiting to upload"
        case (.upload, .active): "Uploading"
        case (.upload, .done): "Uploaded"
        case (.upload, .failed): "Upload failed"
        case (.download, .queued): "Waiting to download"
        case (.download, .active): "Downloading"
        case (.download, .done): "Downloaded"
        case (.download, .failed): "Download failed"
        }
    }

    /// One-line upload state. `available` is false when the engine is not connected or nobody is signed in.
    public static func uploadTitle(uploads: UploadsSnapshot?, transfers: [TransferInfo], state: AppStatus, available: Bool, recentUploads: [TransferInfo] = []) -> String {
        guard available else { return "Not connected" }
        switch state {
        case .offline: return "Offline"
        case .error: return "Sync error"
        case .signedOut, .engineMissing, .engineStopped: return "Not connected"
        case .idle, .syncing: break
        }
        if transfers.contains(where: { $0.direction == .upload && $0.status == .failed })
            || recentUploads.contains(where: { $0.status == .failed }) { return "An upload failed" }
        if transfers.contains(where: { $0.direction == .upload && $0.status == .active }) { return "Uploading" }
        guard let uploads else { return "Upload status unavailable" }
        if !uploads.pending.isEmpty { return "Waiting to upload" }
        if state == .syncing { return "Syncing" }
        return "No uploads pending"
    }

    /// One-line progress text, or nil if nothing is in flight.
    public static func line(for transfers: [TransferInfo]) -> String? {
        var count = 0
        var done: Int64 = 0
        var total: Int64 = 0
        for transfer in transfers where !transfer.isFinished {
            count += 1
            done += transfer.bytesDone
            total += transfer.bytesTotal
        }
        guard count > 0 else { return nil }
        let noun = count == 1 ? "file" : "files"
        guard total > 0 else { return "\(count) \(noun) transferring" }
        let format = ByteCountFormatter()
        format.countStyle = .file
        return "\(count) \(noun): \(format.string(fromByteCount: done)) of \(format.string(fromByteCount: total))"
    }

    /// Row title for a transfer path. `/` is the engine's per-drive aggregate.
    public static func fileTitle(path: String) -> String {
        if path == "/" { return "Drive changes" }
        return path.split(separator: "/").last.map(String.init) ?? path
    }
}
