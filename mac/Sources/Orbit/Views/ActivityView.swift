import SwiftUI
import OrbitKit

/// Uploads and downloads in flight, files waiting to upload, and recently finished uploads.
/// `compact` is the menu-bar version: the same rows in a fixed-size panel.
struct ActivityView: View {
    var model: AppModel
    var compact = false

    var body: some View {
        let items = model.activity.items
        VStack(spacing: 0) {
            HStack {
                Label(model.statusTitle, systemImage: model.statusSymbol).font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if !items.isEmpty {
                    Text(Format.count(items.count, "item", "items")).orbitLabel().foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            Divider()
            if !model.isLive {
                ContentUnavailableView("No activity to show", systemImage: "arrow.up.arrow.down",
                                       description: Text("Uploads and downloads appear here once you are signed in and connected."))
            } else if items.isEmpty {
                ContentUnavailableView("No transfers", systemImage: "arrow.up.arrow.down",
                                       description: Text("Uploads and downloads appear here while they run."))
            } else {
                List(items) { ActivityRow(content: .init($0)) }
                    .listStyle(.inset).scrollContentBackground(.hidden)
            }
            if model.isLive, let uploads = model.activity.uploads { UploadQueueFooter(uploads: uploads) }
        }
        .frame(width: compact ? 340 : nil, height: compact ? 360 : nil)
    }
}

/// What one activity row says, worked out once from the queue entry and its matching transfer.
struct ActivityRowContent: Equatable {
    var title: String
    var path: String
    var status: String
    var symbol: String
    var failed = false
    var progress = Progress.none

    enum Progress: Equatable {
        case none, indeterminate, fraction(Double)

        init(_ fraction: Double?) { self = fraction.map(Self.fraction) ?? .indeterminate }
    }

    init(_ item: TransferActivity) {
        path = item.path
        title = TransferSummary.fileTitle(path: item.path)
        let transfer = item.transfer
        symbol = transfer?.direction == .download ? "arrow.down" : "arrow.up"
        if let pending = item.pending {
            let size = Format.bytes(pending.bytes)
            switch pending.stage {
            case .uploading:
                status = "Uploading · \(size)"
                progress = Progress(pending.uploadProgress)
            case .savedLocally, .unknown:
                status = "Waiting to upload · \(size)"
                if let transfer, !transfer.isFinished {
                    status = Self.text(for: transfer)
                    progress = Progress(transfer.progress)
                }
            }
            if transfer?.status == .failed {
                status = "Upload failed"
                failed = true
            }
        } else if let transfer {
            status = Self.text(for: transfer)
            failed = transfer.status == .failed
            if !transfer.isFinished { progress = Progress(transfer.progress) }
        } else {
            status = ""
        }
        if failed { symbol = "exclamationmark.triangle" }
    }

    static func text(for transfer: TransferInfo) -> String {
        let phase = TransferSummary.phase(for: transfer)
        // `/` is the engine's total for a drive, not a file, so byte counts would mislead.
        if transfer.direction == .upload && transfer.path == "/" { return phase }
        guard transfer.bytesTotal > 0 else {
            return transfer.bytesDone > 0 ? "\(phase) · \(Format.bytes(transfer.bytesDone))" : phase
        }
        if transfer.isFinished { return "\(phase) · \(Format.bytes(transfer.bytesTotal))" }
        return "\(phase) · \(Format.bytes(transfer.bytesDone)) of \(Format.bytes(transfer.bytesTotal))"
    }
}

private struct ActivityRow: View {
    var content: ActivityRowContent

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: content.symbol)
                .foregroundStyle(content.failed ? AnyShapeStyle(Theme.danger) : AnyShapeStyle(.secondary))
                .frame(width: 18).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(content.title).lineLimit(1).truncationMode(.middle)
                Text(content.status).font(.caption)
                    .foregroundStyle(content.failed ? AnyShapeStyle(Theme.danger) : AnyShapeStyle(.secondary))
                switch content.progress {
                case .none: EmptyView()
                case .indeterminate: ProgressView().progressViewStyle(.linear).accessibilityLabel(content.title)
                case .fraction(let value):
                    ProgressView(value: value)
                        .accessibilityLabel(content.title).accessibilityValue(Format.percent(value))
                }
            }
        }
        .padding(.vertical, 3)
        .help(content.path)
        .accessibilityElement(children: .combine)
    }
}

/// How much of the local upload queue is used. The queue holds files until they upload.
private struct UploadQueueFooter: View {
    var uploads: UploadsSnapshot

    var body: some View {
        let full = uploads.journalCapBytes > 0 && uploads.journalBytes >= uploads.journalCapBytes
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 6) {
                if full {
                    Label("The upload queue is full. New files wait until space frees up.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.warning)
                } else {
                    Text("Upload queue")
                }
                Spacer()
                Text("\(Format.bytes(uploads.journalBytes)) of \(Format.bytes(uploads.journalCapBytes))").monospacedDigit()
            }
            .font(.caption).foregroundStyle(.secondary)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .accessibilityElement(children: .combine)
        }
    }
}
