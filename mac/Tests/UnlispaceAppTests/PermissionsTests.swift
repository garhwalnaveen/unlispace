import Foundation
import ServiceManagement
import UserNotifications
import Testing
import UnlispaceKit
@testable import Unlispace

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
        #expect(AccessStatus.managed.label == "Managed by each app")
    }

    @Test func unbundledStatusReadDoesNotInvokeNotificationCenter() async {
        let notifications = ConflictNotifications()
        #expect(await notifications.authorizationStatus() == nil)
    }

    @Test func refreshClearsFeedbackThatNoLongerMatchesTheAuthorization() async {
        let model = AppModel()
        model.notificationAccess = .enabled
        model.notificationMessage = "Previously enabled"
        model.permissionMessage = "Previous login action"
        await model.refreshPermissions()
        #expect(model.notificationAccess == .unavailable)
        #expect(model.notificationMessage == nil)
        #expect(model.permissionMessage == nil)
        #expect(model.loginAccess != .checking)
    }

    @Test func modelStartsWithUnknownPermissionStates() {
        let model = AppModel()
        #expect(model.notificationAccess == .checking)
        #expect(model.loginAccess == .checking)
        #expect(!model.requestingNotifications)
    }
}
