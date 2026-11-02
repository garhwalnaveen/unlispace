import SwiftUI
import OrbitKit

struct SettingsView: View {
    var model: AppModel
    @State private var apiOverride = AppSettings.apiEndpointOverride
    @State private var endpoint = AppSettings.endpoint
    @State private var token = ""
    @State private var cacheGB = AppSettings.cacheCapGB
    @State private var message: String?
    private let keychain = Keychain()

    @State private var page: SettingsPage? = .general
    @AppStorage("appearance") private var appearance = "dark"

    private enum SettingsPage: String, CaseIterable, Identifiable {
        case general = "General", account = "Account", cache = "Storage & uploads", permissions = "Permissions", advanced = "Advanced"
        var id: Self { self }
        var symbol: String {
            switch self {
            case .general: "gearshape"
            case .account: "person.crop.circle"
            case .cache: "internaldrive"
            case .permissions: "hand.raised"
            case .advanced: "slider.horizontal.3"
            }
        }
    }

    var body: some View {
        NavigationSplitView {
            List(SettingsPage.allCases, selection: $page) { item in
                Label {
                    Text(item.rawValue)
                } icon: {
                    Image(systemName: item.symbol).foregroundStyle(AppDesign.muted)
                }.tag(item).padding(.vertical, 5)
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(AppDesign.surface)
            .navigationTitle("Settings")
            .navigationSplitViewColumnWidth(190)
        } detail: {
            Form {
                switch page ?? .general {
                case .general: general
                case .account: account
                case .cache: cache
                case .permissions: permissions
                case .advanced: advanced
                }
                if let message { Section { Text(message).foregroundStyle(AppDesign.muted).textSelection(.enabled) } }
                if let error = model.lastError { Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red) } }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .background(AppDesign.canvas)
            .navigationTitle((page ?? .general).rawValue)
        }
        .frame(minWidth: 780, idealWidth: 860, minHeight: 560, idealHeight: 620)
        .appStyle()
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
        .task { await model.refreshPermissions() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.refreshPermissions() }
        }
    }

    private var general: some View {
        Group {
            Section("General") {
                Toggle("Launch at login", isOn: Binding(
                    get: { model.loginAccess == .enabled },
                    set: { model.setLaunchAtLogin($0) }
                ))
                .disabled(model.loginAccess == .checking || model.loginAccess == .unavailable)
                if let message = model.permissionMessage { Text(message).font(.caption).foregroundStyle(AppDesign.muted) }
                Text("Keep Orbit ready in your menu bar when you sign in to your Mac.").font(.caption).foregroundStyle(AppDesign.muted)
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }.pickerStyle(.segmented)
            }
            Section("Setup") {
                LabeledContent("Drives in Finder") { Button("Open setup…") { AppDelegate.showOnboarding() } }
                Text("Sign in, choose drives, and learn about macOS access permissions.").foregroundStyle(AppDesign.muted)
            }
            Section("Orbit") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development")
                if model.updates.isEnabled { Button("Check for Updates…") { model.updates.checkForUpdates() } }
            }
        }
    }

    private var account: some View {
        Section("Your account") {
            if let acct = model.account {
                LabeledContent("Signed in as", value: acct.email)
                if model.sessionPending { Text("Signed in. Waiting for the engine to connect.").foregroundStyle(AppDesign.muted) }
                Button("Sign out") { model.signOut() }
                Button("Use a different account…") { model.useDifferentAccount() }
                    .disabled(model.signingIn)
                    .accessibilityHint("Signs out of this account and opens your browser to choose another")
                if model.signingIn {
                    Button("Open browser") { model.openSignInBrowser() }
                    Button("Cancel sign-in") { model.cancelSignIn() }
                }
            } else {
                Text("Sign in to access your Orbit drives on this Mac.").foregroundStyle(AppDesign.muted)
                if let message = model.stateMessage { Text(message).foregroundStyle(AppDesign.muted) }
                if model.canRetrySignIn {
                    Button("Retry saved sign-in") { model.retrySavedSignIn() }.disabled(model.retryingSavedSignIn)
                }
                Button(model.signingIn ? "Waiting for browser…" : "Sign in to Orbit") { model.signIn() }
                    .disabled(model.signingIn).buttonStyle(.borderedProminent)
                if model.signingIn {
                    Button("Open browser") { model.openSignInBrowser() }
                    Button("Cancel sign-in") { model.cancelSignIn() }
                }
            }
        }
    }

    private var cache: some View {
        Group {
            Section("Local storage") {
                Stepper("Downloaded files limit: \(cacheGB) GB", value: $cacheGB, in: 1...2000, step: 5)
                    .onChange(of: cacheGB) { _, v in AppSettings.cacheCapGB = v; model.pushCacheCap() }
                Text("Files download as you open them. This limit controls disk space used by cached files.").foregroundStyle(AppDesign.muted)
            }
            Section("Uploads") {
                Picker("Limit upload speed", selection: Binding(
                    get: { UploadLimit.option(for: model.uploadBandwidthBps ?? 0) },
                    set: { model.setUploadLimit($0) }
                )) {
                    ForEach(UploadLimit.options, id: \.bps) { Text($0.title).tag($0.bps) }
                }
                .disabled(model.usingMock || model.uploadLimitUnsupported)
                .accessibilityValue(model.uploadLimitUnsupported ? "Requires a newer engine" : "")
                if model.uploadLimitUnsupported { Text("Requires a newer engine").font(.caption).foregroundStyle(AppDesign.muted) }
                else if model.usingMock { Text("Connect the engine to limit upload speed.").font(.caption).foregroundStyle(AppDesign.muted) }
                else if model.uploadBandwidthBps == nil { Text("Current limit is not reported by this engine.").font(.caption).foregroundStyle(AppDesign.muted) }
                if let message = model.uploadLimitMessage { Text(message).font(.caption).foregroundStyle(.red) }
                Text("Slows uploads so they do not use all of your connection. Check Transfers to see when files are saved to the cloud.").font(.caption).foregroundStyle(AppDesign.muted)
            }
            Section("Available offline") {
                Text("Manage what stays on this Mac in Offline files in the main window.").foregroundStyle(AppDesign.muted)
            }
        }
    }

    private var permissions: some View {
        PermissionsContent(model: model)
    }

    private var advanced: some View {
        Group {
            Section("Engine & diagnostics") {
                LabeledContent("Connection", value: model.usingMock ? "Not connected" : "Connected")
                if model.engineInstall == .notRegistered || model.engineInstall == .requiresApproval {
                    Button("Enable engine…") { model.installEngine() }
                }
                if model.engineInstall == .notInstalled { Text("Install a build that includes the engine to mount drives.").foregroundStyle(AppDesign.muted) }
                if case .failed(let error) = model.engineInstall {
                    Text(error).foregroundStyle(AppDesign.muted)
                    Button("Enable engine…") { model.installEngine() }
                }
                Button("Refresh status") { Task { await model.refresh() } }
                Button("Open logs") { openLogs() }
            }
            Section("Developer") {
                DisclosureGroup("Connection overrides") {
                    TextField("API endpoint", text: $apiOverride, prompt: Text(AppSettings.defaultAPIEndpoint))
                    TextField("Dev endpoint (config.set)", text: $endpoint, prompt: Text("http://127.0.0.1:8787"))
                    SecureField("Dev token", text: $token, prompt: Text(model.hasDevToken ? "Saved (enter to replace)" : "Paste token"))
                    HStack {
                        Button("Save") { save() }
                        Button("Clear dev token") { clearDevToken() }
                    }
                }
            }
        }
    }

    private func save() {
        let api = apiOverride.trimmingCharacters(in: .whitespaces)
        if !api.isEmpty, AppSettings.validateEndpoint(api) == nil {
            message = "API endpoint must be https:// (http:// only for localhost)."
            return
        }
        let ep = endpoint.trimmingCharacters(in: .whitespaces)
        if !ep.isEmpty, AppSettings.validateEndpoint(ep) == nil {
            message = "Dev endpoint must be https:// (http:// only for localhost)."
            return
        }
        AppSettings.apiEndpointOverride = api
        AppSettings.endpoint = ep
        do {
            if !token.isEmpty { try keychain.set(token, account: Keychain.Account.devToken) }
            token = ""
            message = "Saved."
            if !ep.isEmpty { model.pushDevConfig() } else { Task { await model.refresh() } }
        } catch { message = "Keychain error." }
    }

    private func clearDevToken() {
        try? keychain.delete(account: Keychain.Account.devToken)
        message = "Dev token removed."
        Task { await model.refresh() }
    }

    private func openLogs() {
        // App logs go to the unified log; the daemon writes files here.
        let dir = AppPaths.logsDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }
}
