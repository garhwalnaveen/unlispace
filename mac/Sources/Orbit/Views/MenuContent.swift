import SwiftUI
import OrbitKit

/// The menu-bar panel: status, the first few drives, and app commands.
struct MenuContent: View {
    var model: AppModel
    @Environment(AppWindows.self) private var windows: AppWindows?
    @Environment(\.openSettings) private var openSettings

    /// Drives listed before "Show All". The window has the full, filterable list.
    static let driveLimit = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            notices
            Divider().padding(.vertical, 6)
            if model.session.hasCredentials {
                drives
                Divider().padding(.vertical, 6)
            }
            commands
        }
        .padding(10)
        .frame(width: 320)
        .orbitControls()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Orbit menu")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            OrbitMark(size: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.session.account?.email ?? "Orbit").font(.headline).lineLimit(1).truncationMode(.middle)
                Label(model.statusTitle, systemImage: model.statusSymbol).orbitLabel().foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Open Orbit") { windows?.showWorkspace() }
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
    }

    @ViewBuilder private var notices: some View {
        let messages = model.messages
        VStack(alignment: .leading, spacing: 6) {
            if !model.session.hasCredentials {
                HStack { SignInControls(session: model.session) }
            }
            if let error = messages.error {
                Label(error, systemImage: "exclamationmark.octagon").foregroundStyle(Theme.danger).lineLimit(3)
            }
            if let conflict = messages.conflict {
                Label(StatusBanner.conflictText(conflict), systemImage: "exclamationmark.triangle").lineLimit(3)
            }
            if let notice = messages.notice { Text(notice).foregroundStyle(.secondary).lineLimit(3) }
        }
        .font(.callout)
        .padding(.horizontal, 6)
        .padding(.top, 4)
    }

    @ViewBuilder private var drives: some View {
        let all = model.drives.drives
        if !model.engine.isConnected {
            Text("Drives appear when the background service is running.")
                .font(.callout).foregroundStyle(.secondary).padding(.horizontal, 6)
        } else if all.isEmpty {
            Text("No drives").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 6)
        } else {
            ForEach(all.prefix(Self.driveLimit)) { drive in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(drive.name).lineLimit(1)
                        MountStateLabel(state: drive.mountState)
                    }
                    Spacer(minLength: 8)
                    if drive.mountState == .mounted {
                        Button("Open") { model.drives.openInFinder(drive) }
                            .accessibilityLabel("Open \(drive.name) in Finder")
                    } else {
                        Button("Mount") { model.drives.mount(drive) }.disabled(model.drives.isBusy(drive))
                            .accessibilityLabel("Mount \(drive.name)")
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 3)
                .contextMenu { DriveActions(store: model.drives, drive: drive) }
            }
            if all.count > Self.driveLimit {
                command("Show All \(all.count) Drives") { windows?.showWorkspace(page: .drives) }
            }
        }
        if model.engine.isConnected {
            command(model.activity.progressLine ?? "Activity") { windows?.showWorkspace(page: .activity) }
        }
    }

    @ViewBuilder private var commands: some View {
        if !model.engine.isConnected { command("Set Up Orbit…") { windows?.showSetup() } }
        command("Settings…") {
            NSApp.activate()
            openSettings()
        }
        .keyboardShortcut(",")
        if model.updates.isEnabled { command("Check for Updates…") { model.updates.checkForUpdates() } }
        if model.session.hasCredentials {
            command("Sign Out") { model.signOut() }.disabled(model.drives.copyingFile)
        }
        command("Quit Orbit") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private func command(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(MenuCommandStyle())
    }
}

/// A full-width row that highlights on hover, like a menu item.
private struct MenuCommandStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 6).padding(.vertical, 4)
            .foregroundStyle(enabled ? .primary : .tertiary)
            .background((hovering && enabled) || configuration.isPressed ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                        in: RoundedRectangle(cornerRadius: 5))
            .onHover { hovering = $0 }
    }
}
