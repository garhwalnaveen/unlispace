import SwiftUI
import UnlispaceKit

struct SettingsView: View {
    var model: AppModel
    @State private var apiOverride = AppSettings.apiEndpointOverride
    @State private var endpoint = AppSettings.endpoint
    @State private var token = ""
    @State private var cacheGB = AppSettings.cacheCapGB
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var message: String?
    private let keychain = Keychain()

    var body: some View {
        Form {
            Section("Account") {
                if let acct = model.account {
                    LabeledContent("Signed in as", value: acct.email)
                    if model.sessionPending {
                        Text("Waiting for the engine to accept the session.").foregroundStyle(.secondary)
                    }
                    Button("Sign out") { model.signOut() }
                } else {
                    LabeledContent("Status", value: model.hasDevToken ? "Developer token in Keychain" : "Signed out")
                    Button(model.signingIn ? "Waiting for browser…" : "Sign in to Unlispace") { model.signIn() }
                        .disabled(model.signingIn)
                }
            }
            Section("Cache") {
                Stepper("Cache size cap: \(cacheGB) GB", value: $cacheGB, in: 1...2000, step: 5)
                    .onChange(of: cacheGB) { _, v in AppSettings.cacheCapGB = v; model.pushCacheCap() }
            }
            Section("General") {
                Button("Set up Unlispace…") { AppDelegate.showOnboarding() }
                Button("Enable conflict notifications…") { Task { await model.enableConflictNotifications() } }
                if let message = model.notificationMessage { Text(message).foregroundStyle(.secondary) }
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, v in
                        do { try LaunchAtLogin.set(v) }
                        catch { message = error.localizedDescription; launchAtLogin = LaunchAtLogin.isEnabled }
                    }
                Button("Open logs") { openLogs() }
            }
            Section("Advanced") {
                DisclosureGroup("Developer") {
                    TextField("API endpoint", text: $apiOverride, prompt: Text(AppSettings.defaultAPIEndpoint))
                    TextField("Dev endpoint (config.set)", text: $endpoint, prompt: Text("http://127.0.0.1:8787"))
                    SecureField("Dev token", text: $token,
                                prompt: Text(model.hasDevToken ? "Saved (enter to replace)" : "Paste token"))
                    HStack {
                        Button("Save") { save() }
                        Button("Clear dev token") { clearDevToken() }
                    }
                }
            }
            if let message { Text(message).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 480)
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
