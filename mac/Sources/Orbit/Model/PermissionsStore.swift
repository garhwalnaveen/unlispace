import Observation
import ServiceManagement
import OrbitKit

/// macOS authorizations the app depends on. Nothing here prompts unless the user presses a button.
@MainActor @Observable
final class PermissionsStore {
    var notificationAccess: AccessStatus = .checking
    var loginAccess: AccessStatus = .checking
    private(set) var requestingNotifications = false
    var loginMessage: String?
    var notificationMessage: String?

    @ObservationIgnored private let notifications = ConflictNotifications()

    func refresh() async {
        let login = AccessStatus.loginItem(SMAppService.mainApp.status)
        let notification = AccessStatus.notifications(await notifications.authorizationStatus())
        if loginAccess != login { loginMessage = nil }
        if notificationAccess != notification { notificationMessage = nil }
        loginAccess = login
        notificationAccess = notification
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            try LaunchAtLogin.set(enabled)
            loginAccess = .loginItem(SMAppService.mainApp.status)
            loginMessage = loginAccess == .needsApproval ? "Allow Orbit in System Settings › General › Login Items." : nil
        } catch {
            loginAccess = .loginItem(SMAppService.mainApp.status)
            loginMessage = "Could not change launch at login: \(LogFormat.describe(error))"
        }
    }

    func enableNotifications() async {
        guard !requestingNotifications else { return }
        requestingNotifications = true
        loginMessage = nil
        defer { requestingNotifications = false }
        let feedback: String?
        do {
            feedback = try await notifications.enable() ? nil : "Notifications are off. Turn them on in System Settings › Notifications › Orbit."
        } catch {
            feedback = "Could not turn on notifications: \(LogFormat.describe(error))"
        }
        await refresh()
        notificationMessage = feedback
    }

    func notify(_ conflict: ConflictEvent) {
        Task {
            do { try await notifications.post(conflict) }
            catch { notificationMessage = "Could not show a conflict notification: \(LogFormat.describe(error))" }
        }
    }
}
