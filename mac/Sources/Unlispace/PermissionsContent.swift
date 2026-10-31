import SwiftUI
import ServiceManagement
import UserNotifications
import UnlispaceKit

/// A status describes the actual OS authorization, independently of an engine connection.
enum AccessStatus: Equatable {
    case checking, notRequested, enabled, quiet, denied, notEnabled, needsApproval, unavailable, managed, failed

    var label: String {
        switch self {
        case .checking: "Checking…"
        case .notRequested: "Not requested"
        case .enabled: "Enabled"
        case .quiet: "Quiet delivery"
        case .denied: "Not allowed"
        case .notEnabled: "Not enabled"
        case .needsApproval: "Needs approval"
        case .unavailable: "Unavailable"
        case .managed: "Managed by each app"
        case .failed: "Needs attention"
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

/// Shared, passive permission UI. OS prompts happen only from the action buttons.
struct PermissionsContent: View {
    var model: AppModel
    var onboarding = false

    var body: some View {
        if !onboarding {
            Section {
                Label("Access on your terms", systemImage: "hand.raised.fill").font(.headline)
                Text("Review what each feature needs. You choose when to enable access, and optional features can be set up later.")
                    .foregroundStyle(AppDesign.muted)
                Button("Refresh access status", systemImage: "arrow.clockwise") {
                    Task { await model.refreshPermissions() }
                }
            }
        }
        Section("For your drives") {
            PermissionRow(title: "Background engine", symbol: "externaldrive.badge.checkmark", optional: false,
                          purpose: "Keeps your mounted drives available and synchronizes files you add or edit.",
                          status: .engine(model.engineInstall),
                          actionTitle: engineAction, compact: onboarding) {
                if model.engineInstall == .enabled || model.engineInstall == .requiresApproval {
                    DaemonLifecycle.openLoginItemsSettings()
                } else { model.installEngine() }
            }
            if case .failed(let message) = model.engineInstall {
                Text(message).font(.caption).foregroundStyle(AppDesign.muted)
            } else if model.engineInstall == .notInstalled {
                Text("Install a complete Unlispace app build with its engine to continue.")
                    .font(.caption).foregroundStyle(AppDesign.muted)
            }
            PermissionRow(title: "Network volume access", symbol: "folder", optional: false,
                          purpose: "macOS treats Unlispace drives as network volumes. Finder, your editor, and other apps may each ask to open their files.",
                          status: .managed, actionTitle: "Open settings", compact: onboarding) {
                openSettings(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!)
            }
            if !onboarding {
                Text("Manage each app under Privacy & Security → Files and Folders. macOS does not provide Unlispace with one permission switch for every app.")
                    .font(.caption).foregroundStyle(AppDesign.muted)
            }
        }
        Section("Optional conveniences") {
            PermissionRow(title: "Conflict notifications", symbol: "bell", optional: true,
                          purpose: "Get an alert when a conflicting edit is preserved as a separate copy. Conflict details also appear in Unlispace.",
                          status: model.notificationAccess,
                          actionTitle: notificationAction, compact: onboarding) {
                if model.notificationAccess == .notRequested {
                    Task { await model.enableConflictNotifications() }
                } else {
                    openSettings(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.unlispace.app")!)
                }
            }
            .disabled(model.requestingNotifications)
            PermissionRow(title: "Launch at login", symbol: "sunrise", optional: true,
                          purpose: "Open Unlispace when you sign in to your Mac, ready in the menu bar.",
                          status: model.loginAccess,
                          actionTitle: loginAction, compact: onboarding) {
                if model.loginAccess == .notEnabled { model.setLaunchAtLogin(true) }
                else { DaemonLifecycle.openLoginItemsSettings() }
            }
        }
        if let message = model.permissionMessage ?? model.notificationMessage {
            Section { Text(message).font(.callout).foregroundStyle(AppDesign.muted).textSelection(.enabled) }
        }
        if !onboarding {
            Section("What happens to your files") {
                Text("Files you add to a mounted drive are uploaded to your configured Unlispace service. Each app controls its own access to that drive.")
                    .font(.callout).foregroundStyle(AppDesign.muted)
            }
        }
    }

    private var engineAction: String? {
        switch model.engineInstall {
        case .notInstalled: nil
        case .enabled: "Manage"
        case .requiresApproval: "Review access"
        default: "Enable engine"
        }
    }

    private var notificationAction: String? {
        switch model.notificationAccess {
        case .checking, .unavailable: nil
        case .notRequested: "Enable alerts"
        default: "Open settings"
        }
    }

    private var loginAction: String? {
        switch model.loginAccess {
        case .checking, .unavailable: nil
        case .notEnabled: "Enable"
        case .needsApproval: "Review access"
        default: "Manage"
        }
    }

    private func openSettings(_ url: URL) {
        if !NSWorkspace.shared.open(url),
           let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") {
            NSWorkspace.shared.open(app)
        }
    }
}

private struct PermissionRow: View {
    var title: String
    var symbol: String
    var optional: Bool
    var purpose: String
    var status: AccessStatus
    var actionTitle: String?
    var compact = false
    var action: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.title3).foregroundStyle(AppDesign.muted).frame(width: 28).padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: compact ? 5 : 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.system(size: compact ? 14 : 13, weight: .semibold))
                    Spacer()
                    Text(optional ? "Optional" : "Drive access").font(.caption).foregroundStyle(AppDesign.muted)
                }
                Text(purpose).font(.system(size: compact ? 12 : 13)).foregroundStyle(AppDesign.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Label {
                        Text(status.label).foregroundStyle(.primary)
                    } icon: {
                        Image(systemName: status.symbol).foregroundStyle(status.color)
                    }.font(.caption)
                    Spacer()
                    if let actionTitle {
                        Button(actionTitle, action: action)
                            .accessibilityLabel("\(actionTitle): \(title)")
                            .disabled(status == .checking)
                    }
                }
            }
        }
        .padding(.vertical, 8)
    }
}
