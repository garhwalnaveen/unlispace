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
        #expect(AccessStatus.managed.label == "Set per app")
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
