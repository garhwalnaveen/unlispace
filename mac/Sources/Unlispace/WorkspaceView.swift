import SwiftUI
import UnlispaceKit

struct WorkspaceView: View {
    var model: AppModel
    @State private var page: Page? = .drives
    @State private var query = ""
    @State private var filter: DriveFilter = .all
    @FocusState private var searchFocused: Bool
    @AppStorage("appearance") private var appearance = "system"
    @Environment(\.openSettings) private var openSettings

    private enum Page: String, CaseIterable, Identifiable {
        case drives = "My drives", transfers = "Transfers", offline = "Offline files"
        var id: Self { self }
        var symbol: String {
            switch self {
            case .drives: "externaldrive"
            case .transfers: "arrow.up.arrow.down"
            case .offline: "arrow.down.circle"
            }
        }
        var subtitle: String {
            switch self {
            case .drives: "Cloud drives that feel like part of your Mac."
            case .transfers: "Follow files as they move between your Mac and your drives."
            case .offline: "Manage the files you want to keep on this Mac."
            }
        }
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 24) {
                Label("Unlispace", systemImage: "square.stack.3d.up.fill")
                    .font(.title2.bold()).padding(.horizontal, 12).padding(.top, 20)
                List(Page.allCases, selection: $page) { item in
                    Label(item.rawValue, systemImage: item.symbol).tag(item)
                        .padding(.vertical, 5)
                }
                .listStyle(.sidebar)
                VStack(alignment: .leading, spacing: 12) {
                    Label(model.status.title, systemImage: model.symbolName).font(.callout)
                    Text(model.account?.email ?? "Your files, at home on your Mac.")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Button("Settings…") { openSettings() }.keyboardShortcut(",")
                }
                .padding(16)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text((page ?? .drives).rawValue).font(.largeTitle.bold())
                        Text((page ?? .drives).subtitle)
                            .foregroundStyle(.secondary)
                    }
                    ConnectionNotice(model: model)
                    if page == .transfers {
                        TransfersView(transfers: model.transfers, uploads: model.uploads, embedded: true, available: !model.usingMock && (model.isSignedIn || model.hasDevToken))
                    } else if page == .offline {
                        OfflineFilesView(model: model)
                    } else {
                        drives
                    }
                }
                .padding(32).frame(maxWidth: 900, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Color(nsColor: .windowBackgroundColor))
            .toolbar {
                Button { Task { await model.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .keyboardShortcut("r").help("Refresh (⌘R)")
                Button("Set up…") { AppDelegate.showOnboarding() }
            }
        }
        .background {
            Group {
                Button("My drives") { page = .drives }.keyboardShortcut("1")
                Button("Transfers") { page = .transfers }.keyboardShortcut("2")
                Button("Offline files") { page = .offline }.keyboardShortcut("3")
                Button("Find a drive") { page = .drives; searchFocused = true }.keyboardShortcut("f")
            }.hidden().accessibilityHidden(true)
        }
        .frame(minWidth: 800, minHeight: 580)
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
    }

    private var drives: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("\(model.drives.count) drives · \(model.drives.filter { $0.mountState == .mounted }.count) mounted")
                    .font(.callout).foregroundStyle(.secondary)
                Spacer()
                TextField("Filter drives", text: $query).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
                    .accessibilityLabel("Filter drives").focused($searchFocused)
            }
            Picker("Show drives", selection: $filter) {
                ForEach(DriveFilter.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented)
            if !model.isSignedIn && !model.hasDevToken {
                ContentUnavailableView {
                    Label("Your drives start here", systemImage: "externaldrive.badge.person.crop")
                } description: {
                    Text("Sign in to see your drives, mount them, and open your files in Finder.")
                } actions: {
                    Button(model.signingIn ? "Waiting for browser…" : "Sign in to Unlispace") { model.signIn() }
                        .buttonStyle(.borderedProminent).disabled(model.signingIn)
                    if model.signingIn {
                    Button("Open browser") { model.openSignInBrowser() }
                    Button("Cancel sign-in") { model.cancelSignIn() }
                }
                }
            } else if model.usingMock {
                ContentUnavailableView("Waiting for the engine", systemImage: "externaldrive.badge.exclamationmark", description: Text("Your drives will appear when the engine connects. Use setup to get connected."))
            } else if model.drives.isEmpty {
                ContentUnavailableView("No drives yet", systemImage: "externaldrive", description: Text("Drives available to your account will appear here. Refresh to check again."))
            } else {
                let filtered = filter.apply(to: model.drives, query: query)
                if filtered.isEmpty {
                    ContentUnavailableView {
                        Label("No matching drives", systemImage: "line.3.horizontal.decrease.circle")
                    } description: {
                        Text("Try another name or show all drives.")
                    } actions: {
                        Button("Clear filters") { query = ""; filter = .all }
                    }
                }
                ForEach(filtered) { drive in DriveCard(model: model, drive: drive) }
            }
            Label("Mounted drives appear in Finder. Files download as you open them.", systemImage: "info.circle")
                .font(.callout).foregroundStyle(.secondary)
        }
    }
}

struct ConnectionNotice: View {
    var model: AppModel
    private var engineMessage: String {
        switch model.engineInstall {
        case .notInstalled: "Install a build with the Unlispace engine to make drives available in Finder."
        case .failed(let message): message
        default: "Open setup to connect the engine and choose your drives."
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.usingMock {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "externaldrive.badge.exclamationmark").foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.engineInstall == .notInstalled ? "Engine not installed" : "Engine not connected").font(.headline)
                        Text(engineMessage)
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Open setup") { AppDelegate.showOnboarding() }
                }.padding(16).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            }
            if let notice = model.notice { Text(notice).font(.callout).foregroundStyle(.secondary) }
            if let error = model.lastError {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled)
            }
            if let conflict = model.lastConflict {
                Label("Conflicting edit: \(conflict.path). Your edit was saved as \(conflict.copy).", systemImage: "doc.on.doc")
                    .foregroundStyle(.orange).textSelection(.enabled)
            }
            if !model.usingMock, let message = model.stateMessage, !message.isEmpty { Text(message).font(.callout).foregroundStyle(.secondary) }
        }
    }
}

struct DriveCard: View {
    var model: AppModel
    var drive: DriveInfo
    private var busy: Bool { model.isDriveBusy(drive) }

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: "externaldrive.fill").font(.title2).foregroundStyle(.tint)
                .frame(width: 48, height: 48).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 5) {
                Text(drive.name).font(.headline)
                Text(drive.mountState.rawValue.capitalized).font(.callout).foregroundStyle(.secondary)
                if let path = drive.mountPath { Text(path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                if let mounts = model.mounts, let mount = mounts.first(where: { $0.driveId == drive.driveId }) {
                    Text("\(mount.adapter)\(mount.readOnly ? " · Read only" : "")").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if busy { ProgressView().controlSize(.small).accessibilityLabel(drive.mountState.rawValue) }
            if drive.mountState == .mounted {
                Button("Open in Finder") { model.openInFinder(drive) }.disabled(drive.mountPath == nil)
                Button("Eject", systemImage: "eject") { model.unmount(drive) }.labelStyle(.iconOnly)
                    .help("Eject \(drive.name)").accessibilityLabel("Eject \(drive.name)").disabled(busy || model.usingMock)
            } else {
                Button(busy ? "Please wait…" : "Mount") { model.mount(drive) }
                    .disabled(busy || model.usingMock).buttonStyle(.borderedProminent)
            }
            if let pins = model.pins {
                Menu {
                    Button("Keep entire drive offline") { model.setPin(driveId: drive.driveId, path: "/", pinned: true) }
                    ForEach(pins.filter { $0.driveId == drive.driveId }) { pin in
                        Text("\(pin.path) · \(Int(pin.progress * 100))% cached")
                        Button("Stop keeping \(pin.path) offline") { model.setPin(driveId: drive.driveId, path: pin.path, pinned: false) }
                    }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize().help("Offline options for \(drive.name)")
                .accessibilityLabel("Offline options for \(drive.name)").disabled(busy || model.usingMock)
            }
        }
        .padding(16).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
    }
}

/// Drive names are the only searchable metadata exposed by the daemon.
enum DriveFilter: String, CaseIterable, Identifiable {
    case all = "All", mounted = "Mounted", unmounted = "Not mounted", attention = "Needs attention"
    var id: Self { self }

    func apply(to drives: [DriveInfo], query: String) -> [DriveInfo] {
        let name = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return drives.filter { drive in
            let matchesState: Bool
            switch self {
            case .all: matchesState = true
            case .mounted: matchesState = drive.mountState == .mounted
            case .unmounted: matchesState = drive.mountState == .unmounted
            case .attention: matchesState = drive.mountState == .error
            }
            return matchesState && (name.isEmpty || drive.name.localizedCaseInsensitiveContains(name))
        }
    }
}
