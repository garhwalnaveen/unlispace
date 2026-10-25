import SwiftUI
import AppKit
import UnlispaceKit

/// Receives `uls://` URLs (registered in Info.plist by scripts/bundle.sh).
final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static weak var model: AppModel?
    @MainActor private static var onboardingWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.model?.start()
        if !UserDefaults.standard.bool(forKey: "onboardingCompleted") { Self.showOnboarding() }
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
    @State private var model: AppModel

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        AppDelegate.model = model
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Image(systemName: model.symbolName)
                .accessibilityLabel("Unlispace: \(model.status.title)")
        }
        .menuBarExtraStyle(.window)
        Settings {
            SettingsView(model: model)
        }
    }
}
