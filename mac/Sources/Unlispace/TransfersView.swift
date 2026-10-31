import SwiftUI
import UnlispaceKit

struct TransfersView: View {
    var transfers: [TransferInfo]
    var uploads: UploadsSnapshot? = nil
    var recentUploads: [TransferInfo] = []
    var state: AppStatus = .idle

    var embedded = false
    var available = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !embedded { Text("Transfers").font(.headline).accessibilityAddTraits(.isHeader) }
                Text(TransferSummary.uploadTitle(uploads: uploads, transfers: transfers, state: state, available: available, recentUploads: recentUploads)).font(.headline)
                Text("A file can be saved on this Mac before its cloud upload finishes. Saved to cloud appears only after the engine reports a completed upload.")
                    .font(.callout).foregroundStyle(AppDesign.muted)
                if !available {
                    ContentUnavailableView("Connect to see transfers", systemImage: "arrow.up.arrow.down", description: Text("Sign in and connect the engine to follow your file transfers."))
                }
                if let uploads {
                    let used = ByteCountFormatter.string(fromByteCount: uploads.journalBytes, countStyle: .file)
                    let cap = ByteCountFormatter.string(fromByteCount: uploads.journalCapBytes, countStyle: .file)
                    Text("Local upload storage: \(used) of \(cap)").font(.caption)
                    Text("Storage used by the upload journal is not a count of files waiting to upload.")
                        .font(.caption).foregroundStyle(AppDesign.muted)
                    ProgressView(value: min(1, max(0, Double(uploads.journalBytes) / Double(max(1, uploads.journalCapBytes)))))
                        .accessibilityLabel("Pending local storage usage")
                    if uploads.journalBytes >= uploads.journalCapBytes { Text("Local storage is full. Waiting for uploads to finish.").foregroundStyle(.orange) }
                    ForEach(Array(uploads.pending.enumerated()), id: \.offset) { _, upload in
                        pendingRow(upload)
                    }
                }
                if available && uploads == nil {
                    Text("This engine does not provide an upload-queue snapshot. Refresh or update the engine to check pending saves; an empty activity list does not confirm cloud sync.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                }
                if available && transfers.isEmpty && uploads?.pending.isEmpty == true && state == .idle && !recentUploads.contains(where: { $0.status == .failed }) {
                    ContentUnavailableView("No transfers in progress", systemImage: "arrow.up.arrow.down", description: Text("Add a file to a mounted drive in Finder. Completed uploads appear below when observed."))
                } else {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(transfers) { transfer in
                            VStack(alignment: .leading, spacing: 6) {
                                Label(transfer.path, systemImage: transfer.direction == .upload ? "arrow.up" : "arrow.down")
                                    .lineLimit(2)
                                if let progress = transfer.progress {
                                    ProgressView(value: progress)
                                        .accessibilityLabel("\(transfer.direction.rawValue) \(transfer.path)")
                                        .accessibilityValue("\(Int(progress * 100)) percent, \(transfer.status.rawValue)")
                                } else {
                                    ProgressView()
                                        .accessibilityLabel("\(transfer.direction.rawValue) \(transfer.path), \(transfer.status.rawValue)")
                                }
                                Text(progressText(transfer)).font(.caption).foregroundStyle(AppDesign.muted)
                            }
                        }
                    }
                }
                if !recentUploads.isEmpty {
                    Text("Recent uploads in this session").font(.headline)
                    ForEach(recentUploads) { upload in
                        Label("\(TransferSummary.phase(for: upload)): \(upload.path)", systemImage: upload.status == .done ? "checkmark.icloud" : "exclamationmark.icloud")
                            .font(.callout).foregroundStyle(upload.status == .done ? Color.primary : Color.red)
                    }
                }
            }
        }
        .padding(embedded ? 0 : 20)
        .frame(width: embedded ? nil : 340)
        .frame(maxWidth: embedded ? .infinity : nil)
        .frame(minHeight: embedded ? 280 : nil, maxHeight: embedded ? nil : 400)
    }

    @ViewBuilder private func pendingRow(_ upload: PendingUpload) -> some View {
        let size = ByteCountFormatter.string(fromByteCount: upload.bytes, countStyle: .file)
        switch upload.stage {
        case .uploading:
            VStack(alignment: .leading, spacing: 4) {
                Label("Uploading · \(upload.path) · \(size)", systemImage: "arrow.up.circle").font(.caption)
                if let progress = upload.uploadProgress {
                    ProgressView(value: progress)
                        .accessibilityLabel("Uploading \(upload.path)")
                        .accessibilityValue("\(Int(progress * 100)) percent")
                } else {
                    ProgressView().controlSize(.small).accessibilityLabel("Uploading \(upload.path)")
                }
            }
        case .savedLocally:
            Label("Saved locally, waiting to upload · \(upload.path) · \(size)", systemImage: "internaldrive").font(.caption)
        case .unknown:
            Label("Saved locally · \(upload.path) · \(size)", systemImage: "arrow.up").font(.caption)
        }
    }

    private func progressText(_ transfer: TransferInfo) -> String {
        let done = ByteCountFormatter.string(fromByteCount: max(0, transfer.bytesDone), countStyle: .file)
        guard transfer.bytesTotal > 0 else { return "\(TransferSummary.phase(for: transfer)) · \(done)" }
        let total = ByteCountFormatter.string(fromByteCount: transfer.bytesTotal, countStyle: .file)
        return "\(TransferSummary.phase(for: transfer)) · \(done) of \(total)"
    }
}
