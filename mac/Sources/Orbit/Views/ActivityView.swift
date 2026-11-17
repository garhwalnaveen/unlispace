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
                HeadlineLabel(headline: Self.summary(model), font: .headline).accessibilityAddTraits(.isHeader)
                Spacer()
                if !items.isEmpty {
                    Text(Format.count(items.count, "item", "items")).font(.callout).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            Divider()
            if !model.isLive {
                ContentUnavailableView("No activity yet", systemImage: "arrow.up.arrow.down",
                                       description: Text("Uploads and downloads appear here once you are signed in and your drives are connected."))
            } else if items.isEmpty {
                ContentUnavailableView("Nothing is uploading", systemImage: "arrow.up.arrow.down",
                                       description: Text("Save or drop a file into a drive in Finder and its upload appears here with its progress."))
            } else {
                List(items) { ActivityRow(content: .init($0)) }
                    .listStyle(.inset)
            }
            if model.isLive, let uploads = model.activity.uploads { UploadQueueFooter(uploads: uploads) }
        }
        .frame(width: compact ? 340 : nil, height: compact ? 360 : nil)
    }

    /// What this page is about: uploads and downloads. Other problems keep their place in the sidebar and menu.
    static func summary(_ model: AppModel) -> MenuHeadline {
        guard model.isLive else { return MenuHeadline(title: "No activity yet", tone: .neutral) }
        let items = model.activity.items
        if items.contains(where: { $0.transfer?.status == .failed }) {
            return MenuHeadline(title: "An upload didn't finish", tone: .attention)
        }
        let active = items.filter(\.isActive)
        let files = active.filter { $0.path != "/" }.count
        if files > 0 { return MenuHeadline(title: "Syncing \(Format.count(files, "file", "files"))", tone: .busy) }
        if !active.isEmpty { return MenuHeadline(title: "Syncing changes", tone: .busy) }
        return MenuHeadline(title: "Nothing is uploading", tone: .neutral)
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
                .foregroundStyle(content.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                .frame(width: 18).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(content.title).lineLimit(1).truncationMode(.middle)
                Text(content.status).font(.caption)
                    .foregroundStyle(content.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
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
                    Label("Your files are safe. Too many are waiting to upload, so new ones wait until some finish.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                } else {
                    Text("Waiting to upload")
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
