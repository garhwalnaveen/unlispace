import SwiftUI
import UnlispaceKit

struct TransfersView: View {
    var transfers: [TransferInfo]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Transfers").font(.headline).accessibilityAddTraits(.isHeader)
            if transfers.isEmpty {
                Text("No transfers in progress.").foregroundStyle(.secondary)
            } else {
                ScrollView {
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
                .frame(maxHeight: 280)
            }
        }
        .padding(16)
        .frame(width: 340)
    }

    private func progressText(_ transfer: TransferInfo) -> String {
        let done = ByteCountFormatter.string(fromByteCount: max(0, transfer.bytesDone), countStyle: .file)
        guard transfer.bytesTotal > 0 else { return "\(transfer.status.rawValue.capitalized) · \(done)" }
        let total = ByteCountFormatter.string(fromByteCount: transfer.bytesTotal, countStyle: .file)
        return "\(transfer.status.rawValue.capitalized) · \(done) of \(total)"
    }
}
