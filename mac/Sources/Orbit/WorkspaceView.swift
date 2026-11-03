import SwiftUI
import OrbitKit

struct WorkspaceView: View {
    var model: AppModel
    @State private var page: Page? = .drives
    @State private var query = ""
    @State private var filter: DriveFilter = .all
    @State private var showSearch = true
    @State private var showOffline = false
    @State private var searchRequest = 0
    @AppStorage("settingsPage") private var settingsPage = "General"
    @AppStorage("appearance") private var appearance = "dark"
    @Environment(\.openSettings) private var openSettings

    private enum Page: String, CaseIterable, Identifiable {
        case drives = "Files", transfers = "Activity"
        var id: Self { self }
        var symbol: String { self == .drives ? "externaldrive" : "arrow.up.arrow.down" }
        var subtitle: String {
            self == .drives ? "Open a drive in Finder to work with your files." : "Follow files as they move between your Mac and your drives."
        }
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 12) {
                Label { Text("Orbit") } icon: { OrbitMark() }
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AppDesign.foreground)
                    .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 8)
                List(selection: $page) {
                    ForEach(Page.allCases) { item in
                        Label {
                            Text(item.rawValue).foregroundStyle(page == item ? .white : AppDesign.foreground)
                        } icon: {
                            Image(systemName: item.symbol).foregroundStyle(page == item ? .white : AppDesign.muted)
                        }.tag(item).padding(.vertical, 5)
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
                .background(alignment: .top) { Divider().overlay(AppDesign.border) }
            }
            .background(AppDesign.surface)
            .navigationSplitViewColumnWidth(min: 210, ideal: 220, max: 260)
        } detail: {
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: AppDesign.sectionSpacing) {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text((page ?? .drives).rawValue).font(AppDesign.title).tracking(-0.6)
                                .accessibilityAddTraits(.isHeader)
                            Text((page ?? .drives).subtitle)
                                .foregroundStyle(AppDesign.muted)
                        }
                        Spacer(minLength: 0)
                        if page == .drives && model.isSignedIn && !model.usingMock {
                            Button("New drive…") { settingsPage = "Workspace"; openSettings() }.buttonStyle(.borderedProminent)
                        }
                    }
                    Divider().overlay(AppDesign.border)
                    if ConnectionNotice.hasContent(model) { ConnectionNotice(model: model) }
                    if page == .transfers {
                        TransfersView(transfers: model.transfers, uploads: model.uploads, recentUploads: model.recentUploads, state: model.status, embedded: true, available: !model.usingMock && (model.isSignedIn || model.hasDevToken))
                    } else {
                        drives {
                            if searchRequest > 0 {
                                Task { @MainActor in
                                    await Task.yield()
                                    proxy.scrollTo("filenameSearch", anchor: .center)
                                }
                            }
                        }
                    }
                }
                .padding(AppDesign.pageInset).frame(maxWidth: AppDesign.contentWidth, alignment: .leading).frame(maxWidth: .infinity, alignment: .top)
            }
            .onChange(of: searchRequest) { _, request in
                if request > 0 {
                    Task { @MainActor in
                        await Task.yield()
                        proxy.scrollTo("filenameSearch", anchor: .center)
                    }
                }
            }
            }
            .background(AppDesign.canvas)
            .toolbar {
                Button { Task { await model.refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .keyboardShortcut("r").help("Refresh (⌘R)")
                if model.usingMock || (!model.isSignedIn && !model.hasDevToken) {
                    Button("Set up…") { AppDelegate.showOnboarding() }
                }
            }
        }
        .background {
            Group {
                Button("Files") { page = .drives }.keyboardShortcut("1")
                Button("Activity") { page = .transfers }.keyboardShortcut("2")
                Button("Search filenames") { page = .drives; showSearch = true; searchRequest += 1 }.keyboardShortcut("f")
            }.hidden().accessibilityHidden(true)
        }
        .onChange(of: page) { _, value in if value == .transfers { searchRequest = 0 } }
        .frame(minWidth: 800, minHeight: 580)
        .appStyle()
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
    }

    private func drives(onAppear: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if (model.isSignedIn || model.hasDevToken) && !model.usingMock
                && (model.uploads?.pending.isEmpty == false || !model.transfers.isEmpty || model.status != .idle
                    || model.recentUploads.contains { $0.status == .failed }) {
                HStack {
                    Label(model.connectionTitle, systemImage: model.symbolName)
                    Spacer()
                    Button("View activity") { page = .transfers }
                }
                .padding(16).appPanel()
            }
            if (model.isSignedIn || model.hasDevToken) && !model.usingMock && !model.drives.isEmpty {
                DisclosureGroup("Search filenames", isExpanded: $showSearch) {
                    FileSearchView(model: model, searchRequest: $searchRequest).padding(.top, 12)
                }.id("filenameSearch").onAppear(perform: onAppear)
            }
            if (model.isSignedIn || model.hasDevToken) && !model.usingMock && model.drives.count > 1 {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { driveFilters; Spacer(minLength: 0); driveCount }
                    VStack(alignment: .leading, spacing: 12) { driveFilters; driveCount }
                }
            }
            if !model.isSignedIn && !model.hasDevToken {
                ContentUnavailableView {
                    Label("Your drives start here", systemImage: "externaldrive.badge.person.crop")
                } description: {
                    Text("Sign in to see your drives, mount them, and open your files in Finder.")
                } actions: {
                    Button(model.signingIn ? "Waiting for browser…" : "Sign in to Orbit") { model.signIn() }
                        .buttonStyle(.borderedProminent).disabled(model.signingIn)
                    if model.signingIn {
                        Button("Open browser") { model.openSignInBrowser() }
                        Button("Cancel sign-in") { model.cancelSignIn() }
                    }
                }
                .frame(maxWidth: .infinity)
            } else if model.usingMock {
                ContentUnavailableView("Waiting for the engine", systemImage: "externaldrive.badge.exclamationmark", description: Text("Your drives will appear when the engine connects. Use setup to get connected."))
                    .frame(maxWidth: .infinity)
            } else if model.drives.isEmpty {
                ContentUnavailableView("No drives yet", systemImage: "externaldrive", description: Text("Drives available to your account will appear here. Refresh to check again."))
                    .frame(maxWidth: .infinity)
            } else {
                let filtered = model.drives.count > 1 ? filter.apply(to: model.drives, query: query) : model.drives
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
            if (model.isSignedIn || model.hasDevToken) && !model.usingMock && !model.drives.isEmpty {
                DisclosureGroup("Offline files", isExpanded: $showOffline) {
                    OfflineFilesView(model: model).padding(.top, 12)
                }
            }
            if model.isSignedIn { ActivationCard(model: model) }
        }
    }

    private var driveCount: some View {
        Text("\(model.drives.count) drive\(model.drives.count == 1 ? "" : "s")")
            .font(.callout).foregroundStyle(AppDesign.muted).fixedSize()
    }

    private var driveFilters: some View {
        HStack(spacing: 8) {
            TextField("Filter drives", text: $query).textFieldStyle(.roundedBorder).frame(width: 200)
                .accessibilityLabel("Filter drives")
            Picker("Show drives", selection: $filter) {
                ForEach(DriveFilter.allCases) { Text($0.rawValue).tag($0) }
            }.labelsHidden().frame(width: 140).accessibilityLabel("Show drives")
        }
    }
}

struct ConnectionNotice: View {
    var model: AppModel
    private var engineMessage: String {
        switch model.engineInstall {
        case .notInstalled: "Install a build with the Orbit engine to make drives available in Finder."
        case .failed(let message): message
        default: "Open setup to connect the engine and choose your drives."
        }
    }
    static func hasContent(_ model: AppModel) -> Bool {
        model.usingMock || model.notice != nil || model.lastError != nil || model.lastConflict != nil
            || model.stateMessage?.isEmpty == false || model.canRetrySignIn
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
                actions.padding(.leading, 40)
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
                Text(drive.mountState.label).font(.callout).foregroundStyle(AppDesign.muted)
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
            if busy { ProgressView().controlSize(.small).accessibilityLabel(drive.mountState.label) }
            if drive.mountState == .mounted {
                Button("Open in Finder") { model.openInFinder(drive) }.disabled(drive.mountPath == nil).buttonStyle(.borderedProminent)
                Button("Add file…") { model.addFile(to: drive) }
                    .disabled(!model.isSignedIn || drive.mountPath == nil || model.copyingFile || model.mounts?.first(where: { $0.driveId == drive.driveId })?.readOnly == true || busy || model.usingMock)
                Button("Eject", systemImage: "eject") { model.unmount(drive) }.labelStyle(.iconOnly)
                    .help("Eject \(drive.name)").accessibilityLabel("Eject \(drive.name)").disabled(busy || model.usingMock)
            } else {
                Button(busy ? "Please wait…" : "Mount") { model.mount(drive) }
                    .disabled(busy || model.usingMock).buttonStyle(.borderedProminent)
            }
            if model.pins != nil {
                Menu {
                    if let pins = model.pins {
                        Button("Keep entire drive offline") { model.setPin(driveId: drive.driveId, path: "/", pinned: true) }
                        ForEach(pins.filter { $0.driveId == drive.driveId }) { pin in
                            Text("\(pin.path) · \(Int(pin.progress * 100))% cached")
                            Button("Stop keeping \(pin.path) offline") { model.setPin(driveId: drive.driveId, path: pin.path, pinned: false) }
                        }
                    }
                } label: { Image(systemName: "ellipsis") }
                    .menuStyle(.button).menuIndicator(.hidden).fixedSize().help("Drive options for \(drive.name)")
                    .accessibilityLabel("Drive options for \(drive.name)").disabled(busy || model.usingMock)
            }
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}

/// Filters the drive list independently of filename search.
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
