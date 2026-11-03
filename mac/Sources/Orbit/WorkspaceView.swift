import SwiftUI
import OrbitKit

struct WorkspaceView: View {
    var model: AppModel
    @State private var page: Page? = .drives
    @State private var query = ""
    @State private var filter: DriveFilter = .all
    @State private var showSearch = false
    @State private var searchRequest = 0
    @AppStorage("settingsPage") private var settingsPage = "General"
    @AppStorage("appearance") private var appearance = "dark"
    @Environment(\.openSettings) private var openSettings

    private enum Page: String, CaseIterable, Identifiable {
        case drives = "Files", transfers = "Activity", offline = "Offline files"
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
            case .drives: "Your cloud drives, at home on your Mac."
            case .transfers: "Follow your saves, uploads, and downloads in one place."
            case .offline: "Choose what stays on this Mac, even without a connection."
            }
        }
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    OrbitMark(size: 27)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Orbit").font(.system(size: 18, weight: .semibold))
                        Text("YOUR WORKSPACE").font(.system(size: 9, weight: .semibold)).tracking(1.3)
                            .foregroundStyle(AppDesign.muted)
                    }
                }.padding(22)
                List(selection: $page) {
                    Section("Workspace") {
                        navigationRow(.drives)
                        navigationRow(.transfers)
                    }
                    Section("On this Mac") {
                        navigationRow(.offline)
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                VStack(alignment: .leading, spacing: 14) {
                    Label(model.connectionTitle, systemImage: model.symbolName)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(AppDesign.muted)
                    Button {
                        settingsPage = "Account"; openSettings()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "person.crop.circle.fill").font(.system(size: 28))
                                .foregroundStyle(AppDesign.muted)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(model.isSignedIn ? "Your account" : "Welcome to Orbit")
                                    .font(.system(size: 12, weight: .semibold))
                                Text(model.account?.email ?? "Sign in to get started")
                                    .font(.caption).foregroundStyle(AppDesign.muted).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(AppDesign.muted)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).help("Account settings")
                    Button { openSettings() } label: { Label("Settings", systemImage: "gearshape") }
                        .keyboardShortcut(",").frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(18)
                .background(alignment: .top) { Divider().overlay(AppDesign.border) }
            }
            .background(AppDesign.sidebar)
            .navigationSplitViewColumnWidth(min: 210, ideal: 224, max: 260)
        } detail: {
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: AppDesign.sectionSpacing) {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("WORKSPACE / \((page ?? .drives).rawValue.uppercased())")
                                .font(.system(size: 10, weight: .semibold)).tracking(1.1).foregroundStyle(AppDesign.muted)
                            Text((page ?? .drives).rawValue).font(AppDesign.title).tracking(-0.8)
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
                    } else if page == .offline {
                        OfflineFilesView(model: model)
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
                Button("Offline files") { page = .offline }.keyboardShortcut("3")
                Button("Search filenames") { page = .drives; showSearch = true; searchRequest += 1 }.keyboardShortcut("f")
            }.hidden().accessibilityHidden(true)
        }
        .onChange(of: page) { _, value in if value == .transfers { searchRequest = 0 } }
        .frame(minWidth: 800, minHeight: 580)
        .appStyle()
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
    }

    private func navigationRow(_ item: Page) -> some View {
        HStack(spacing: 10) {
            Label(item.rawValue, systemImage: item.symbol)
                .font(.system(size: 13, weight: page == item ? .semibold : .regular))
            Spacer(minLength: 0)
            if item == .drives && !model.usingMock && !model.drives.isEmpty {
                Text("\(model.drives.count)").font(.caption).monospacedDigit()
            }
        }.tag(item).padding(.vertical, 6)
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
                HStack(spacing: 0) {
                    workspaceMetric("Connected drives", value: "\(model.drives.count)", symbol: "externaldrive")
                    Divider().frame(height: 40)
                    workspaceMetric("Mounted", value: "\(model.drives.filter { $0.mountState == .mounted }.count)", symbol: "checkmark.circle")
                    Divider().frame(height: 40)
                    workspaceMetric("Kept offline", value: model.pins.map { "\($0.count)" } ?? "—", symbol: "arrow.down.circle")
                }.padding(.vertical, 18).appPanel()
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text("Your drives").font(.system(size: 16, weight: .semibold)).accessibilityAddTraits(.isHeader)
                        driveCount
                        Spacer()
                        Button { showSearch = true; searchRequest += 1 } label: { Label("Find a file", systemImage: "magnifyingglass") }
                    }
                    if model.drives.count > 1 {
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 12) { driveFilters; Spacer(minLength: 0) }
                            VStack(alignment: .leading, spacing: 12) { driveNameFilter; driveStateFilter }
                        }
                    }
                }.padding(.top, 6)
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
                let filtered = filteredDrives
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
                            if drive.id != filtered.first?.id { Divider().overlay(AppDesign.border).padding(.horizontal, 20) }
                            DriveCard(model: model, drive: drive)
                        }
                    }
                    .appPanel()
                }
            }
            if let message = model.copyMessage { Text(message).font(.callout).textSelection(.enabled).accessibilityAddTraits(.updatesFrequently) }
            if (model.isSignedIn || model.hasDevToken) && !model.usingMock && !model.drives.isEmpty {
                DisclosureGroup(isExpanded: $showSearch) {
                    FileSearchView(model: model, searchRequest: $searchRequest).padding(.top, 16)
                } label: {
                    Label("Search filenames", systemImage: "magnifyingglass").font(.system(size: 13, weight: .semibold))
                }
                .padding(18).appPanel().id("filenameSearch").onAppear(perform: onAppear)
            }
            if model.isSignedIn { ActivationCard(model: model) }
        }
    }

    private func workspaceMetric(_ title: String, value: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol).font(.system(size: 11)).foregroundStyle(AppDesign.muted)
            Text(value).font(.system(size: 24, weight: .semibold)).monospacedDigit()
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20)
            .accessibilityElement(children: .combine)
    }

    private var filteredDrives: [DriveInfo] {
        model.drives.count > 1 ? filter.apply(to: model.drives, query: query) : model.drives
    }

    private var driveCount: some View {
        Text("\(filteredDrives.count) of \(model.drives.count)")
            .font(.caption).monospacedDigit().foregroundStyle(AppDesign.muted).fixedSize()
            .accessibilityLabel("\(filteredDrives.count) of \(model.drives.count) drives shown")
    }

    private var driveFilters: some View {
        HStack(spacing: 12) { driveNameFilter; driveStateFilter }
    }

    private var driveNameFilter: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(AppDesign.muted).accessibilityHidden(true)
            TextField("Filter drive names", text: $query).textFieldStyle(.plain)
                .accessibilityLabel("Filter drives")
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).accessibilityLabel("Clear drive name filter")
            }
        }.padding(9).frame(minWidth: 150, idealWidth: 210, maxWidth: 260).appPanel()
    }

    private var driveStateFilter: some View {
        Picker("Show drives", selection: $filter) {
            ForEach(DriveFilter.allCases) { Text($0.rawValue).tag($0) }
        }.labelsHidden().frame(width: 145).accessibilityLabel("Show drives")
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
                actions.padding(.leading, 62)
            }
        }
        .padding(20)
    }

    private var identity: some View {
        HStack(spacing: 14) {
            Image(systemName: "externaldrive.fill").font(.system(size: 23)).foregroundStyle(AppDesign.accent)
                .frame(width: 48, height: 48).background(AppDesign.subtle, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 7) {
                Text(drive.name).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                DriveStatusBadge(state: drive.mountState)
                if let path = drive.mountPath {
                    Text(path).font(.system(size: 11)).foregroundStyle(AppDesign.muted)
                        .textSelection(.enabled).lineLimit(1).truncationMode(.middle).help(path)
                }
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
