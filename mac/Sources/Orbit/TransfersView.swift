import SwiftUI
import OrbitKit

struct TransfersView: View {
    var transfers: [TransferInfo]
    var uploads: UploadsSnapshot? = nil
    var recentUploads: [TransferInfo] = []
    var state: AppStatus = .idle
    var embedded = false
    var available = true

    private var activity: [TransferActivity] {
        TransferActivity.list(pending: uploads?.pending ?? [], transfers: transfers, recentUploads: recentUploads)
    }

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
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: available ? "arrow.up.arrow.down.circle" : "network.slash")
                    .font(.system(size: 25)).foregroundStyle(AppDesign.accent)
                    .frame(width: 46, height: 46).background(AppDesign.subtle, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(embedded ? "Transfer overview" : "Activity")
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(AppDesign.muted)
                    Text(TransferSummary.uploadTitle(uploads: uploads, transfers: transfers, state: state, available: available, recentUploads: recentUploads))
                        .font(.system(size: embedded ? 17 : 13, weight: .semibold))
                        .accessibilityAddTraits(.isHeader)
                    if available {
                        Text("Files saved on this Mac stay here until their upload completes.")
                            .font(.caption).foregroundStyle(AppDesign.muted)
                    }
                }
                Spacer(minLength: 0)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(20).appPanel()
            if !available {
                ContentUnavailableView("Connect to see transfers", systemImage: "arrow.up.arrow.down", description: Text("Sign in and connect the engine to follow your file transfers."))
            }
            if available && uploads == nil {
                Label("Pending saves cannot be checked.", systemImage: "info.circle")
                    .font(.callout).foregroundStyle(AppDesign.muted)
            }
            if available && activity.isEmpty && uploads != nil {
                ContentUnavailableView("You're all caught up", systemImage: "checkmark.circle", description: Text("New uploads and downloads will appear here."))
            } else if !activity.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("File activity").font(.system(size: 15, weight: .semibold)).accessibilityAddTraits(.isHeader)
                        Spacer()
                        Text("\(activity.count) item\(activity.count == 1 ? "" : "s")")
                            .font(.caption).monospacedDigit().foregroundStyle(AppDesign.muted)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(activity.enumerated()), id: \.offset) { index, item in
                            if index > 0 { Divider().overlay(AppDesign.border).padding(.horizontal, 18) }
                            activityRow(item).padding(18)
                        }
                    }.appPanel()
                }
            }
            if let uploads {
                if uploads.journalCapBytes > 0 && uploads.journalBytes >= uploads.journalCapBytes {
                    Label("Local upload storage is full.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                DisclosureGroup("Upload storage details") {
                    let used = ByteCountFormatter.string(fromByteCount: uploads.journalBytes, countStyle: .file)
                    let cap = ByteCountFormatter.string(fromByteCount: uploads.journalCapBytes, countStyle: .file)
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Text("Upload journal"); Spacer(); Text("\(used) of \(cap)").monospacedDigit() }
                        ProgressView(value: min(1, max(0, Double(uploads.journalBytes) / Double(max(1, uploads.journalCapBytes)))))
                            .accessibilityLabel("Upload journal storage usage")
                    }.font(.caption).foregroundStyle(AppDesign.muted).padding(.top, 12)
                }.padding(18).appPanel()
            }
        }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
    }

    private func activityRow(_ item: TransferActivity) -> some View {
        let path = item.pending?.path ?? item.transfer?.path ?? "/"
        let failed = item.transfer?.status == .failed
        let symbol = item.transfer?.direction == .download ? "arrow.down" : "arrow.up"
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: failed ? "exclamationmark.triangle" : symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(failed ? Color.red : AppDesign.muted)
                .frame(width: 32, height: 32).background(AppDesign.subtle, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(Self.fileTitle(path: path)).font(.system(size: 12, weight: .semibold)).lineLimit(2)
                    if path != "/" {
                        Text(path).font(.caption).foregroundStyle(AppDesign.muted)
                            .lineLimit(1).truncationMode(.middle).help(path).textSelection(.enabled)
                    }
                }
                if let pending = item.pending {
                    pendingStatus(pending)
                    if let transfer = item.transfer, !transfer.isFinished, pending.stage != .uploading {
                        Text(progressText(transfer)).font(.caption).foregroundStyle(AppDesign.muted)
                        if let progress = transfer.progress {
                            ProgressView(value: progress).accessibilityLabel("Uploading \(transfer.path)")
                        }
                    }
                    if let transfer = item.transfer, transfer.isFinished {
                        Text(transfer.status == .failed ? "Upload failed" : "A previous upload completed; this save is still pending")
                            .font(.caption).foregroundStyle(transfer.status == .failed ? Color.red : AppDesign.muted)
                    }
                } else if let transfer = item.transfer {
                    if !transfer.isFinished {
                        if let progress = transfer.progress {
                            ProgressView(value: progress)
                                .accessibilityLabel("\(transfer.direction.rawValue) \(transfer.path)")
                                .accessibilityValue("\(Int(progress * 100)) percent, \(transfer.status.rawValue)")
                        } else {
                            ProgressView().controlSize(.small)
                                .accessibilityLabel("\(transfer.direction.rawValue) \(transfer.path), \(transfer.status.rawValue)")
                        }
                    }
                    Text(progressText(transfer)).font(.caption)
                        .foregroundStyle(failed ? Color.red : AppDesign.muted)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func pendingStatus(_ upload: PendingUpload) -> some View {
        let size = ByteCountFormatter.string(fromByteCount: upload.bytes, countStyle: .file)
        switch upload.stage {
        case .uploading:
            Text("Uploading · \(size)").font(.caption).foregroundStyle(AppDesign.muted)
            if let progress = upload.uploadProgress {
                ProgressView(value: progress)
                    .accessibilityLabel("Uploading \(upload.path)")
                    .accessibilityValue("\(Int(progress * 100)) percent")
            } else {
                ProgressView().controlSize(.small).accessibilityLabel("Uploading \(upload.path)")
            }
        case .savedLocally:
            Label("Saved locally, waiting to upload · \(size)", systemImage: "internaldrive")
                .font(.caption).foregroundStyle(AppDesign.muted)
        case .unknown:
            Label("Saved locally · \(size)", systemImage: "internaldrive")
                .font(.caption).foregroundStyle(AppDesign.muted)
        }
    }

    static func fileTitle(path: String) -> String {
        if path == "/" { return "Drive changes" }
        return path.split(separator: "/").last.map(String.init) ?? path
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
