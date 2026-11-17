import Foundation
import ServiceManagement
import UserNotifications
import Testing
import OrbitKit
@testable import Orbit

@Suite @MainActor struct PermissionsTests {
    @Test func notificationsDistinguishUndecidedDeniedQuietAndEnabled() {
        #expect(AccessStatus.notifications(nil) == .unavailable)
        #expect(AccessStatus.notifications(.notDetermined) == .notRequested)
        #expect(AccessStatus.notifications(.denied) == .denied)
        #expect(AccessStatus.notifications(.authorized) == .enabled)
        #expect(AccessStatus.notifications(.provisional) == .quiet)
    }

    @Test func loginItemsDistinguishApprovalAndUnbundledAvailability() {
        #expect(AccessStatus.loginItem(.notFound, bundled: false) == .unavailable)
        #expect(AccessStatus.loginItem(.notFound, bundled: true) == .notEnabled)
        #expect(AccessStatus.loginItem(.notRegistered, bundled: true) == .notEnabled)
        #expect(AccessStatus.loginItem(.requiresApproval, bundled: true) == .needsApproval)
        #expect(AccessStatus.loginItem(.enabled, bundled: true) == .enabled)
    }

    @Test func engineAuthorizationDoesNotClaimAConnectionOrHideFailure() {
        #expect(AccessStatus.engine(.notInstalled) == .unavailable)
        #expect(AccessStatus.engine(.notRegistered) == .notEnabled)
        #expect(AccessStatus.engine(.requiresApproval) == .needsApproval)
        #expect(AccessStatus.engine(.failed("failed")) == .failed)
        #expect(AccessStatus.engine(.enabled) == .enabled)
        #expect(AccessStatus.managed.label == "Asked when needed")
    }

    @Test func everyPermissionHasAReasonAndItsOwnButton() {
        let items = PermissionItem.all(engine: .notRegistered, notifications: .notRequested, login: .notEnabled)
        #expect(items.map(\.id) == [.background, .files, .notifications, .login])
        #expect(items.map(\.optional) == [false, false, true, true])
        #expect(items.allSatisfy { !$0.reason.isEmpty && $0.reason.hasSuffix(".") })
        #expect(items.map(\.action) == ["Allow", "Open Settings…", "Allow", "Allow"])
        #expect(items.allSatisfy { !$0.granted })
        // The words the default UI never uses for the background service.
        #expect(items.allSatisfy { item in ["daemon", "engine"].allSatisfy { !"\(item.title) \(item.reason)".lowercased().contains($0) } })
    }

    @Test func permissionButtonsFollowTheLiveState() {
        func item(_ id: PermissionItem.ID, engine: EngineInstallState = .enabled, notifications: AccessStatus = .enabled,
                  login: AccessStatus = .enabled) -> PermissionItem {
            PermissionItem.all(engine: engine, notifications: notifications, login: login).first { $0.id == id }!
        }
        #expect(item(.background).granted && item(.background).action == "Manage…")
        #expect(item(.background, engine: .requiresApproval).action == "Approve…")
        #expect(item(.background, engine: .failed("no")).action == "Allow")
        // A copy without the background service has nothing to allow.
        #expect(item(.background, engine: .notInstalled).action == nil)
        #expect(item(.notifications, notifications: .quiet).granted)
        #expect(item(.notifications, notifications: .denied).action == "Open Settings…")
        #expect(item(.notifications, notifications: .unavailable).action == nil)
        #expect(item(.notifications, notifications: .checking).action == nil)
        #expect(item(.login, login: .needsApproval).action == "Approve…")
        #expect(!item(.login, login: .needsApproval).granted)
        // macOS grants file access per app, so Orbit never claims it as granted.
        #expect(!item(.files).granted && item(.files).status == .managed)
    }

    @Test func unbundledStatusReadDoesNotInvokeNotificationCenter() async {
        let notifications = ConflictNotifications()
        #expect(await notifications.authorizationStatus() == nil)
    }

    @Test func refreshClearsFeedbackThatNoLongerMatchesTheAuthorization() async {
        let permissions = PermissionsStore()
        permissions.notificationAccess = .enabled
        permissions.notificationMessage = "Previously enabled"
        permissions.loginAccess = .checking
        permissions.loginMessage = "Previous login action"
        await permissions.refresh()
        #expect(permissions.notificationAccess == .unavailable)
        #expect(permissions.notificationMessage == nil)
        #expect(permissions.loginMessage == nil)
        #expect(permissions.loginAccess != .checking)
    }

    @Test func permissionsStartUnknown() {
        let permissions = PermissionsStore()
        #expect(permissions.notificationAccess == .checking)
        #expect(permissions.loginAccess == .checking)
        #expect(!permissions.requestingNotifications)
    }
}
