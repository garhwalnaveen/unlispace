import SwiftUI
import AppKit
import UnlispaceKit

/// Receives `uls://` URLs (registered in Info.plist by scripts/bundle.sh).
final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static weak var model: AppModel?

    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            for url in urls { Self.model?.handle(url: url) }
        }
    }
}

@main
struct UnlispaceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
                .task {
                    AppDelegate.model = model
                    model.start()
                }
        } label: {
            Image(systemName: model.symbolName)
        }
        Settings {
            SettingsView(model: model)
        }
    }
}
