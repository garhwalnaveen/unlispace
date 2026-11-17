import AppKit
import Testing
import OrbitKit
import OrbitTestSupport
@testable import Orbit

@Suite @MainActor struct SetupTests {
    @Test func setupRunsWelcomeBenefitsSignInPermissionsDone() {
        #expect(SetupStep.allCases == [.welcome, .benefits, .signIn, .permissions, .done])
        #expect(SetupStep.welcome.next == .benefits)
        #expect(SetupStep.signIn.next == .permissions)
        #expect(SetupStep.done.next == .done)
        #expect(SetupStep.done.previous == .permissions)
        #expect(SetupStep.welcome.previous == .welcome)
        #expect(Set(SetupStep.allCases.map(\.title)).count == SetupStep.allCases.count)
    }

    @Test func signInSaysWhatItIsWaitingFor() {
        func phase(signingIn: Bool = false, signedIn: Bool = false, connected: Bool = true, prepared: Bool = false) -> SignInPhase {
            .current(signingIn: signingIn, signedIn: signedIn, connected: connected, prepared: prepared)
        }
        #expect(phase() == .signedOut)
        #expect(phase(signingIn: true) == .waitingForBrowser)
        // Switching accounts: the browser is open again even though someone is signed in.
        #expect(phase(signingIn: true, signedIn: true, prepared: true) == .waitingForBrowser)
        #expect(phase(signedIn: true) == .settingUp)
        #expect(phase(signedIn: true, prepared: true) == .signedIn)
        // Without the background service nothing is being set up yet; the permissions page asks for it.
        #expect(phase(signedIn: true, connected: false) == .signedIn)
        #expect(SignInPhase.waitingForBrowser.title == "Finish in your browser")
        #expect(SignInPhase.settingUp.title == "Setting up your drive")
    }

    @Test func theLastPagePromisesADriveOnlyWhenItIsInFinder() {
        let mounting = DriveInfo(driveId: "one", name: "Personal", mountState: .mounting)
        let noPath = DriveInfo(driveId: "one", name: "Personal", mountState: .mounted)
        let idle = DriveInfo(driveId: "one", name: "Personal", mountState: .unmounted)
        let mounted = DriveInfo(driveId: "two", name: "Work", mountState: .mounted, mountPath: "/Volumes/Work")
        func state(connected: Bool = true, prepared: Bool = true, _ drives: [DriveInfo], error: String? = nil) -> SetupDrive {
            .current(connected: connected, prepared: prepared, drives: drives, error: error)
        }
        #expect(state(connected: false, [mounted]) == .needsBackground)
        #expect(state([idle, mounted]) == .ready(mounted))
        #expect(state(prepared: false, []) == .settingUp)
        #expect(state([mounting]) == .settingUp)
        #expect(state([]) == .noDrives)
        #expect(state([idle], error: "refused") == .failed("refused"))
        // A mount without a path cannot be opened, so it is not promised.
        if case .failed = state([noPath]) {} else { Issue.record("a drive without a Finder path is not ready") }
        // A drive already in Finder is left alone; otherwise setup mounts the account's first drive.
        #expect(SetupDrive.driveToMount([idle, mounted]) == nil)
        #expect(SetupDrive.driveToMount([idle]) == idle)
        #expect(SetupDrive.driveToMount([]) == nil)
    }

    @Test func finishingSetupIsRememberedAndClosingItEarlyIsNot() {
        let defaults = MemoryDefaults()
        let model = AppModel(defaults: defaults, engine: EngineLink(makeClient: { MockDaemonClient() }), prompts: StubPrompts())
        #expect(!model.setupCompleted)
        #expect(model.headline.title == "Setup not finished")
        #expect(model.headline.action == .continueSetup)
        model.setupCompleted = true
        #expect(defaults.bool(forKey: Preference.setupCompleted))
        #expect(model.headline.action != .continueSetup)
        #expect(AppModel(defaults: defaults, engine: EngineLink(makeClient: { MockDaemonClient() }), prompts: StubPrompts()).setupCompleted)
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
        // The saved value of a renamed tab still selects it.
        #expect(SettingsPage(rawValue: "Storage") == .storage)
        #expect(SettingsPage.storage.title == "Drives & Storage")
        #expect(SettingsPage.allCases.map(\.title) == ["General", "Account", "Drives & Storage", "Permissions", "Advanced"])
    }
}
