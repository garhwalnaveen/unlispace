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
        case .idle: return "Up to date"
        case .syncing: return "Syncing"
        case .offline: return "Offline"
        case .error: return "Error"
        case .engineMissing: return "Engine not installed"
        }
    }
}

public enum TransferSummary {
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
