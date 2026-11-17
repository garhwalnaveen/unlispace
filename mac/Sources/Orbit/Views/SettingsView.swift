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
                .tabItem { Label(item.rawValue, systemImage: item.symbol) }
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
    @Environment(AppWindows.self) private var windows: AppWindows?
    @AppStorage(Preference.appearance) private var appearance = AppAppearance.system

    var body: some View {
        let permissions = model.permissions
        Section {
            Toggle("Open at login", isOn: Binding(
                get: { permissions.loginAccess == .enabled },
                set: { permissions.setLaunchAtLogin($0) }
            ))
            .disabled(permissions.loginAccess == .checking || permissions.loginAccess == .unavailable)
            Picker("Appearance", selection: $appearance) {
                ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
            }
            ShortcutPicker(store: model.shortcut)
        } footer: {
            if let message = permissions.loginMessage { Text(message) }
        }
        Section {
            LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development build")
            if model.updates.isEnabled {
                Button("Check for Updates…") { model.updates.checkForUpdates() }
            }
            Button("Run Setup Again…") { windows?.showSetup() }
        }
    }
}

private struct AccountSettings: View {
    var model: AppModel

    var body: some View {
        let session = model.session
        Section {
            if let account = session.account {
                LabeledContent("Signed in as", value: account.email)
                if session.sessionPending {
                    Text("Sign-in finishes when the background service starts.").foregroundStyle(.secondary)
                }
                HStack {
                    Button("Sign Out") { model.signOut() }.disabled(model.drives.copyingFile)
                    Button("Use a Different Account…") { model.useDifferentAccount() }.disabled(session.signingIn)
                }
                if session.signingIn { HStack { SignInControls(session: session, prominent: false) } }
            } else {
                LabeledContent("Not signed in") { HStack { SignInControls(session: session) } }
            }
        } footer: {
            if let error = model.messages.error { Text(error).foregroundStyle(.red) }
        }
        if model.isAccountLive { WorkspacesSection(directory: model.workspaces) }
    }
}

/// The account's workspaces with their plan and links to the web pages that manage them.
struct WorkspacesSection: View {
    var directory: WorkspaceDirectory

    var body: some View {
        Section {
            if directory.isLoading && directory.workspaces.isEmpty {
                ProgressView().controlSize(.small)
            } else if directory.workspaces.isEmpty && directory.error == nil {
                Text("This account is not in a workspace.").foregroundStyle(.secondary)
            }
            ForEach(directory.workspaces) { workspace in
                LabeledContent {
                    HStack(spacing: 12) {
                        if let url = directory.config?.page(orgId: workspace.id, section: "team") { Link("Team", destination: url) }
                        if let url = directory.config?.page(orgId: workspace.id, section: "billing") { Link("Billing", destination: url) }
                    }
                } label: {
                    Text(workspace.name)
                    Text(Self.summary(workspace))
                }
            }
        } header: {
            HStack {
                Text("Workspaces")
                Spacer()
                Button("Reload") { Task { await directory.load(force: true) } }
                    .buttonStyle(.link).font(.caption).disabled(directory.isLoading)
            }
        } footer: {
            if let error = directory.error { Text(error).foregroundStyle(.red) }
            else if !directory.workspaces.isEmpty { Text("Team and Billing open in your browser.") }
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
}

private struct StorageSettings: View {
    var model: AppModel
    @State private var cacheGB = AppSettings.cacheCapGB

    var body: some View {
        let config = model.config
        Section {
            Stepper("Downloaded files: up to \(cacheGB) GB", value: $cacheGB, in: 1...2000, step: 5)
                .onChange(of: cacheGB) { _, value in config.setCacheLimit(gigabytes: value) }
        } footer: {
            Text("Files download when you open them and stay on this Mac up to this limit. Offline files are managed in the Orbit window.")
        }
        Section {
            Picker("Upload speed limit", selection: Binding(
                get: { UploadLimit.option(for: config.uploadBandwidthBps ?? 0) },
                set: { config.setUploadLimit($0) }
            )) {
                ForEach(UploadLimit.options, id: \.bps) { Text($0.title).tag($0.bps) }
            }
            .disabled(!model.engine.isConnected || config.uploadLimitUnsupported)
        } footer: {
            if let error = config.uploadLimitError { Text(error).foregroundStyle(.red) }
            else if config.uploadLimitUnsupported { Text("Update Orbit to limit upload speed.") }
            else if !model.engine.isConnected { Text("Available when the background service is running.") }
        }
    }
}

private struct AdvancedSettings: View {
    var model: AppModel
    @State private var apiOverride = AppSettings.apiEndpointOverride
    @State private var endpoint = AppSettings.endpoint
    @State private var token = ""
    @State private var message: String?

    var body: some View {
        let engine = model.engine
        Section("Background service") {
            LabeledContent("Status", value: engine.isConnected ? "Running" : StatusBanner.engineText(engine.install))
            HStack {
                if !engine.isConnected, engine.install != .notInstalled, engine.install != .enabled {
                    Button("Turn On") { engine.enable() }
                }
                Button("Check Again") { Task { await model.refresh() } }
                Button("Show Logs in Finder") { showLogs() }
            }
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
