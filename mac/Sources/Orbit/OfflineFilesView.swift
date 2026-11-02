import SwiftUI
import OrbitKit

struct OfflineFilesView: View {
    var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if model.usingMock || (!model.isSignedIn && !model.hasDevToken) {
                ContentUnavailableView("Connect to see offline files", systemImage: "arrow.down.circle",
                    description: Text("Sign in and connect the engine to manage files kept on this Mac."))
            } else if let pins = model.pins {
                let availableDrives = model.drives.filter { drive in
                    !pins.contains { $0.driveId == drive.driveId && $0.path == "/" }
                }
                if !availableDrives.isEmpty {
                    Menu("Keep a drive offline…") {
                        ForEach(availableDrives) { drive in
                            Button(drive.name) { model.setPin(driveId: drive.driveId, path: "/", pinned: true) }
                                .disabled(model.isDriveBusy(drive) || model.pendingDriveActions.contains(drive.driveId))
                        }
                    }
                    Text("This keeps the entire selected drive on this Mac. Downloading it may use significant disk space.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                }
                if pins.isEmpty {
                    ContentUnavailableView("Choose what stays on your Mac", systemImage: "externaldrive.badge.checkmark",
                        description: Text(availableDrives.isEmpty ? "Your drives will appear here when available." : "Choose a drive above to keep it offline and track its download here."))
                } else {
                    Text("\(pins.count) offline selection\(pins.count == 1 ? "" : "s")")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                    ForEach(pins) { pin in
                        pinRow(pin)
                    }
                    Text("Stopping offline access allows these files to leave the local cache. You can download them again while connected.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
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
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top) {
                    Label(drive?.name ?? pin.driveId, systemImage: "externaldrive").font(.headline)
                    Spacer(minLength: 16)
                    pinActions(pin, drive: drive)
                }
                VStack(alignment: .leading, spacing: 16) {
                    Label(drive?.name ?? pin.driveId, systemImage: "externaldrive").font(.headline)
                    pinActions(pin, drive: drive)
                }
            }
            Text(pin.path == "/" ? "Entire drive" : pin.path).font(.callout).textSelection(.enabled)
            ProgressView(value: pin.progress)
                .accessibilityLabel("\(drive?.name ?? pin.driveId), \(pin.path) cached")
                .accessibilityValue("\(Int(pin.progress * 100)) percent")
            Text("\(ByteCountFormatter.string(fromByteCount: max(0, pin.cachedBytes), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: max(0, pin.bytes), countStyle: .file)) cached")
                .font(.caption).foregroundStyle(AppDesign.muted)
        }
        .padding(20).appPanel()
    }

    private func pinActions(_ pin: OfflinePin, drive: DriveInfo?) -> some View {
        HStack(spacing: 8) {
            if let drive, drive.mountState == .mounted {
                Button("Open in Finder") { model.openInFinder(drive) }
                    .disabled(drive.mountPath == nil)
            }
            if pin.progress < 1 {
                Button("Resume download") { model.setPin(driveId: pin.driveId, path: pin.path, pinned: true) }
                    .disabled(model.pendingDriveActions.contains(pin.driveId) || (drive.map { model.isDriveBusy($0) } ?? false))
                    .accessibilityLabel("Resume download for \(drive?.name ?? pin.driveId), \(pin.path)")
            }
            Button("Stop keeping offline") { model.setPin(driveId: pin.driveId, path: pin.path, pinned: false) }
                .disabled(model.pendingDriveActions.contains(pin.driveId) || (drive.map { model.isDriveBusy($0) } ?? false))
                .accessibilityLabel("Stop keeping \(drive?.name ?? pin.driveId), \(pin.path) offline")
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}
