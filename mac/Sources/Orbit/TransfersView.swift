import SwiftUI
import OrbitKit

struct TransfersView: View {
    var transfers: [TransferInfo]
    var uploads: UploadsSnapshot? = nil
    var recentUploads: [TransferInfo] = []
    var state: AppStatus = .idle

    var embedded = false
    var available = true

    var body: some View {
        Group {
            if embedded { content }
            else { ScrollView { content }.padding(20) }
        }
        .frame(width: embedded ? nil : 340)
        .frame(maxWidth: embedded ? .infinity : nil, alignment: .leading)
        .frame(maxHeight: embedded ? nil : 400, alignment: .top)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: AppDesign.sectionSpacing) {
            VStack(alignment: .leading, spacing: 8) {
                if !embedded { Text("Activity").font(.headline).accessibilityAddTraits(.isHeader) }
                Text(TransferSummary.uploadTitle(uploads: uploads, transfers: transfers, state: state, available: available, recentUploads: recentUploads)).font(.headline)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16).appPanel()
            if !available {
                ContentUnavailableView("Connect to see transfers", systemImage: "arrow.up.arrow.down", description: Text("Sign in and connect the engine to follow your file transfers."))
            }
            if available && uploads == nil {
                Text("Pending saves cannot be checked.")
                    .font(.callout).foregroundStyle(AppDesign.muted)
            }
            let activity = TransferActivity.list(pending: uploads?.pending ?? [], transfers: transfers, recentUploads: recentUploads)
            if available && activity.isEmpty && uploads != nil {
                ContentUnavailableView("No transfer activity", systemImage: "arrow.up.arrow.down")
            } else if !activity.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(activity.enumerated()), id: \.offset) { index, item in
                        if index > 0 { Divider() }
                        VStack(alignment: .leading, spacing: 8) {
                            if let pending = item.pending {
                                pendingRow(pending)
                                if let transfer = item.transfer, !transfer.isFinished, pending.stage != .uploading {
                                    Text(progressText(transfer)).font(.caption).foregroundStyle(AppDesign.muted)
                                    if let progress = transfer.progress {
                                        ProgressView(value: progress).accessibilityLabel("Uploading \(transfer.path)")
                                    }
                                }
                                if let transfer = item.transfer, transfer.isFinished {
                                    Text(transfer.status == .failed ? "Upload failed" : "A previous upload completed; this save is still pending")
                                        .font(.caption).foregroundStyle(transfer.status == .failed ? Color.red : Color.secondary)
                                }
                            } else if let transfer = item.transfer {
                                Label(transfer.direction == .upload && transfer.path == "/" ? "Drive changes" : transfer.path, systemImage: transfer.direction == .upload ? "arrow.up" : "arrow.down")
                                    .lineLimit(2)
                                if !transfer.isFinished {
                                    if let progress = transfer.progress {
                                        ProgressView(value: progress)
                                            .accessibilityLabel("\(transfer.direction.rawValue) \(transfer.path)")
                                            .accessibilityValue("\(Int(progress * 100)) percent, \(transfer.status.rawValue)")
                                    } else {
                                        ProgressView().accessibilityLabel("\(transfer.direction.rawValue) \(transfer.path), \(transfer.status.rawValue)")
                                    }
                                }
                                Text(progressText(transfer)).font(.caption).foregroundStyle(transfer.status == .failed ? Color.red : Color.secondary)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    }
                }.appPanel()
            }
            if let uploads {
                if uploads.journalCapBytes > 0 && uploads.journalBytes >= uploads.journalCapBytes {
                    Text("Local upload storage is full.").foregroundStyle(.orange)
                }
                DisclosureGroup("Upload storage details") {
                    let used = ByteCountFormatter.string(fromByteCount: uploads.journalBytes, countStyle: .file)
                    let cap = ByteCountFormatter.string(fromByteCount: uploads.journalCapBytes, countStyle: .file)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Upload journal: \(used) of \(cap)")
                        ProgressView(value: min(1, max(0, Double(uploads.journalBytes) / Double(max(1, uploads.journalCapBytes)))))
                            .accessibilityLabel("Upload journal storage usage")
                    }.font(.caption).foregroundStyle(AppDesign.muted)
                }.padding(16).appPanel()
            }
        }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
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
        if transfer.direction == .upload && transfer.path == "/" {
            switch transfer.status {
            case .queued: return "Drive changes waiting to upload"
            case .active: return "Uploading drive changes"
            case .done: return "Cloud changes saved"
            case .failed: return "Drive changes failed to upload"
            }
        }
        let done = ByteCountFormatter.string(fromByteCount: max(0, transfer.bytesDone), countStyle: .file)
        guard transfer.bytesTotal > 0 else { return "\(TransferSummary.phase(for: transfer)) · \(done)" }
        let total = ByteCountFormatter.string(fromByteCount: transfer.bytesTotal, countStyle: .file)
        return "\(TransferSummary.phase(for: transfer)) · \(done) of \(total)"
    }
}
