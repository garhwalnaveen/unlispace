import SwiftUI
import UnlispaceKit

struct OfflineFilesView: View {
    var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if model.usingMock || (!model.isSignedIn && !model.hasDevToken) {
                ContentUnavailableView("Connect to see offline files", systemImage: "arrow.down.circle",
                    description: Text("Sign in and connect the engine to manage files kept on this Mac."))
            } else if let pins = model.pins {
                if pins.isEmpty {
                    ContentUnavailableView("Choose what stays on your Mac", systemImage: "externaldrive.badge.checkmark",
                        description: Text("In My drives, open a drive’s offline options and choose Keep entire drive offline. Cached progress will appear here."))
                } else {
                    Text("\(pins.count) offline selection\(pins.count == 1 ? "" : "s")")
                        .font(.callout).foregroundStyle(.secondary)
                    ForEach(pins) { pin in
                        pinRow(pin)
                    }
                    Text("Stopping offline access allows these files to leave the local cache. You can download them again while connected.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } else {
                ContentUnavailableView("Offline status unavailable", systemImage: "questionmark.circle",
                    description: Text("This engine does not report offline files. Update the engine and refresh to check again."))
            }
        }
    }

    private func pinRow(_ pin: OfflinePin) -> some View {
        let drive = model.drives.first { $0.driveId == pin.driveId }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Label(drive?.name ?? pin.driveId, systemImage: "externaldrive").font(.headline)
                Spacer()
                if let drive, drive.mountState == .mounted {
                    Button("Open in Finder") { model.openInFinder(drive) }
                        .disabled(drive.mountPath == nil)
                }
                Button("Stop keeping offline") { model.setPin(driveId: pin.driveId, path: pin.path, pinned: false) }
                    .disabled(model.pendingDriveActions.contains(pin.driveId) || (drive.map { model.isDriveBusy($0) } ?? false))
                    .accessibilityLabel("Stop keeping \(drive?.name ?? pin.driveId), \(pin.path) offline")
            }
            Text(pin.path == "/" ? "Entire drive" : pin.path).font(.callout).textSelection(.enabled)
            ProgressView(value: pin.progress)
                .accessibilityLabel("\(drive?.name ?? pin.driveId), \(pin.path) cached")
                .accessibilityValue("\(Int(pin.progress * 100)) percent")
            Text("\(ByteCountFormatter.string(fromByteCount: max(0, pin.cachedBytes), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: max(0, pin.bytes), countStyle: .file)) cached")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
    }
}
