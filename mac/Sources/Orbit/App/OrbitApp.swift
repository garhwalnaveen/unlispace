import SwiftUI
import AppKit
import Darwin
import OrbitKit

/// Builds the model and windows once and handles the AppKit entry points:
/// launch, Dock reopen, and `uls://` URLs (registered in Info.plist by scripts/bundle.sh).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model: AppModel
    let windows: AppWindows

    override init() {
        EngineCommand.runIfRequested()
        model = AppModel()
        windows = AppWindows(model: model)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppAppearance.stored().apply()
        model.start { [windows] in windows.showMain() }
        windows.showMain()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        windows.showMain()
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        Task { await model.refresh() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.shortcut.stop()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { model.handle(url: url) }
    }
}

@main
struct OrbitApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @AppStorage(Preference.appearance) private var appearance = AppAppearance.system

    init() { EngineCommand.runIfRequested() }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: delegate.model).environment(delegate.windows)
        } label: {
            Image(systemName: delegate.model.statusSymbol)
                .accessibilityLabel("Orbit: \(delegate.model.statusTitle)")
        }
        .menuBarExtraStyle(.window)
        .onChange(of: appearance) { _, value in value.apply() }
        Settings {
            SettingsView(model: delegate.model).environment(delegate.windows)
        }
    }
}

/// `Orbit --engine-status | --enable-engine | --disable-engine`, for deployment and support tools.
/// Prints one status word and exits without starting the app.
enum EngineCommand {
    static func runIfRequested() {
        let arguments = CommandLine.arguments.dropFirst()
        guard arguments.count == 1, let action = arguments.first,
              ["--engine-status", "--enable-engine", "--disable-engine"].contains(action) else { return }
        if action == "--disable-engine" {
            do { try DaemonLifecycle.unregisterNow(); print("not_registered"); exit(0) }
            catch { print("failed: \(LogFormat.describe(error))"); exit(1) }
        }
        let state = action == "--enable-engine" ? DaemonLifecycle.register() : DaemonLifecycle.state()
        let status: String
        switch state {
        case .enabled: status = "enabled"
        case .notRegistered: status = "not_registered"
        case .requiresApproval: status = "requires_approval"
        case .notInstalled: status = "not_installed"
        case .failed(let message): status = "failed: \(LogFormat.scrub(message))"
        }
        FileHandle.standardOutput.write(Data((status + "\n").utf8))
        exit(state == .enabled || action == "--engine-status" ? 0 : 1)
    }
}
