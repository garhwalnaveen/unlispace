import Foundation

/// App-level state shown by the menu-bar icon.
public enum AppStatus: Sendable, Equatable {
    case signedOut
    case idle
    case syncing
    case offline
    case error
    case engineMissing

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
        case .error, .engineMissing: return "exclamationmark.icloud"
        }
    }

    public var title: String {
        switch self {
        case .signedOut: return "Signed out"
        case .idle: return "Connected"
        case .syncing: return "Syncing"
        case .offline: return "Offline"
        case .error: return "Error"
        case .engineMissing: return "Engine not installed"
        }
    }
}

public enum TransferSummary {
    public static func phase(for transfer: TransferInfo) -> String {
        switch (transfer.direction, transfer.status) {
        case (.upload, .queued): "Saved locally · Queued"
        case (.upload, .active): "Uploading"
        case (.upload, .done): "Saved to cloud"
        case (.upload, .failed): "Upload failed"
        case (.download, .queued): "Download queued"
        case (.download, .active): "Downloading"
        case (.download, .done): "Downloaded"
        case (.download, .failed): "Download failed"
        }
    }

    public static func uploadTitle(uploads: UploadsSnapshot?, transfers: [TransferInfo], state: AppStatus, available: Bool, recentUploads: [TransferInfo] = []) -> String {
        guard available else { return "Connect to see transfers" }
        if state == .offline { return "Offline · Cloud save not confirmed" }
        if state == .error || state == .signedOut || state == .engineMissing { return "Check your connection" }
        if (transfers + recentUploads).contains(where: { $0.direction == .upload && $0.status == .failed }) { return "A recent upload failed" }
        if transfers.contains(where: { $0.direction == .upload && $0.status == .active }) { return "Uploading" }
        guard let uploads else { return "Upload status unavailable" }
        if !uploads.pending.isEmpty { return "Saved locally · Waiting to upload" }
        if state == .syncing { return "Checking cloud save…" }
        return "No uploads pending"
    }

    /// One-line progress text, or nil if nothing is in flight.
    public static func line(for transfers: [TransferInfo]) -> String? {
        let active = transfers.filter { !$0.isFinished }
        guard !active.isEmpty else { return nil }
        let done = active.reduce(Int64(0)) { $0 + $1.bytesDone }
        let total = active.reduce(Int64(0)) { $0 + $1.bytesTotal }
        let fmt = ByteCountFormatter()
        fmt.countStyle = .file
        let noun = active.count == 1 ? "file" : "files"
        if total > 0 {
            return "\(active.count) \(noun): \(fmt.string(fromByteCount: done)) of \(fmt.string(fromByteCount: total))"
        }
        return "\(active.count) \(noun) transferring"
    }
}
