import SwiftUI
import ServiceManagement
import UserNotifications
import OrbitKit

/// What macOS reports for one authorization. It says nothing about whether the engine is connected.
enum AccessStatus: Equatable {
    case checking, notRequested, enabled, quiet, denied, notEnabled, needsApproval, unavailable, managed, failed

    var label: String {
        switch self {
        case .checking: "Checking…"
        case .notRequested: "Off"
        case .enabled: "On"
        case .quiet: "Delivered quietly"
        case .denied: "Not allowed"
        case .notEnabled: "Off"
        case .needsApproval: "Needs approval"
        case .unavailable: "Unavailable"
        case .managed: "Set per app"
        case .failed: "Failed"
        }
    }

    var symbol: String {
        switch self {
        case .enabled, .quiet: "checkmark.circle.fill"
        case .denied, .needsApproval, .failed: "exclamationmark.circle.fill"
        case .managed: "info.circle"
        default: "circle.dashed"
        }
    }

    var color: Color {
        switch self {
        case .enabled: .green
        case .denied, .needsApproval, .failed: .orange
        default: .secondary
        }
    }

    static func notifications(_ status: UNAuthorizationStatus?) -> Self {
        guard let status else { return .unavailable }
        return switch status {
        case .notDetermined: .notRequested
        case .authorized: .enabled
        case .provisional: .quiet
        case .denied: .denied
        @unknown default: .failed
        }
    }

    static func loginItem(_ status: SMAppService.Status, bundled: Bool = DaemonLifecycle.isBundled) -> Self {
        switch status {
        case .enabled: .enabled
        case .notRegistered: .notEnabled
        case .requiresApproval: .needsApproval
        case .notFound: bundled ? .notEnabled : .unavailable
        @unknown default: .failed
        }
    }

    static func engine(_ status: EngineInstallState) -> Self {
        switch status {
        case .enabled: .enabled
        case .notRegistered: .notEnabled
        case .requiresApproval: .needsApproval
        case .notInstalled: .unavailable
        case .failed: .failed
        }
    }
}

/// Permission rows for a grouped form. macOS prompts appear only when the user presses a button here.
struct PermissionsContent: View {
    var model: AppModel

    private var engine: EngineLink { model.engine }
    private var permissions: PermissionsStore { model.permissions }

    var body: some View {
        Section {
            PermissionRow(title: "Background service", detail: "Keeps drives mounted and uploads your changes.",
                          status: .engine(engine.install), actionTitle: engineAction) {
                if engine.install == .enabled || engine.install == .requiresApproval {
                    DaemonLifecycle.openLoginItemsSettings()
                } else { engine.enable() }
            }
            PermissionRow(title: "Files and folders", detail: "macOS asks each app the first time it opens a file on a drive.",
                          status: .managed, actionTitle: "Open Settings…") {
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
            }
        } header: {
            Text("Required")
        } footer: {
            if case .failed(let message) = engine.install { Text(message) }
            else if engine.install == .notInstalled { Text("This copy of Orbit has no background service. Install the full app.") }
        }
        Section {
            PermissionRow(title: "Conflict notifications", detail: "Tells you when two versions of a file were kept.",
                          status: permissions.notificationAccess, actionTitle: notificationAction) {
                if permissions.notificationAccess == .notRequested {
                    Task { await permissions.enableNotifications() }
                } else {
                    openSettings("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.orbit.app")
                }
            }
            .disabled(permissions.requestingNotifications)
            PermissionRow(title: "Open at login", detail: "Starts Orbit in the menu bar when you log in.",
                          status: permissions.loginAccess, actionTitle: loginAction) {
                if permissions.loginAccess == .notEnabled { permissions.setLaunchAtLogin(true) }
                else { DaemonLifecycle.openLoginItemsSettings() }
            }
        } header: {
            Text("Optional")
        } footer: {
            if let message = permissions.notificationMessage ?? permissions.loginMessage { Text(message) }
        }
    }

    private var engineAction: String? {
        switch engine.install {
        case .notInstalled: nil
        case .enabled: "Manage…"
        case .requiresApproval: "Approve…"
        default: "Turn On"
        }
    }

    private var notificationAction: String? {
        switch permissions.notificationAccess {
        case .checking, .unavailable: nil
        case .notRequested: "Turn On"
        default: "Open Settings…"
        }
    }

    private var loginAction: String? {
        switch permissions.loginAccess {
        case .checking, .unavailable: nil
        case .notEnabled: "Turn On"
        case .needsApproval: "Approve…"
        default: "Manage…"
        }
    }

    private func openSettings(_ address: String) {
        if let url = URL(string: address), NSWorkspace.shared.open(url) { return }
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") {
            NSWorkspace.shared.open(app)
        }
    }
}

private struct PermissionRow: View {
    var title: String
    var detail: String
    var status: AccessStatus
    var actionTitle: String?
    var action: () -> Void

    var body: some View {
        LabeledContent {
            HStack(spacing: 10) {
                Label(status.label, systemImage: status.symbol)
                    .labelStyle(StatusLabelStyle(tint: status.color))
                    .font(.callout).foregroundStyle(.secondary)
                if let actionTitle {
                    Button(actionTitle, action: action)
                        .accessibilityLabel("\(actionTitle): \(title)")
                        .disabled(status == .checking)
                }
            }
        } label: {
            Text(title)
            Text(detail)
        }
    }
}

private struct StatusLabelStyle: LabelStyle {
    var tint: Color

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon.foregroundStyle(tint)
            configuration.title
        }
    }
}
