import AppKit
import Observation
import SwiftUI

/// Which page the main window shows. Shared so the menu bar and shortcuts can pick a page.
@MainActor @Observable
final class WorkspaceNavigation {
    var page: WorkspacePage = .drives
    var showingNewDrive = false
}

/// Creates and shows the app's windows. Views receive it through the environment; nothing reaches for a global.
@MainActor @Observable
final class AppWindows {
    let navigation = WorkspaceNavigation()

    @ObservationIgnored private let model: AppModel
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var workspace: NSWindow?
    @ObservationIgnored private var setup: NSWindow?

    init(model: AppModel, defaults: UserDefaults = .standard) {
        self.model = model
        self.defaults = defaults
    }

    private var setupCompleted: Bool { defaults.bool(forKey: Preference.setupCompleted) }

    /// The window to show at launch, on Dock click, and for the global shortcut.
    func showMain() {
        if setup?.isVisible == true || !setupCompleted { showSetup() } else { showWorkspace() }
    }

    func showWorkspace(page: WorkspacePage? = nil) {
        if let page { navigation.page = page }
        if workspace == nil {
            let view = WorkspaceView(model: model, navigation: navigation).environment(self)
            workspace = makeWindow(size: NSSize(width: 900, height: 600), minimum: NSSize(width: 680, height: 440),
                                   autosave: "OrbitWorkspace", content: view)
            workspace?.toolbarStyle = .unified
        }
        present(workspace)
    }

    func showSetup() {
        if setup == nil {
            let view = SetupView(model: model) { [weak self] in self?.finishSetup() }.environment(self)
            setup = makeWindow(size: NSSize(width: 560, height: 520), minimum: NSSize(width: 520, height: 480),
                               autosave: nil, content: view)
        }
        present(setup)
    }

    private func finishSetup() {
        defaults.set(true, forKey: Preference.setupCompleted)
        setup?.close()
        setup = nil
        showWorkspace()
    }

    /// Each root view names its own window with `windowTitle`.
    private func makeWindow(size: NSSize, minimum: NSSize, autosave: String?, content: some View) -> NSWindow {
        let controller = NSHostingController(rootView: content)
        // The window owns its size. Without this the hosting view sizes itself to the content's ideal height.
        controller.sizingOptions = []
        let window = NSWindow(contentViewController: controller)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.applyOrbitChrome()
        window.isReleasedWhenClosed = false
        window.setContentSize(size)
        window.contentMinSize = minimum
        window.center()
        if let autosave { window.setFrameAutosaveName(autosave) }
        return window
    }

    private func present(_ window: NSWindow?) {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}
