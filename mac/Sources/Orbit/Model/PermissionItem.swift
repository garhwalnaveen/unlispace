import AppKit
import OrbitKit

/// One row of the permissions list, shared by setup and Settings so both always say the same thing.
struct PermissionItem: Identifiable, Equatable {
    enum ID: String, CaseIterable { case background, files, notifications, login }

    var id: ID
    var title: String
    /// One sentence on why Orbit asks.
    var reason: String
    var optional: Bool
    var status: AccessStatus
    /// The row's button, or nil when there is nothing to do.
    var action: String?

    var granted: Bool { status == .enabled || status == .quiet }

    static func all(engine: EngineInstallState, notifications: AccessStatus, login: AccessStatus) -> [PermissionItem] {
        let background: String? = switch engine {
        case .notInstalled: nil
        case .enabled: "Manage…"
        case .requiresApproval: "Approve…"
        case .notRegistered, .failed: "Allow"
        }
        return [
            PermissionItem(id: .background, title: "Run in the background",
                           reason: "Keeps your drives in Finder and uploads changes while the Orbit window is closed.",
                           optional: false, status: .engine(engine), action: background),
            PermissionItem(id: .files, title: "Files on your drives",
                           reason: "macOS asks the first time another app opens a file on a drive.",
                           optional: false, status: .managed, action: "Open Settings…"),
            PermissionItem(id: .notifications, title: "Notifications",
                           reason: "Tells you when two versions of a file were kept.",
                           optional: true, status: notifications, action: action(for: notifications)),
            PermissionItem(id: .login, title: "Open at login",
                           reason: "Starts Orbit in the menu bar when you log in.",
                           optional: true, status: login, action: action(for: login)),
        ]
    }

    private static func action(for status: AccessStatus) -> String? {
        switch status {
        case .checking, .unavailable: nil
        case .notRequested, .notEnabled: "Allow"
        case .needsApproval: "Approve…"
        case .denied, .failed: "Open Settings…"
        case .enabled, .quiet, .managed: "Manage…"
        }
    }
}

enum SystemSettings {
    static let filesAndFolders = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
    static let notifications = "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.orbit.app"

    @MainActor static func open(_ address: String) {
        if let url = URL(string: address), NSWorkspace.shared.open(url) { return }
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") {
            NSWorkspace.shared.open(app)
        }
    }
}

extension AppModel {
    var permissionItems: [PermissionItem] {
        PermissionItem.all(engine: engine.install, notifications: permissions.notificationAccess, login: permissions.loginAccess)
    }

    /// Runs a permission row's button. macOS prompts only ever start here, from a press.
    func act(on permission: PermissionItem.ID) {
        switch permission {
        case .background:
            if engine.install == .enabled || engine.install == .requiresApproval {
                DaemonLifecycle.openLoginItemsSettings()
            } else { engine.enable() }
        case .files:
            SystemSettings.open(SystemSettings.filesAndFolders)
        case .notifications:
            if permissions.notificationAccess == .notRequested {
                Task { await permissions.enableNotifications() }
            } else { SystemSettings.open(SystemSettings.notifications) }
        case .login:
            if permissions.loginAccess == .notEnabled { permissions.setLaunchAtLogin(true) }
            else { DaemonLifecycle.openLoginItemsSettings() }
        }
    }
}
