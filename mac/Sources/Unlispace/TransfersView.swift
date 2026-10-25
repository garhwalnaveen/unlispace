import SwiftUI
import UnlispaceKit

struct TransfersView: View {
    var transfers: [TransferInfo]
    var uploads: UploadsSnapshot? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Transfers").font(.headline).accessibilityAddTraits(.isHeader)
                if let uploads {
                    let used = ByteCountFormatter.string(fromByteCount: uploads.journalBytes, countStyle: .file)
                    let cap = ByteCountFormatter.string(fromByteCount: uploads.journalCapBytes, countStyle: .file)
                    Text("Journal: \(used) of \(cap)").font(.caption)
                    ProgressView(value: min(1, max(0, Double(uploads.journalBytes) / Double(max(1, uploads.journalCapBytes)))))
                        .accessibilityLabel("Journal usage")
                    if uploads.journalBytes >= uploads.journalCapBytes { Text("Journal full. Waiting for uploads.").foregroundStyle(.orange) }
                    ForEach(Array(uploads.pending.enumerated()), id: \.offset) { _, upload in
                        Label("Queued: \(upload.path) (\(upload.driveId)) · \(ByteCountFormatter.string(fromByteCount: upload.bytes, countStyle: .file))", systemImage: "arrow.up")
                            .font(.caption)
                    }
                }
                if transfers.isEmpty && (uploads?.pending.isEmpty ?? true) {
                    Text("No transfers in progress.").foregroundStyle(.secondary)
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
                                Text(progressText(transfer)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(width: 340)
        .frame(maxHeight: 400)
    }

    private func progressText(_ transfer: TransferInfo) -> String {
        let done = ByteCountFormatter.string(fromByteCount: max(0, transfer.bytesDone), countStyle: .file)
        guard transfer.bytesTotal > 0 else { return "\(transfer.status.rawValue.capitalized) · \(done)" }
        let total = ByteCountFormatter.string(fromByteCount: transfer.bytesTotal, countStyle: .file)
        return "\(transfer.status.rawValue.capitalized) · \(done) of \(total)"
    }
}
