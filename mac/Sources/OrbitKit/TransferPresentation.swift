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
public struct TransferActivity: Sendable, Identifiable {
    public var pending: PendingUpload?
    public var transfer: TransferInfo?

    public init(pending: PendingUpload?, transfer: TransferInfo?) {
        self.pending = pending
        self.transfer = transfer
    }

    public var id: String {
        if let pending { return "pending\u{0}" + pending.driveId + "\u{0}" + pending.path }
        return "transfer\u{0}" + (transfer?.id ?? "")
    }
    public var path: String { pending?.path ?? transfer?.path ?? "/" }

    private struct Key: Hashable { var driveId: String; var path: String }

    /// Linear in the number of items: every lookup goes through a set or dictionary.
    public static func list(pending: [PendingUpload], transfers: [TransferInfo], recentUploads: [TransferInfo]) -> [TransferActivity] {
        let live = Set(transfers.map(\.id))
        let all = transfers + recentUploads.filter { !live.contains($0.id) }
        let pendingDrives = Set(pending.map(\.driveId))
        var drivesWithUploadedFile = Set<String>()
        for event in all where event.direction == .upload && event.path != "/" && event.status == .done {
            drivesWithUploadedFile.insert(event.driveId)
        }
        // A drive aggregate (`/`) is redundant once its files are listed individually.
        let events = all.filter { event in
            guard event.direction == .upload, event.path == "/", event.status == .queued || event.status == .done else { return true }
            if pendingDrives.contains(event.driveId) { return false }
            return event.status != .done || !drivesWithUploadedFile.contains(event.driveId)
        }
        var uploadsByKey: [Key: [Int]] = [:]
        for (index, event) in events.enumerated().reversed() where event.direction == .upload {
            uploadsByKey[Key(driveId: event.driveId, path: event.path), default: []].append(index)
        }
        var matched = Set<Int>()
        var rows = pending.map { upload -> TransferActivity in
            let index = uploadsByKey[Key(driveId: upload.driveId, path: upload.path)]?.popLast()
            if let index { matched.insert(index) }
            return TransferActivity(pending: upload, transfer: index.map { events[$0] })
        }
        for (index, event) in events.enumerated() where !matched.contains(index) {
            rows.append(TransferActivity(pending: nil, transfer: event))
        }
        return rows
    }
}

/// An ordered collection with constant-time lookup and replacement by id.
/// Engine events update one item at a time, so the lists they feed must not be rescanned per event.
public struct IndexedList<Element: Identifiable>: Sendable where Element: Sendable, Element.ID: Hashable & Sendable {
    public private(set) var elements: [Element] = []
    private var positions: [Element.ID: Int] = [:]

    public init(_ elements: [Element] = []) { replaceAll(elements) }

    public var isEmpty: Bool { elements.isEmpty }
    public var count: Int { elements.count }
    public subscript(id: Element.ID) -> Element? { positions[id].map { elements[$0] } }

    /// Keeps the first position of a repeated id and its last value.
    public mutating func replaceAll(_ new: [Element]) {
        elements = []
        positions = [:]
        elements.reserveCapacity(new.count)
        for element in new { upsert(element) }
    }

    public mutating func upsert(_ element: Element) {
        if let index = positions[element.id] {
            elements[index] = element
        } else {
            positions[element.id] = elements.count
            elements.append(element)
        }
    }

    public mutating func remove(id: Element.ID) {
        guard let index = positions.removeValue(forKey: id) else { return }
        elements.remove(at: index)
        for later in index..<elements.count { positions[elements[later].id] = later }
    }
}

/// How long to wait before the next status poll.
/// Engine events carry live changes; polling only reconciles, so it slows down when nothing is happening
/// and backs off while the engine is unreachable.
public enum PollSchedule {
    public static let active: Duration = .seconds(5)
    public static let idle: Duration = .seconds(20)
    public static let longestRetry: Duration = .seconds(60)

    public static func delay(connected: Bool, busy: Bool, failures: Int) -> Duration {
        if connected { return busy ? active : idle }
        let seconds = 2 << min(max(failures, 0), 5)
        return min(.seconds(seconds), longestRetry)
    }
}
