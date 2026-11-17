import SwiftUI
import OrbitKit

/// A rename or a copy waiting for its name. Shared so any menu can ask the main window to show the sheet.
struct DriveEdit: Identifiable, Equatable {
    enum Kind { case rename, copy }
    var kind: Kind
    var drive: DriveInfo
    var id: String { "\(kind)|\(drive.driveId)" }
}

/// The main list: every drive, what state it is in, and "Open in Finder".
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
                Label("Sign in to see your drives", systemImage: "person.crop.circle")
            } description: {
                Text("Your drives appear here and in Finder once you are signed in.")
            } actions: {
                SignInControls(session: model.session)
            }
        } else if !model.engine.isConnected {
            let headline = model.headline
            ContentUnavailableView {
                Label(headline.title, systemImage: "externaldrive.badge.exclamationmark")
            } description: {
                Text(headline.detail ?? "Your drives come back to Finder once Orbit can run in the background.")
            } actions: {
                if let action = headline.action {
                    Button(action.title) { action.perform(model: model, windows: windows) }.buttonStyle(.borderedProminent)
                }
            }
        } else if store.drives.isEmpty {
            VStack(spacing: 0) {
                PlanNotices(directory: model.workspaces)
                ContentUnavailableView {
                    Label("No drives yet", systemImage: "externaldrive.badge.plus")
                } description: {
                    Text("Drives you create or are invited to appear here and in Finder. Each one is a folder of files with history.")
                } actions: {
                    if model.isAccountLive {
                        Button("New Drive…") { navigation.showingNewDrive = true }.buttonStyle(.borderedProminent)
                    }
                }
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
                        .orbitLabel().foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                Divider()
            }
            PlanNotices(directory: model.workspaces)
            if shown.isEmpty {
                ContentUnavailableView {
                    Label("No matching drives", systemImage: "line.3.horizontal.decrease.circle")
                } description: {
                    Text("No drive matches this filter.")
                } actions: {
                    Button("Clear Filter") { query = ""; filter = .all }
                }
            } else {
                List {
                    if model.showsGetStarted {
                        GetStartedList(model: model).orbitCard().padding(.vertical, 6).listRowSeparator(.hidden)
                    }
                    ForEach(shown) { drive in
                        DriveRow(model: model, drive: drive) { navigation.driveEdit = $0 }
                    }
                }
                .listStyle(.inset).scrollContentBackground(.hidden)
            }
        }
    }
}

struct DriveRow: View {
    var model: AppModel
    var drive: DriveInfo
    var edit: (DriveEdit) -> Void

    private var store: DriveStore { model.drives }
    private var busy: Bool { store.isBusy(drive) }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: drive.mountState == .mounted ? "externaldrive.fill" : "externaldrive").font(.title2)
                .foregroundStyle(drive.mountState == .mounted ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(drive.name).fontWeight(.medium).lineLimit(1)
                HStack(spacing: 6) {
                    MountStateLabel(state: drive.mountState)
                    if store.isReadOnly(drive.driveId) { Text("· View only") }
                    if store.isKeptOffline(drive.driveId) { Text("· Kept offline") }
                }
                .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small).accessibilityLabel(drive.mountState.label) }
            Button(drive.mountState == .error ? "Try Again" : "Open in Finder") { store.open(drive) }
                .disabled(busy)
                .accessibilityLabel(drive.mountState == .error ? "Try connecting \(drive.name) again" : "Open \(drive.name) in Finder")
            Menu {
                DriveActions(model: model, drive: drive, edit: edit)
            } label: {
                Label("More", systemImage: "ellipsis.circle").labelStyle(.iconOnly)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .disabled(busy).help("More actions for \(drive.name)")
            .accessibilityLabel("More actions for \(drive.name)")
        }
        .padding(.vertical, 4)
        .contextMenu { DriveActions(model: model, drive: drive, edit: edit) }
    }
}

/// Everything else a drive can do, shared by the row's "…" menu, the context menu, and the menu bar.
/// Deleting is last, set apart, and always asks first.
struct DriveActions: View {
    var model: AppModel
    var drive: DriveInfo
    /// Shows the name sheet for a rename or a copy.
    var edit: (DriveEdit) -> Void

    private var store: DriveStore { model.drives }

    var body: some View {
        let canManage = model.workspaces.canManage(driveID: drive.driveId)
        if drive.mountState == .mounted {
            Button("Add a File…") { store.addFile(to: drive) }.disabled(!store.canAddFile(to: drive))
            Button("Eject") { store.unmount(drive) }
        }
        if store.pins != nil {
            if !store.isKeptOffline(drive.driveId) {
                Button("Keep Offline") { store.setPin(driveId: drive.driveId, path: "/", pinned: true) }
            }
            ForEach(store.pins(for: drive.driveId)) { pin in
                Button(pin.path == "/" ? "Remove Offline Copy" : "Remove Offline Copy of \(pin.path)") {
                    store.setPin(driveId: drive.driveId, path: pin.path, pinned: false)
                }
            }
        }
        Divider()
        Button("Rename…") { edit(DriveEdit(kind: .rename, drive: drive)) }.disabled(!canManage)
        Button("Make a Copy…") { edit(DriveEdit(kind: .copy, drive: drive)) }.disabled(!canManage)
        if let url = model.workspaces.config?.drivePage(driveId: drive.driveId) {
            Button("Open on the Web") { NSWorkspace.shared.open(url) }
        } else {
            Button("Open on the Web") {}.disabled(true)
        }
        Divider()
        Button("Delete…", role: .destructive) { model.deleteDrive(drive) }.disabled(!canManage)
    }
}

/// Asks for the new name of a drive, or the name of its copy.
struct DriveNameSheet: View {
    var model: AppModel
    var edit: DriveEdit
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?

    private var renaming: Bool { edit.kind == .rename }
    private var valid: String? { DriveManagement.validName(name, current: renaming ? edit.drive.name : nil) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(renaming ? "Rename “\(edit.drive.name)”" : "Make a copy of “\(edit.drive.name)”").font(.headline)
            Text(renaming
                 ? "Everyone with access sees the new name. In Finder it changes the next time the drive is opened."
                 : "The copy starts with the same files. After that, changes to one do not affect the other.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("Name", text: $name).textFieldStyle(.roundedBorder).onSubmit(save)
                .accessibilityLabel(renaming ? "New name" : "Name of the copy")
            if let error {
                Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Error: \(error)")
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(saving ? "Saving…" : renaming ? "Rename" : "Make a Copy", action: save)
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(saving || valid == nil)
            }
        }
        .padding(20)
        .frame(width: 400)
        .onAppear {
            name = renaming ? edit.drive.name
                : DriveManagement.copyName(for: edit.drive.name, existing: model.drives.drives.map(\.name))
        }
    }

    private func save() {
        guard !saving, let valid else { return }
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                if renaming { try await model.workspaces.renameDrive(edit.drive, to: valid) }
                else { try await model.workspaces.copyDrive(edit.drive, named: valid) }
                dismiss()
            } catch where DriveManagement.isUnsupported(error) {
                model.reportDriveChange(error, drive: edit.drive, verb: renaming ? "rename" : "copy")
                dismiss()
            } catch {
                self.error = DriveManagement.message(for: error, verb: renaming ? "rename" : "copy")
            }
        }
    }
}

/// Narrows the drive list by name and mount state without reordering it.
enum DriveFilter: String, CaseIterable, Identifiable {
    case all = "All", mounted = "In Finder", unmounted = "Not in Finder", failed = "Needs attention"
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
            Text("New Drive").font(Theme.display(20))
            Text("A drive is a folder of files with history. It appears in Finder as soon as it is created.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
            if let error { Text(error).font(.callout).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(creating ? "Creating…" : "Create Drive", action: create)
                    .keyboardShortcut(.defaultAction).buttonStyle(.orbitProminent)
                    .disabled(creating || target == nil || trimmed.isEmpty || trimmed.count > 100)
            }
        }
        .padding(20)
        .frame(width: 380)
        .background(Theme.canvas)
        .orbitControls()
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
                self.error = DriveManagement.message(for: error, verb: "create")
            }
        }
    }
}
