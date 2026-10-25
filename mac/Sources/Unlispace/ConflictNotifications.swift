import UserNotifications
import UnlispaceKit

@MainActor
final class ConflictNotifications: NSObject, UNUserNotificationCenterDelegate {
    func enable() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        return try await center.requestAuthorization(options: [.alert])
    }

    func post(_ conflict: ConflictEvent) async throws {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = "Conflicting edit saved"
        content.body = "Your edit to \(conflict.path) was saved as \(conflict.copy). The remote version is unchanged."
        try await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }
}
