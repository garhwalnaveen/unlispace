import Foundation

/// Text for the confirm-before-copy dialog.
public enum CopyConfirmation {
    public static func details(name: String, size: Int64?, driveName: String) -> String {
        let sizeText = size.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "unknown size"
        return "File: \(name)\nSize: \(sizeText)\nDestination drive: \(driveName)\n\nThe original stays where it is."
    }
}

/// Upload speed limit choices (MB/s = 1,000,000 bytes/s; 0 = unlimited).
public enum UploadLimit {
    public static let options: [(title: String, bps: Int64)] = [
        ("Off", 0), ("1 MB/s", 1_000_000), ("5 MB/s", 5_000_000), ("10 MB/s", 10_000_000), ("25 MB/s", 25_000_000),
    ]

    /// Nearest listed option for a value reported by the engine, so the picker always has a selection.
    public static func option(for bps: Int64) -> Int64 {
        if bps <= 0 { return 0 }
        return options.dropFirst().min { abs($0.bps - bps) < abs($1.bps - bps) }?.bps ?? 0
    }

    /// True when an older engine does not know the parameter.
    public static func isUnsupported(_ error: Error) -> Bool {
        guard case DaemonClientError.remote(let e) = error else { return false }
        let m = e.message.lowercased()
        return e.code == "bad_request" || e.code == "unsupported" || e.isUnknownMethod
            || m.contains("unknown field") || m.contains("unsupported")
    }
}

/// A queue entry and its matching event describe the same file activity.
public struct TransferActivity: Sendable {
    public var pending: PendingUpload?
    public var transfer: TransferInfo?

    public static func list(pending: [PendingUpload], transfers: [TransferInfo], recentUploads: [TransferInfo]) -> [TransferActivity] {
        let allEvents = transfers + recentUploads.filter { recent in !transfers.contains { $0.id == recent.id } }
        var events = allEvents.filter { event in
            guard event.direction == .upload, event.path == "/", event.status == .queued || event.status == .done else { return true }
            if pending.contains(where: { $0.driveId == event.driveId }) { return false }
            return event.status != .done || !allEvents.contains {
                $0.driveId == event.driveId && $0.direction == .upload && $0.path != "/" && $0.status == .done
            }
        }
        var rows = pending.map { upload in
            let index = events.firstIndex { $0.direction == .upload && $0.driveId == upload.driveId && $0.path == upload.path }
            return TransferActivity(pending: upload, transfer: index.map { events.remove(at: $0) })
        }
        rows += events.map { TransferActivity(pending: nil, transfer: $0) }
        return rows
    }
}
