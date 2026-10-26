import SwiftUI
import AppKit
import Darwin
import UnlispaceKit

/// Receives `uls://` URLs (registered in Info.plist by scripts/bundle.sh).
final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static weak var model: AppModel?
    @MainActor private static var onboardingWindow: NSWindow?
    @MainActor private static var workspaceWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.model?.start()
        Self.showWorkspace()
        if !UserDefaults.standard.bool(forKey: "onboardingCompleted") { Self.showOnboarding() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Self.showWorkspace()
        return true
    }

    @MainActor static func showWorkspace() {
        guard let model else { return }
        if workspaceWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: WorkspaceView(model: model)))
            window.title = "Unlispace"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            window.isReleasedWhenClosed = false
            window.setContentSize(NSSize(width: 1000, height: 680))
            window.contentMinSize = NSSize(width: 800, height: 580)
            window.center()
            workspaceWindow = window
        }
        workspaceWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    @MainActor static func showOnboarding() {
        guard let model else { return }
        if onboardingWindow == nil {
            let view = OnboardingView(model: model) {
                onboardingWindow?.close()
                onboardingWindow = nil
            }
            let window = NSWindow(contentViewController: NSHostingController(rootView: view))
            window.title = "Set up Unlispace"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.center()
            onboardingWindow = window
        }
        onboardingWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            for url in urls { Self.model?.handle(url: url) }
        }
    }
}

@main
struct UnlispaceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @AppStorage("appearance") private var appearance = "system"
    @State private var model: AppModel

    init() {
        // The bundled executable also supports engine setup from deployment/support tools.
        let command = CommandLine.arguments.dropFirst()
        if command.count == 1, let action = command.first,
           action == "--engine-status" || action == "--enable-engine" || action == "--disable-engine" {
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
        let model = AppModel()
        _model = State(initialValue: model)
        AppDelegate.model = model
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
                .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
        } label: {
            Image(systemName: model.symbolName)
                .accessibilityLabel("Unlispace: \(model.status.title)")
        }
        .menuBarExtraStyle(.window)
        Settings {
            SettingsView(model: model)
                .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
        }
    }
}
