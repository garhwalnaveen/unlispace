import SwiftUI
import UnlispaceKit

struct SettingsView: View {
    var model: AppModel
    @State private var endpoint = AppSettings.endpoint
    @State private var token = ""
    @State private var cacheGB = AppSettings.cacheCapGB
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var m1Enabled = DesktopAuth.isEnabled
    @State private var message: String?
    private let keychain = Keychain()

    var body: some View {
        Form {
            Section("Account") {
                LabeledContent("Status", value: model.hasCredentials ? "Token saved in Keychain" : "Signed out")
                if m1Enabled {
                    Button("Sign in with browser (M1, experimental)") { signInM1() }
                }
                Toggle("Enable M1 browser sign-in (experimental)", isOn: $m1Enabled)
                    .onChange(of: m1Enabled) { _, v in UserDefaults.standard.set(v, forKey: DesktopAuth.enabledDefaultsKey) }
            }
            Section("Endpoint") {
                TextField("Endpoint URL", text: $endpoint, prompt: Text("https://api.example.com"))
                SecureField("Dev token", text: $token, prompt: Text(model.hasCredentials ? "Saved (enter to replace)" : "Paste token"))
                HStack {
                    Button("Save") { save() }
                    Button("Sign out") { signOut() }
                }
            }
            Section("Cache") {
                Stepper("Cache size cap: \(cacheGB) GB", value: $cacheGB, in: 1...2000, step: 5)
                    .onChange(of: cacheGB) { _, v in AppSettings.cacheCapGB = v; model.pushConfig() }
            }
            Section("General") {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, v in
                        do { try LaunchAtLogin.set(v) }
                        catch { message = error.localizedDescription; launchAtLogin = LaunchAtLogin.isEnabled }
                    }
                Button("Open logs") { openLogs() }
            }
            if let message { Text(message).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 460)
    }

    private func save() {
        guard AppSettings.validateEndpoint(endpoint) != nil else {
            message = "Endpoint must be https:// (http:// only for localhost)."
            return
        }
        AppSettings.endpoint = endpoint
        do {
            if !token.isEmpty { try keychain.set(token, account: Keychain.Account.devToken) }
            token = ""
            message = "Saved."
            model.pushConfig()
        } catch { message = "Keychain error." }
    }

    private func signOut() {
        try? keychain.delete(account: Keychain.Account.devToken)
        try? keychain.delete(account: Keychain.Account.refreshToken)
        message = "Signed out."
        Task { await model.refresh() }
    }

    private func signInM1() {
        guard let api = AppSettings.validateEndpoint(endpoint) else { message = "Set a valid endpoint first."; return }
        Task {
            do { try await DesktopAuth().signIn(api: api); message = "Signed in." }
            catch { message = "Sign-in failed: \(error)" }
            await model.refresh()
        }
    }

    private func openLogs() {
        // App logs go to the unified log; the daemon writes files here.
        let dir = AppPaths.logsDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }
}
