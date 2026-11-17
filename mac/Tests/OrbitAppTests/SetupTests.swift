import AppKit
import Testing
import OrbitKit
@testable import Orbit

@Suite @MainActor struct SetupTests {
    @Test func setupHasThreeSteps() {
        #expect(SetupStep.allCases == [.signIn, .drives, .shortcut])
        #expect(SetupStep.signIn.next == .drives)
        #expect(SetupStep.drives.next == .shortcut)
        #expect(SetupStep.shortcut.next == .shortcut)
        #expect(SetupStep.shortcut.previous == .drives)
        #expect(SetupStep.signIn.previous == .signIn)
    }

    @Test func aMountMustHaveBothAConfirmedStateAndFinderPath() {
        let mounting = DriveInfo(driveId: "one", name: "Personal", mountState: .mounting)
        let noPath = DriveInfo(driveId: "one", name: "Personal", mountState: .mounted)
        let mounted = DriveInfo(driveId: "one", name: "Personal", mountState: .mounted, mountPath: "/Volumes/Personal")
        #expect(!SetupView.mountsReady(["one"], drives: []))
        #expect(!SetupView.mountsReady(["one"], drives: [mounting]))
        #expect(!SetupView.mountsReady(["one"], drives: [noPath]))
        #expect(!SetupView.mountsReady(["one", "missing"], drives: [mounted]))
        #expect(SetupView.mountsReady(["one"], drives: [mounted]))
        #expect(SetupView.mountsReady([], drives: [mounting]))
    }

    @Test func shortcutsAreDistinctAndNeverCommandSpace() {
        #expect(Set(WorkspaceShortcut.allCases.map(\.label)).count == WorkspaceShortcut.allCases.count)
        #expect(Set(WorkspaceShortcut.allCases.map(\.modifiers)).count == WorkspaceShortcut.allCases.count)
        #expect(!WorkspaceShortcut.allCases.map(\.label).contains("⌘Space"))
    }

    @Test func savedShortcutRestoresWithoutRegisteringAHotkey() throws {
        let (defaults, cleanup) = Fixtures.defaults()
        defer { cleanup() }
        #expect(ShortcutStore(defaults: defaults).shortcut == .option)
        defaults.set("controlOption", forKey: Preference.workspaceShortcut)
        #expect(ShortcutStore(defaults: defaults).shortcut == .controlOption)
        defaults.set("invalid", forKey: Preference.workspaceShortcut)
        let store = ShortcutStore(defaults: defaults)
        #expect(store.shortcut == .option)
        #expect(store.problem == nil)
    }

    @Test func preferencesFallBackToDefaultsForUnknownStoredValues() throws {
        let (defaults, cleanup) = Fixtures.defaults()
        defer { cleanup() }
        #expect(AppAppearance.stored(in: defaults) == .system)
        defaults.set("dark", forKey: Preference.appearance)
        #expect(AppAppearance.stored(in: defaults) == .dark)
        defaults.set("sepia", forKey: Preference.appearance)
        #expect(AppAppearance.stored(in: defaults) == .system)
        // Pages removed from Settings must not strand a saved selection.
        #expect(SettingsPage(rawValue: "Ask AI") == nil)
        #expect(SettingsPage(rawValue: "General") == .general)
    }
}
