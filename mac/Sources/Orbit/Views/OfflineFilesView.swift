import SwiftUI
import OrbitKit

/// Drives and folders kept on this Mac so they open without a connection.
struct OfflineFilesView: View {
    var model: AppModel

    private var store: DriveStore { model.drives }

    var body: some View {
        if !model.isLive {
            ContentUnavailableView("No offline files yet", systemImage: "arrow.down.circle",
                                   description: Text("Drives you keep offline appear here once you are signed in and your drives are connected."))
        } else if let pins = store.pins {
            let candidates = store.drives.filter { !store.isKeptOffline($0.driveId) }
            VStack(spacing: 0) {
                HStack {
                    Text(pins.isEmpty ? "Nothing is kept offline" : Format.count(pins.count, "offline item", "offline items"))
                        .font(.headline).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Menu("Keep Drive Offline") {
                        ForEach(candidates) { drive in
                            Button(drive.name) { store.setPin(driveId: drive.driveId, path: "/", pinned: true) }
                                .disabled(store.isBusy(drive))
                        }
                    }
                    .fixedSize().disabled(candidates.isEmpty)
                }
                .padding(.horizontal, 16).padding(.vertical, 10)
                Divider()
                if pins.isEmpty {
                    ContentUnavailableView("No offline files", systemImage: "arrow.down.circle",
                                           description: Text("Drives you keep offline appear here. Keeping one offline downloads all of its files to this Mac, so they open without a connection."))
                } else {
                    List(pins) { pin in OfflinePinRow(store: store, pin: pin) }
                        .listStyle(.inset)
                }
            }
        } else {
            ContentUnavailableView("Offline files unavailable", systemImage: "arrow.down.circle",
                                   description: Text("Update Orbit to keep files offline."))
        }
    }
}

private struct OfflinePinRow: View {
    var store: DriveStore
    var pin: OfflinePin

    var body: some View {
        let drive = store.drive(id: pin.driveId)
        let name = drive?.name ?? pin.driveId
        let busy = store.pendingActions.contains(pin.driveId) || (drive.map(store.isBusy) ?? false)
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(pin.path == "/" ? name : "\(name)\(pin.path)").fontWeight(.medium).lineLimit(1).truncationMode(.middle)
                ProgressView(value: pin.progress)
                    .accessibilityLabel("\(name) downloaded").accessibilityValue(Format.percent(pin.progress))
                Text(pin.progress >= 1
                     ? "Downloaded · \(Format.bytes(pin.bytes))"
                     : "\(Format.bytes(pin.cachedBytes)) of \(Format.bytes(pin.bytes)) downloaded")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if pin.progress < 1 {
                Button("Resume") { store.setPin(driveId: pin.driveId, path: pin.path, pinned: true) }
                    .disabled(busy).accessibilityLabel("Resume downloading \(name)")
            }
            if let drive, drive.mountState == .mounted {
                Button("Open in Finder") { store.openInFinder(drive) }.disabled(drive.mountPath == nil)
            }
            Button("Remove") { store.setPin(driveId: pin.driveId, path: pin.path, pinned: false) }
                .disabled(busy).accessibilityLabel("Remove offline copy of \(name)")
                .help("Stop keeping this on your Mac. The files stay in the drive.")
        }
        .padding(.vertical, 4)
    }
}
