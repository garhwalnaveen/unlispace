import Foundation
import Observation

/// The global shortcut that opens the Orbit window.
@MainActor @Observable
final class ShortcutStore {
    private(set) var shortcut: WorkspaceShortcut
    /// Set when macOS refuses the shortcut, usually because another app holds it.
    private(set) var problem: String?

    @ObservationIgnored private let hotKey = WorkspaceHotKey()
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
        shortcut = WorkspaceShortcut(rawValue: defaults.string(forKey: Preference.workspaceShortcut) ?? "") ?? .option
    }

    /// Registers the saved shortcut. Creating the store does not, so tests and previews stay inert.
    func start(onPress: @escaping @MainActor () -> Void) {
        hotKey.onPress = onPress
        select(shortcut)
    }

    func select(_ new: WorkspaceShortcut) {
        guard hotKey.register(new) else {
            problem = "\(new.label) is in use by another app. Choose a different shortcut."
            return
        }
        problem = nil
        shortcut = new
        defaults.set(new.rawValue, forKey: Preference.workspaceShortcut)
    }

    func stop() { hotKey.stop() }
}
