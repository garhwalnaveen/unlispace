import AppKit
import Testing
import UnlispaceKit
@testable import Unlispace

@Suite @MainActor struct OnboardingTests {
    @Test func aMountMustHaveBothAConfirmedStateAndFinderPath() {
        let mounting = DriveInfo(driveId: "one", name: "Personal", mountState: .mounting)
        let noPath = DriveInfo(driveId: "one", name: "Personal", mountState: .mounted)
        let mounted = DriveInfo(driveId: "one", name: "Personal", mountState: .mounted, mountPath: "/Volumes/Personal")
        #expect(!OnboardingView.mountsReady(["one"], drives: []))
        #expect(!OnboardingView.mountsReady(["one"], drives: [mounting]))
        #expect(!OnboardingView.mountsReady(["one"], drives: [noPath]))
        #expect(!OnboardingView.mountsReady(["one", "missing"], drives: [mounted]))
        #expect(OnboardingView.mountsReady(["one"], drives: [mounted]))
        #expect(OnboardingView.mountsReady([], drives: [mounting]))
    }

    @Test func shortcutRecorderPreservesSpotlightAndRejectsTypingKeys() {
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: [.option]) == .option)
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: [.control, .option, .capsLock]) == .controlOption)
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: [.command, .option]) == .commandOption)
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: [.command]) == nil)
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: [.control]) == nil)
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: []) == nil)
        #expect(WorkspaceShortcut.from(keyCode: 49, flags: [.option, .shift]) == nil)
        #expect(WorkspaceShortcut.from(keyCode: 0, flags: [.option]) == nil)
    }

    @Test func savedShortcutRestoresWithoutRegisteringAHotkey() throws {
        let name = "onboarding-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        #expect(AppModel(defaults: defaults).workspaceShortcut == .option)
        defaults.set("controlOption", forKey: "workspaceShortcut")
        #expect(AppModel(defaults: defaults).workspaceShortcut == .controlOption)
        defaults.set("invalid", forKey: "workspaceShortcut")
        #expect(AppModel(defaults: defaults).workspaceShortcut == .option)
    }
}
