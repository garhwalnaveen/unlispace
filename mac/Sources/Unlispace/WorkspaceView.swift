import SwiftUI
import UnlispaceKit

struct WorkspaceView: View {
    var model: AppModel
    @State private var page: Page? = .drives
    @State private var query = ""
    @State private var filter: DriveFilter = .all
    @State private var hasVisitedAI = false
    @FocusState private var searchFocused: Bool
    @AppStorage("appearance") private var appearance = "system"
    @Environment(\.openSettings) private var openSettings

    private enum Page: String, CaseIterable, Identifiable {
        case drives = "My drives", transfers = "Transfers", offline = "Offline files", search = "Search files", workspace = "Workspace", ai = "Ask AI"
        var id: Self { self }
        var symbol: String {
            switch self {
            case .drives: "externaldrive"
            case .transfers: "arrow.up.arrow.down"
            case .offline: "arrow.down.circle"
            case .search: "magnifyingglass"
            case .workspace: "person.2"
            case .ai: "sparkles"
            }
        }
        var subtitle: String {
            switch self {
            case .drives: "Open a drive in Finder to work with your files."
            case .transfers: "Follow files as they move between your Mac and your drives."
            case .offline: "Manage the files you want to keep on this Mac."
            case .search: "Find files and folders by name across a drive."
            case .workspace: "Create drives, manage your team, and review your plan."
            case .ai: "Ask your configured provider about text you choose to share."
            }
        }
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 12) {
                Label("Unlispace", systemImage: "square.stack.3d.up")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AppDesign.foreground)
                    .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 8)
                List(selection: $page) {
                    Section("Files") {
                        ForEach([Page.drives, .search, .transfers, .offline]) { item in
                            Label {
                                Text(item.rawValue)
                            } icon: {
                                Image(systemName: item.symbol).foregroundStyle(AppDesign.muted)
                            }.tag(item)
                                .padding(.vertical, 5)
                        }
                    }
                    Section("Tools") {
                        ForEach([Page.workspace, .ai]) { item in
                            Label {
                                Text(item.rawValue)
                            } icon: {
                                Image(systemName: item.symbol).foregroundStyle(AppDesign.muted)
                            }.tag(item)
                                .padding(.vertical, 5)
                        }
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                VStack(alignment: .leading, spacing: 12) {
                    Label(model.connectionTitle, systemImage: model.symbolName).font(.callout).foregroundStyle(AppDesign.foreground)
                    Text(model.account?.email ?? "Sign in to connect your drives.")
                        .font(.caption).foregroundStyle(AppDesign.muted).lineLimit(2)
                    Button("Settings…") { openSettings() }.keyboardShortcut(",")
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(AppDesign.surface)
            .navigationSplitViewColumnWidth(min: 210, ideal: 220, max: 260)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text((page ?? .drives).rawValue).font(AppDesign.title).tracking(-0.6)
                            .accessibilityAddTraits(.isHeader)
                        Text((page ?? .drives).subtitle)
                            .foregroundStyle(AppDesign.muted)
                    }
                    Divider().overlay(AppDesign.border)
                    ConnectionNotice(model: model)
                    if page == .transfers {
                        TransfersView(transfers: model.transfers, uploads: model.uploads, recentUploads: model.recentUploads, state: model.status, embedded: true, available: !model.usingMock && (model.isSignedIn || model.hasDevToken))
                    } else if page == .offline {
                        OfflineFilesView(model: model)
                    } else if page == .search {
                        FileSearchView(model: model)
                    } else if page == .workspace {
                        WorkspaceAccountView(model: model)
                    } else if page != .ai {
                        drives
                    }
                    if hasVisitedAI {
                        AIView().id(model.account?.id)
                            .frame(height: page == .ai ? nil : 0)
                            .clipped()
                            .disabled(page != .ai)
                            .accessibilityHidden(page != .ai)
                    }
                }
                .padding(32).frame(maxWidth: 1000, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(AppDesign.canvas)
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
                Button("Search files") { page = .search }.keyboardShortcut("4")
                Button("Workspace") { page = .workspace }.keyboardShortcut("5")
                Button("Ask AI") { page = .ai }.keyboardShortcut("6")
                Button("Find a drive") { page = .drives; searchFocused = true }.keyboardShortcut("f")
            }.hidden().accessibilityHidden(true)
        }
        .onChange(of: page) { _, page in if page == .ai { hasVisitedAI = true } }
        .frame(minWidth: 800, minHeight: 580)
        .appStyle()
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
    }

    private var drives: some View {
        VStack(alignment: .leading, spacing: 18) {
            if model.isSignedIn || model.hasDevToken {
                HStack {
                    Label(model.connectionTitle, systemImage: model.symbolName)
                    Spacer()
                    Button("View transfers") { page = .transfers }
                }
                .padding(16).appPanel()
            }
            HStack {
                Text("\(model.drives.count) drive\(model.drives.count == 1 ? "" : "s")")
                    .font(.callout).foregroundStyle(AppDesign.muted)
                Spacer()
                Picker("Show drives", selection: $filter) {
                    ForEach(DriveFilter.allCases) { Text($0.rawValue).tag($0) }
                }.labelsHidden().frame(width: 130).accessibilityLabel("Show drives")
                TextField("Filter drives", text: $query).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
                    .accessibilityLabel("Filter drives").focused($searchFocused)
                Button("New drive…") { page = .workspace }.disabled(!model.isSignedIn || model.usingMock)
            }
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
                if !filtered.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(filtered) { drive in
                            if drive.id != filtered.first?.id { Divider().padding(.leading, 54) }
                            DriveCard(model: model, drive: drive)
                        }
                    }
                    .appPanel()
                }
            }
            if let message = model.copyMessage { Text(message).font(.callout).textSelection(.enabled).accessibilityAddTraits(.updatesFrequently) }
            Label("Mounted drives appear in Finder. Files download as you open them.", systemImage: "info.circle")
                .font(.callout).foregroundStyle(AppDesign.muted)
            if model.isSignedIn { ActivationCard(model: model) }
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
                            .font(.callout).foregroundStyle(AppDesign.muted)
                    }
                    Spacer()
                    Button("Open setup") { AppDelegate.showOnboarding() }
                }.padding(16).appPanel()
            }
            if let notice = model.notice { Text(notice).font(.callout).foregroundStyle(AppDesign.muted) }
            if let error = model.lastError {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled)
            }
            if let conflict = model.lastConflict {
                Label("Conflicting edit: \(conflict.path). Your edit was saved as \(conflict.copy).", systemImage: "doc.on.doc")
                    .foregroundStyle(.orange).textSelection(.enabled)
            }
            if !model.usingMock, let message = model.stateMessage, !message.isEmpty { Text(message).font(.callout).foregroundStyle(AppDesign.muted) }
            if model.canRetrySignIn { Button("Retry saved sign-in") { model.retrySavedSignIn() }.disabled(model.retryingSavedSignIn) }
        }
    }
}

struct DriveCard: View {
    var model: AppModel
    var drive: DriveInfo
    private var busy: Bool { model.isDriveBusy(drive) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { identity; Spacer(minLength: 16); actions }
            VStack(alignment: .leading, spacing: 16) {
                identity
                HStack { Spacer(minLength: 0); actions }
            }
        }
        .padding(16)
    }

    private var identity: some View {
        HStack(spacing: 14) {
            Image(systemName: "externaldrive").font(.title2).foregroundStyle(AppDesign.muted)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 5) {
                Text(drive.name).font(.system(size: 14, weight: .medium)).lineLimit(2)
                Text(drive.mountState.rawValue.capitalized).font(.callout).foregroundStyle(AppDesign.muted)
                if let path = drive.mountPath { Text(path).font(.caption).foregroundStyle(AppDesign.muted).textSelection(.enabled).lineLimit(2) }
                if let mounts = model.mounts, let mount = mounts.first(where: { $0.driveId == drive.driveId }), mount.readOnly {
                    Text("Read only").font(.caption).foregroundStyle(AppDesign.muted)
                }
            }
        }
        .frame(minWidth: 140, alignment: .leading)
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small).accessibilityLabel(drive.mountState.rawValue) }
            if drive.mountState == .mounted {
                Button("Open in Finder") { model.openInFinder(drive) }.disabled(drive.mountPath == nil).buttonStyle(.borderedProminent)
                Button("Add a file…") { model.addFile(to: drive) }
                    .disabled(!model.isSignedIn || model.usingMock || drive.mountPath == nil || model.copyingFile || busy || model.mounts?.first(where: { $0.driveId == drive.driveId })?.readOnly == true)
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
        .fixedSize(horizontal: true, vertical: false)
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
