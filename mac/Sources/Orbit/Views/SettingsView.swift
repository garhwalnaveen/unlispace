import SwiftUI
import OrbitKit

struct SettingsView: View {
    var model: AppModel
    @AppStorage(Preference.settingsPage) private var page = SettingsPage.general

    var body: some View {
        TabView(selection: $page) {
            ForEach(SettingsPage.allCases) { item in
                Form {
                    switch item {
                    case .general: GeneralSettings(model: model)
                    case .account: AccountSettings(model: model)
                    case .storage: StorageSettings(model: model)
                    case .permissions: PermissionsContent(model: model)
                    case .advanced: AdvancedSettings(model: model)
                    }
                }
                .formStyle(.grouped)
                .tabItem { Label(item.title, systemImage: item.symbol) }
                .tag(item)
            }
        }
        .frame(width: 560, height: 460)
        .task { await model.permissions.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.permissions.refresh() }
        }
    }
}

private struct GeneralSettings: View {
    var model: AppModel
    @AppStorage(Preference.appearance) private var appearance = AppAppearance.system

    var body: some View {
        let permissions = model.permissions
        Section {
            Toggle("Open Orbit at login", isOn: Binding(
                get: { permissions.loginAccess == .enabled },
                set: { permissions.setLaunchAtLogin($0) }
            ))
            .disabled(permissions.loginAccess == .checking || permissions.loginAccess == .unavailable)
        } footer: {
            Text(permissions.loginMessage ?? "Orbit starts in the menu bar, so your drives are in Finder when you log in.")
        }
        Section {
            Picker("Appearance", selection: $appearance) {
                ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
            }
            ShortcutPicker(store: model.shortcut)
        } footer: {
            Text("The shortcut opens the Orbit window from any app.")
        }
        Section("Updates") {
            LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development build")
            if model.updates.isEnabled {
                Button("Check for Updates…") { model.updates.checkForUpdates() }
            } else {
                Text("This copy of Orbit does not update itself.").foregroundStyle(.secondary)
            }
        }
    }
}

private struct AccountSettings: View {
    var model: AppModel

    var body: some View {
        let session = model.session
        Section {
            if let account = session.account {
                LabeledContent("Email", value: account.email)
                if session.sessionPending {
                    Text("Sign-in finishes when Orbit can run in the background.").foregroundStyle(.secondary)
                }
                if session.signingIn { HStack { SignInControls(session: session, prominent: false) } }
            } else {
                LabeledContent("Not signed in") { HStack { SignInControls(session: session) } }
            }
        } footer: {
            if let error = model.messages.error { Text(error).foregroundStyle(.red) }
        }
        if model.isAccountLive { WorkspacesSection(directory: model.workspaces) }
        if session.account != nil {
            Section {
                HStack {
                    Button("Sign Out") { model.signOut() }.disabled(model.drives.copyingFile)
                    Button("Use a Different Account…") { model.useDifferentAccount() }.disabled(session.signingIn)
                }
            } footer: {
                Text("Signing out takes your drives out of Finder on this Mac. Your files stay in Orbit.")
            }
        }
    }
}

/// The account's workspaces: plan, storage used, and the web pages that manage them.
struct WorkspacesSection: View {
    var directory: WorkspaceDirectory

    var body: some View {
        Section {
            if directory.isLoading && directory.workspaces.isEmpty {
                ProgressView().controlSize(.small)
            } else if directory.workspaces.isEmpty && directory.error == nil {
                Text("This account is not in a workspace yet. Workspaces you create or join appear here.").foregroundStyle(.secondary)
            }
            ForEach(directory.workspaces) { workspace in
                VStack(alignment: .leading, spacing: 6) {
                    LabeledContent("Workspace", value: workspace.name)
                    LabeledContent("Plan", value: Self.summary(workspace))
                    if let usage = Self.usage(directory.access?.first { $0.id == workspace.id }) {
                        LabeledContent("Storage", value: usage)
                    }
                    HStack(spacing: 12) {
                        if let url = directory.config?.page(orgId: workspace.id, section: "billing") {
                            Link("Manage Plan on the Web", destination: url)
                        }
                        if let url = directory.config?.page(orgId: workspace.id, section: "team") {
                            Link("Manage Members on the Web", destination: url)
                        }
                    }
                    .font(.callout)
                }
                .padding(.vertical, 2)
            }
        } header: {
            HStack {
                Text("Workspace and plan")
                Spacer()
                Button("Reload") { Task { await directory.load(force: true) } }
                    .buttonStyle(.link).font(.caption).disabled(directory.isLoading)
            }
        } footer: {
            if let error = directory.error { Text(error).foregroundStyle(.red) }
        }
        .task(id: directory.loadKey) { await directory.load(force: true) }
    }

    /// "Pro plan · Owner", plus the trial state when there is one.
    static func summary(_ workspace: WorkspaceInfo, now: Date = Date()) -> String {
        var parts = ["\(workspace.tier.capitalized) plan", workspace.role.capitalized]
        if workspace.trialPending == true {
            parts.append("Trial starts when storage is ready")
        } else if let end = workspace.trialEndDate {
            let date = end.formatted(date: .abbreviated, time: .omitted)
            parts.append(end > now ? "Trial ends \(date)" : "Trial ended \(date)")
        }
        return parts.joined(separator: " · ")
    }

    /// "2.1 GB of 10 GB used", or nil when the server does not report storage.
    static func usage(_ access: MeAccess.Workspace?) -> String? {
        guard let used = access?.usedBytes else { return nil }
        guard let quota = access?.quotaBytes, quota > 0 else { return "\(Format.bytes(used)) used" }
        return "\(Format.bytes(used)) of \(Format.bytes(quota)) used"
    }
}

private struct StorageSettings: View {
    var model: AppModel
    @Environment(AppWindows.self) private var windows: AppWindows?
    @State private var cacheGB = AppSettings.cacheCapGB

    var body: some View {
        let config = model.config
        Section {
            Stepper("Keep up to \(cacheGB) GB of opened files on this Mac", value: $cacheGB, in: 1...2000, step: 5)
                .onChange(of: cacheGB) { _, value in config.setCacheLimit(gigabytes: value) }
        } header: {
            Text("Space on this Mac")
        } footer: {
            Text("Files download when you open them. When the limit is reached, Orbit removes the copies you opened longest ago. They stay in your drive.")
        }
        Section {
            LabeledContent("Kept offline", value: Self.offlineSummary(model.drives.pins))
            Button("Manage Offline Files…") { windows?.showWorkspace(page: .offline) }
                .disabled(!model.isLive || model.drives.pins == nil)
        } header: {
            Text("Offline files")
        } footer: {
            Text("Offline files are always on this Mac and do not count toward the limit above.")
        }
        Section {
            Picker("Upload speed limit", selection: Binding(
                get: { UploadLimit.option(for: config.uploadBandwidthBps ?? 0) },
                set: { config.setUploadLimit($0) }
            )) {
                ForEach(UploadLimit.options, id: \.bps) { Text($0.title).tag($0.bps) }
            }
            .disabled(!model.engine.isConnected || config.uploadLimitUnsupported)
        } header: {
            Text("Uploads")
        } footer: {
            if let error = config.uploadLimitError { Text(error).foregroundStyle(.red) }
            else if config.uploadLimitUnsupported { Text("Update Orbit to limit upload speed.") }
            else if !model.engine.isConnected { Text("Available when your drives are connected.") }
        }
    }

    /// "2 items · 3.2 GB", or why there is nothing to show.
    static func offlineSummary(_ pins: [OfflinePin]?) -> String {
        guard let pins else { return "Not available" }
        if pins.isEmpty { return "Nothing yet" }
        return "\(Format.count(pins.count, "item", "items")) · \(Format.bytes(pins.reduce(0) { $0 + $1.bytes }))"
    }
}

private struct AdvancedSettings: View {
    var model: AppModel
    @Environment(AppWindows.self) private var windows: AppWindows?
    @State private var apiOverride = AppSettings.apiEndpointOverride
    @State private var endpoint = AppSettings.endpoint
    @State private var token = ""
    @State private var message: String?

    var body: some View {
        let engine = model.engine
        Section("Diagnostics") {
            LabeledContent("Background service", value: engine.isConnected ? "Running" : StatusBanner.engineText(engine.install))
            HStack {
                if !engine.isConnected, engine.install != .notInstalled, engine.install != .enabled {
                    Button("Turn On") { engine.enable() }
                }
                Button("Check Again") { Task { await model.refresh() } }
                Button("Show Logs in Finder") { showLogs() }
                Button("Run Setup Again…") { windows?.showSetup() }
            }
        }
        Section {
            if let account = model.session.account { identifier("Account ID", account.id) }
            ForEach(model.drives.drives) { drive in
                identifier("\(drive.name) drive ID", drive.driveId)
                if let path = drive.mountPath { identifier("\(drive.name) Finder path", path) }
            }
            identifier("Server", AppSettings.apiEndpoint.isEmpty ? "Not set" : AppSettings.apiEndpoint)
        } header: {
            Text("Technical identifiers")
        } footer: {
            Text("Support may ask for these. Select one to copy it.")
        }
        Section {
            TextField("Server address", text: $apiOverride, prompt: Text(AppSettings.defaultAPIEndpoint))
            TextField("Storage endpoint", text: $endpoint, prompt: Text("http://127.0.0.1:8787"))
            SecureField("Access token", text: $token, prompt: Text(model.session.hasDevToken ? "Saved" : "None"))
            HStack {
                Button("Save") { save() }
                Button("Remove Token") { removeToken() }.disabled(!model.session.hasDevToken)
            }
        } header: {
            Text("Developer")
        } footer: {
            Text(message ?? "Overrides for testing against another server. Leave empty for normal use.")
        }
    }

    private func identifier(_ label: String, _ value: String) -> some View {
        LabeledContent(label) {
            Text(value).font(.callout.monospaced()).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
        }
    }

    private func save() {
        let api = apiOverride.trimmingCharacters(in: .whitespaces)
        let storage = endpoint.trimmingCharacters(in: .whitespaces)
        for (label, value) in [("Server address", api), ("Storage endpoint", storage)]
        where !value.isEmpty && AppSettings.validateEndpoint(value) == nil {
            message = "\(label) must start with https://. http:// is allowed only for localhost."
            return
        }
        AppSettings.apiEndpointOverride = api
        AppSettings.endpoint = storage
        do {
            if !token.isEmpty { try model.session.saveDevToken(token) }
            token = ""
            message = "Saved."
            if storage.isEmpty { Task { await model.refresh() } } else { model.config.pushDeveloperConfig() }
        } catch {
            message = "The token could not be saved to the Keychain."
        }
    }

    private func removeToken() {
        model.session.clearDevToken()
        message = "Token removed."
        Task { await model.refresh() }
    }

    private func showLogs() {
        // App logs go to the unified log; the engine writes files here.
        let directory = AppPaths.logsDirectory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(directory)
    }
}
