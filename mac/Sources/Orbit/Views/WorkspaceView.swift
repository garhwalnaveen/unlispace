import SwiftUI
import OrbitKit

enum WorkspacePage: String, CaseIterable, Identifiable {
    case drives, activity, offline, search, ai

    var id: Self { self }
    var title: String {
        switch self {
        case .drives: "Drives"
        case .activity: "Activity"
        case .offline: "Offline Files"
        case .search: "Search"
        case .ai: "Ask AI"
        }
    }
    var symbol: String {
        switch self {
        case .drives: "externaldrive"
        case .activity: "arrow.up.arrow.down"
        case .offline: "arrow.down.circle"
        case .search: "magnifyingglass"
        case .ai: "sparkles"
        }
    }
}

/// The main window: a sidebar of pages and the selected page.
struct WorkspaceView: View {
    var model: AppModel
    @Bindable var navigation: WorkspaceNavigation
    @Environment(AppWindows.self) private var windows: AppWindows?
    @Environment(\.openSettings) private var openSettings
    @AppStorage(Preference.settingsPage) private var settingsPage = SettingsPage.general
    @State private var hasOpenedAI = false

    init(model: AppModel, navigation: WorkspaceNavigation = WorkspaceNavigation()) {
        self.model = model
        self.navigation = navigation
    }

    var body: some View {
        NavigationSplitView {
            WorkspaceSidebar(model: model, page: $navigation.page) {
                settingsPage = .account
                openSettings()
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
        } detail: {
            VStack(spacing: 0) {
                StatusBanner(model: model)
                page
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .toolbar { toolbar }
        }
        .windowTitle(navigation.page.title)
        .background { pageShortcuts }
        .sheet(isPresented: $navigation.showingNewDrive) { NewDriveSheet(directory: model.workspaces) }
        .onChange(of: navigation.page, initial: true) { _, page in if page == .ai { hasOpenedAI = true } }
        .frame(minWidth: 680, minHeight: 440)
    }

    @ViewBuilder private var page: some View {
        switch navigation.page {
        case .drives: DrivesView(model: model, navigation: navigation)
        case .activity: ActivityView(model: model)
        case .offline: OfflineFilesView(model: model)
        case .search: FileSearchView(model: model)
        case .ai: EmptyView()
        }
        // Ask AI keeps its web session while other pages are shown, so a conversation survives a page switch.
        if hasOpenedAI {
            AIView(model: model).id(model.session.account?.id)
                .frame(maxHeight: navigation.page == .ai ? .infinity : 0)
                .clipped().disabled(navigation.page != .ai).accessibilityHidden(navigation.page != .ai)
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup {
            if navigation.page == .drives && model.isAccountLive {
                Button("New Drive…", systemImage: "plus") { navigation.showingNewDrive = true }
                    .help("Create a drive")
            }
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                .keyboardShortcut("r").help("Refresh")
        }
    }

    private var pageShortcuts: some View {
        Group {
            ForEach(Array(WorkspacePage.allCases.enumerated()), id: \.element) { index, page in
                Button(page.title) { navigation.page = page }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")))
            }
            Button("Search") { navigation.page = .search }.keyboardShortcut("f")
        }
        .hidden().accessibilityHidden(true)
    }
}

struct WorkspaceSidebar: View {
    var model: AppModel
    @Binding var page: WorkspacePage
    var openAccount: () -> Void

    var body: some View {
        List(selection: Binding<WorkspacePage?>(get: { page }, set: { if let new = $0 { page = new } })) {
            ForEach(WorkspacePage.allCases) { item in
                Label(item.title, systemImage: item.symbol)
                    .badge(item == .activity ? model.activity.transfers.count : 0)
                    .tag(item)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Divider()
                Label(model.statusTitle, systemImage: model.statusSymbol)
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.top, 4)
                    .accessibilityLabel("Status: \(model.statusTitle)")
                Button(action: openAccount) {
                    Label(model.session.account?.email ?? "Not signed in", systemImage: "person.crop.circle")
                        .lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("Account settings")
                .padding(.horizontal, 12).padding(.bottom, 10)
            }
        }
    }
}

/// Everything the user should know before looking at a page: connection state, errors, and conflicts.
struct StatusBanner: View {
    var model: AppModel
    @Environment(AppWindows.self) private var windows: AppWindows?

    var body: some View {
        let messages = model.messages
        VStack(spacing: 0) {
            if !model.engine.isConnected {
                InlineMessage(kind: .warning, text: Self.engineText(model.engine.install)) {
                    Button("Set Up…") { windows?.showSetup() }
                }
            }
            if let notice = messages.notice { InlineMessage(text: notice) }
            if model.engine.isConnected, let text = messages.engineMessage, !text.isEmpty { InlineMessage(text: text) }
            if model.session.canRetrySavedSignIn {
                InlineMessage(kind: .warning, text: "Orbit could not read your saved sign-in.") {
                    Button("Try Again") { model.session.retrySavedSignIn() }.disabled(model.session.retryingSavedSignIn)
                }
            }
            if let error = messages.error {
                InlineMessage(kind: .error, text: error, dismiss: { messages.error = nil })
            }
            if let conflict = messages.conflict {
                InlineMessage(kind: .warning, text: Self.conflictText(conflict), dismiss: { messages.conflict = nil })
            }
            if let copy = messages.fileCopy {
                InlineMessage(text: copy, dismiss: { messages.fileCopy = nil })
            }
            if Self.hasContent(model) { Divider() }
        }
    }

    static func hasContent(_ model: AppModel) -> Bool {
        let messages = model.messages
        return !model.engine.isConnected || messages.notice != nil || messages.error != nil || messages.conflict != nil
            || messages.fileCopy != nil || model.session.canRetrySavedSignIn
            || (messages.engineMessage?.isEmpty == false)
    }

    static func engineText(_ install: EngineInstallState) -> String {
        switch install {
        case .notInstalled: "This copy of Orbit has no background service. Install the full app to mount drives."
        case .failed(let message): message
        case .requiresApproval: "The background service needs your approval in Login Items."
        case .notRegistered: "The background service is turned off."
        case .enabled: "The background service is not running."
        }
    }

    static func conflictText(_ conflict: ConflictEvent) -> String {
        "\(conflict.path) changed in two places. Your version was saved as \(conflict.copy)."
    }
}
