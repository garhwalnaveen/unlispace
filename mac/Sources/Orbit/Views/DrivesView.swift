import SwiftUI
import OrbitKit

struct DrivesView: View {
    var model: AppModel
    @Bindable var navigation: WorkspaceNavigation
    @Environment(AppWindows.self) private var windows: AppWindows?
    @State private var query = ""
    @State private var filter = DriveFilter.all

    private var store: DriveStore { model.drives }

    var body: some View {
        if !model.session.hasCredentials {
            ContentUnavailableView {
                Label("Not signed in", systemImage: "person.crop.circle")
            } description: {
                Text("Sign in to see your drives.")
            } actions: {
                SignInControls(session: model.session)
            }
        } else if !model.engine.isConnected {
            ContentUnavailableView {
                Label("Drives unavailable", systemImage: "externaldrive.badge.exclamationmark")
            } description: {
                Text("Drives appear when the background service is running.")
            } actions: {
                Button("Set Up…") { windows?.showSetup() }
            }
        } else if store.drives.isEmpty {
            ContentUnavailableView {
                Label("No drives", systemImage: "externaldrive")
            } description: {
                Text("Drives you can access appear here.")
            } actions: {
                if model.isAccountLive { Button("New Drive…") { navigation.showingNewDrive = true } }
            }
        } else {
            driveList
        }
    }

    private var driveList: some View {
        let shown = store.drives.count > 1 ? filter.apply(to: store.drives, query: query) : store.drives
        return VStack(spacing: 0) {
            if store.drives.count > 1 {
                HStack(spacing: 8) {
                    TextField("Filter", text: $query, prompt: Text("Filter drives"))
                        .textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                        .accessibilityLabel("Filter drives by name")
                    Picker("Show", selection: $filter) {
                        ForEach(DriveFilter.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .labelsHidden().fixedSize().accessibilityLabel("Show drives")
                    Spacer()
                    Text(shown.count == store.drives.count
                         ? Format.count(shown.count, "drive", "drives")
                         : "\(shown.count) of \(store.drives.count) drives")
                        .font(.callout).foregroundStyle(.secondary).monospacedDigit()
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                Divider()
            }
            PlanNotices(directory: model.workspaces)
            if shown.isEmpty {
                ContentUnavailableView {
                    Label("No matching drives", systemImage: "line.3.horizontal.decrease.circle")
                } actions: {
                    Button("Clear Filter") { query = ""; filter = .all }
                }
            } else {
                List {
                    ForEach(shown) { DriveRow(model: model, drive: $0) }
                    FirstFileChecklist(model: model)
                }
                .listStyle(.inset)
            }
        }
    }
}

struct DriveRow: View {
    var model: AppModel
    var drive: DriveInfo

    private var store: DriveStore { model.drives }
    private var busy: Bool { store.isBusy(drive) }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "externaldrive").font(.title2).foregroundStyle(.secondary)
                .frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(drive.name).fontWeight(.medium).lineLimit(1)
                HStack(spacing: 6) {
                    MountStateLabel(state: drive.mountState)
                    if let path = drive.mountPath {
                        Text(path).lineLimit(1).truncationMode(.middle).help(path)
                    }
                    if store.isReadOnly(drive.driveId) { Text("Read only") }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small).accessibilityLabel(drive.mountState.label) }
            if drive.mountState == .mounted {
                Button("Open in Finder") { store.openInFinder(drive) }.disabled(drive.mountPath == nil)
            } else {
                Button("Mount") { store.mount(drive) }.disabled(busy)
            }
            Menu {
                DriveActions(store: store, drive: drive)
            } label: {
                Label("More", systemImage: "ellipsis.circle").labelStyle(.iconOnly)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .disabled(busy).help("More actions for \(drive.name)")
            .accessibilityLabel("More actions for \(drive.name)")
        }
        .padding(.vertical, 4)
        .contextMenu { DriveActions(store: store, drive: drive) }
    }
}

/// Secondary drive actions, shared by the row menu, the context menu, and the menu bar.
struct DriveActions: View {
    var store: DriveStore
    var drive: DriveInfo

    var body: some View {
        if drive.mountState == .mounted {
            Button("Add File…") { store.addFile(to: drive) }.disabled(!store.canAddFile(to: drive))
            Button("Eject") { store.unmount(drive) }
        }
        if store.pins != nil {
            if drive.mountState == .mounted { Divider() }
            if !store.isKeptOffline(drive.driveId) {
                Button("Keep Drive Offline") { store.setPin(driveId: drive.driveId, path: "/", pinned: true) }
            }
            ForEach(store.pins(for: drive.driveId)) { pin in
                Button(pin.path == "/" ? "Remove Offline Copy" : "Remove Offline Copy of \(pin.path)") {
                    store.setPin(driveId: drive.driveId, path: pin.path, pinned: false)
                }
            }
        }
    }
}

/// Narrows the drive list by name and mount state without reordering it.
enum DriveFilter: String, CaseIterable, Identifiable {
    case all = "All", mounted = "Mounted", unmounted = "Not mounted", failed = "Mount failed"
    var id: Self { self }

    func apply(to drives: [DriveInfo], query: String) -> [DriveInfo] {
        let name = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if self == .all && name.isEmpty { return drives }
        return drives.filter { drive in
            let matchesState: Bool
            switch self {
            case .all: matchesState = true
            case .mounted: matchesState = drive.mountState == .mounted
            case .unmounted: matchesState = drive.mountState == .unmounted
            case .failed: matchesState = drive.mountState == .error
            }
            return matchesState && (name.isEmpty || drive.name.localizedCaseInsensitiveContains(name))
        }
    }
}

struct NewDriveSheet: View {
    var directory: WorkspaceDirectory
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var workspaceID = ""
    @State private var creating = false
    @State private var error: String?

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var target: WorkspaceInfo? {
        directory.manageable.first { $0.id == workspaceID } ?? (directory.manageable.count == 1 ? directory.manageable.first : nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Drive").font(.headline)
            if directory.isLoading && directory.workspaces.isEmpty {
                ProgressView("Loading workspaces…")
            } else if directory.manageable.isEmpty {
                Text(directory.error ?? "Only workspace owners and admins can create drives.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Form {
                    TextField("Name", text: $name).onSubmit(create)
                    if directory.manageable.count > 1 {
                        Picker("Workspace", selection: $workspaceID) {
                            Text("Choose…").tag("")
                            ForEach(directory.manageable) { Text($0.name).tag($0.id) }
                        }
                    }
                }
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(creating ? "Creating…" : "Create", action: create)
                    .keyboardShortcut(.defaultAction)
                    .disabled(creating || target == nil || trimmed.isEmpty || trimmed.count > 100)
            }
        }
        .padding(20)
        .frame(width: 380)
        .task(id: directory.loadKey) { await directory.load() }
    }

    private func create() {
        guard !creating, let target, !trimmed.isEmpty, trimmed.count <= 100 else { return }
        creating = true
        error = nil
        Task {
            defer { creating = false }
            do {
                try await directory.createDrive(named: trimmed, in: target)
                dismiss()
            } catch {
                self.error = "Could not create the drive: \(LogFormat.describe(error))"
            }
        }
    }
}
