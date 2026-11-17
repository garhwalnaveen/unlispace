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
        case .notRequested, .notEnabled: "Not allowed yet"
        case .enabled: "Allowed"
        case .quiet: "Allowed, delivered quietly"
        case .denied: "Not allowed"
        case .needsApproval: "Needs approval"
        case .unavailable: "Unavailable"
        case .managed: "Asked when needed"
        case .failed: "Couldn't check"
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

/// Permission rows for a grouped form in Settings. macOS prompts appear only when the user presses a button here.
struct PermissionsContent: View {
    var model: AppModel

    var body: some View {
        let items = model.permissionItems
        Section {
            ForEach(items.filter { !$0.optional }) { PermissionRow(model: model, item: $0) }
        } header: {
            Text("Needed for your drives")
        } footer: {
            if case .failed(let message) = model.engine.install { Text(message) }
            else if model.engine.install == .notInstalled { Text("This copy of Orbit can't run in the background. Install the full app.") }
        }
        Section {
            ForEach(items.filter(\.optional)) { PermissionRow(model: model, item: $0) }
        } header: {
            Text("Optional")
        } footer: {
            if let message = model.permissions.notificationMessage ?? model.permissions.loginMessage { Text(message) }
        }
    }
}

/// One permission in Settings: what it is, why Orbit asks, whether it is granted, and a button of its own.
/// Setup shows the same item as a `PermissionCard`.
struct PermissionRow: View {
    var model: AppModel
    var item: PermissionItem

    var body: some View {
        LabeledContent {
            HStack(spacing: 10) {
                Label(item.status.label, systemImage: item.status.symbol)
                    .labelStyle(StatusLabelStyle(tint: item.status.color))
                    .font(.callout).foregroundStyle(.secondary)
                if let action = item.action {
                    Button(action) { model.act(on: item.id) }
                        .accessibilityLabel("\(action): \(item.title)")
                        .disabled(item.status == .checking
                                  || (item.id == .notifications && model.permissions.requestingNotifications))
                }
            }
        } label: {
            Text(item.title)
            Text(item.reason)
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
