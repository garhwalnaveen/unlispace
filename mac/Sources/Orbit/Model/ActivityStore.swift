import Observation
import OrbitKit

/// Transfers in flight, the upload queue, and a short history of finished uploads.
@MainActor @Observable
final class ActivityStore {
    /// Finished uploads kept for the activity list. Older ones drop off.
    static let historyLimit = 20

    private(set) var transfers: [TransferInfo] = []
    /// Nil when the engine does not report its upload queue.
    private(set) var uploads: UploadsSnapshot?
    private(set) var recentUploads: [TransferInfo] = []

    @ObservationIgnored private var live = IndexedList<TransferInfo>()

    var hasActiveTransfers: Bool { !transfers.isEmpty }
    var hasFailedUpload: Bool { recentUploads.contains { $0.status == .failed } }
    var progressLine: String? { TransferSummary.line(for: transfers) }
    var items: [TransferActivity] {
        TransferActivity.list(pending: uploads?.pending ?? [], transfers: transfers, recentUploads: recentUploads)
    }

    func apply(transfers new: [TransferInfo], uploads snapshot: UploadsSnapshot?) {
        live.replaceAll(new)
        transfers = live.elements
        uploads = snapshot
    }

    /// A progress event replaces its transfer in place; a finished one leaves the live list.
    /// `countsAsUpload` is false for events that do not belong to a drive of the signed-in account.
    func apply(_ transfer: TransferInfo, countsAsUpload: Bool) {
        if transfer.isFinished { live.remove(id: transfer.id) } else { live.upsert(transfer) }
        transfers = live.elements
        guard countsAsUpload, transfer.direction == .upload else { return }
        recentUploads.removeAll { $0.id == transfer.id }
        if transfer.isFinished {
            recentUploads.insert(transfer, at: 0)
            if recentUploads.count > Self.historyLimit { recentUploads.removeLast(recentUploads.count - Self.historyLimit) }
        }
    }

    func clear() {
        live.replaceAll([])
        transfers = []
        uploads = nil
    }

    func clearHistory() { recentUploads = [] }
}
