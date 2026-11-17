import SwiftUI
import OrbitKit

/// The menu-bar panel: one status headline with one action, then drives, recent activity, and three commands.
struct MenuContent: View {
    var model: AppModel
    @Environment(AppWindows.self) private var windows: AppWindows?
    @Environment(\.openSettings) private var openSettings

    /// Drives listed before "Show All". The window has the full, filterable list.
    /// Fewer while the Get started list is showing, so the panel stays short.
    static func driveLimit(gettingStarted: Bool) -> Int { gettingStarted ? 3 : 5 }
    static let activityLimit = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            titleBar
            HeadlineCard(model: model, headline: model.headline)
            notices
            if model.showsGetStarted {
                GetStartedList(model: model, compact: true, headlineAction: model.headline.action).orbitCard(padding: 10)
            }
            if model.isLive {
                drives
                activity
            }
            Divider()
            footer
        }
        .padding(12)
        .frame(width: 340)
        .orbitControls()
        .task(id: model.workspaces.loadKey) { await model.workspaces.load() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Orbit menu")
    }

    private var titleBar: some View {
        HStack(spacing: 8) {
            OrbitMark(size: 18)
            Text("Orbit").font(.headline)
            Spacer(minLength: 8)
            if let email = model.session.account?.email {
                Text(email).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Button("Open Orbit Window", systemImage: "macwindow") { windows?.showMain() }
                .labelStyle(.iconOnly).buttonStyle(.borderless).help("Open the Orbit window")
        }
    }

    @ViewBuilder private var notices: some View {
        let messages = model.messages
        // The headline already shows the error when it is the sync error itself.
        let error = model.headline.detail == messages.error ? nil : messages.error
        if error != nil || messages.conflict != nil || messages.notice != nil {
            VStack(alignment: .leading, spacing: 6) {
                if let error {
                    Label(error, systemImage: "exclamationmark.octagon").foregroundStyle(Theme.danger).lineLimit(3)
                        .accessibilityLabel("Error: \(error)")
                }
                if let conflict = messages.conflict {
                    Label(StatusBanner.conflictText(conflict), systemImage: "exclamationmark.triangle").lineLimit(3)
                }
                if let notice = messages.notice { Text(notice).foregroundStyle(.secondary).lineLimit(3) }
            }
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var drives: some View {
        let all = model.drives.drives
        let limit = Self.driveLimit(gettingStarted: model.showsGetStarted)
        if !all.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                sectionHeader("Drives", more: all.count > limit ? "Show All \(all.count)" : nil) {
                    windows?.showWorkspace(page: .drives)
                }
                ForEach(all.prefix(limit)) { drive in
                    HStack(spacing: 8) {
                        Image(systemName: "externaldrive").foregroundStyle(.secondary).frame(width: 18).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(drive.name).lineLimit(1)
                            MountStateLabel(state: drive.mountState)
                        }
                        Spacer(minLength: 8)
                        Button("Open in Finder") { model.drives.open(drive) }
                            .controlSize(.small).disabled(model.drives.isBusy(drive))
                            .accessibilityLabel("Open \(drive.name) in Finder")
                    }
                    .padding(.vertical, 2)
                    .contextMenu {
                        DriveActions(model: model, drive: drive) { edit in
                            windows?.showWorkspace(page: .drives)
                            windows?.navigation.driveEdit = edit
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var activity: some View {
        let items = model.activity.items
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader("Recent activity", more: items.isEmpty ? nil : "Show All") {
                windows?.showWorkspace(page: .activity)
            }
            if items.isEmpty {
                Text("Nothing is uploading. Changes you make in Finder show up here.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(items.prefix(Self.activityLimit)) { item in
                    let content = ActivityRowContent(item)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: content.symbol)
                            .foregroundStyle(content.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                            .frame(width: 18).accessibilityHidden(true)
                        Text(content.title).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        Text(content.status).font(.caption).lineLimit(1)
                            .foregroundStyle(content.failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    }
                    .padding(.vertical, 1)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func sectionHeader(_ title: String, more: String?, action: @escaping () -> Void) -> some View {
        HStack {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
            Spacer()
            if let more { Button(more, action: action).buttonStyle(.link).font(.caption) }
        }
    }

    private var footer: some View {
        HStack(spacing: 4) {
            if let home = model.workspaces.config?.home {
                Link("Open on the Web", destination: home).buttonStyle(MenuCommandStyle())
            } else {
                Button("Open on the Web") {}.buttonStyle(MenuCommandStyle()).disabled(true)
                    .help("Available once you are signed in and connected.")
            }
            Spacer(minLength: 0)
            Button("Settings…") {
                NSApp.activate()
                openSettings()
            }
            .buttonStyle(MenuCommandStyle()).keyboardShortcut(",")
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(MenuCommandStyle()).keyboardShortcut("q").accessibilityLabel("Quit Orbit")
        }
    }
}

/// The headline, its one line of explanation, and its one button.
struct HeadlineCard: View {
    var model: AppModel
    var headline: MenuHeadline
    @Environment(AppWindows.self) private var windows: AppWindows?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: headline.symbol).font(.title2).foregroundStyle(headline.tone.color)
                    .frame(width: 26).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if let detail = headline.detail {
                        Text(detail).font(.callout).foregroundStyle(.secondary).lineLimit(4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            if let action = headline.action {
                HStack(spacing: 8) {
                    Button(action.title) { action.perform(model: model, windows: windows) }
                        .buttonStyle(.borderedProminent)
                    if action == .openBrowserAgain { Button("Cancel") { model.session.cancelSignIn() } }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .orbitCard()
        .accessibilityElement(children: .contain)
    }
}

extension MenuHeadline.Action {
    @MainActor func perform(model: AppModel, windows: AppWindows?) {
        switch self {
        case .continueSetup: windows?.showSetup()
        case .signIn: model.session.signIn()
        case .restoreSignIn: model.session.retrySavedSignIn()
        case .openBrowserAgain: model.session.openSignInBrowser()
        case .allowBackground: model.engine.enable()
        case .approveBackground: DaemonLifecycle.openLoginItemsSettings()
        case .tryAgain: Task { await model.refresh() }
        case .managePlan(let workspaceID):
            if let url = model.workspaces.config?.page(orgId: workspaceID, section: "billing") { NSWorkspace.shared.open(url) }
            else { model.messages.report("Orbit could not find the plan page. Check your connection and try again.") }
        case .retryDrive(let driveID):
            if let drive = model.drives.drive(id: driveID) { model.drives.mount(drive) }
        case .showActivity: windows?.showWorkspace(page: .activity)
        case .openInFinder(let driveID):
            if let drive = model.drives.drive(id: driveID) { model.drives.open(drive) }
        case .newDrive:
            windows?.showWorkspace(page: .drives)
            windows?.navigation.showingNewDrive = true
        }
    }
}

/// "Get started · N of M done": the steps still open after setup, with a button on the next one.
struct GetStartedList: View {
    var model: AppModel
    var compact = false
    /// The action of a headline shown right above the list. A step it already offers gets no second button.
    var headlineAction: MenuHeadline.Action?
    @Environment(AppWindows.self) private var windows: AppWindows?

    var body: some View {
        let steps = model.getStartedSteps
        let next = GetStarted.next(steps)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(GetStarted.summary(steps)).font(compact ? .caption.weight(.semibold) : .headline)
                    .foregroundStyle(compact ? .secondary : .primary).accessibilityAddTraits(.isHeader)
                Spacer()
                if !compact {
                    Button("Hide") { model.activation.record { $0.dismissed = true } }
                        .buttonStyle(.link).font(.caption).help("Hide this list")
                }
            }
            ProgressView(value: Double(steps.filter(\.done).count), total: Double(max(steps.count, 1)))
                .accessibilityHidden(true)
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: step.done ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(step.done ? AnyShapeStyle(.green) : AnyShapeStyle(.tertiary))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(step.title).foregroundStyle(step.done ? .secondary : .primary)
                                .fixedSize(horizontal: false, vertical: true)
                            if step.optional && !step.done {
                                Text("Optional").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if step.id == next?.id {
                            Text(step.detail).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            if let action = step.action, !GetStarted.isCovered(step.id, by: headlineAction) {
                                Button(action) { model.perform(step.id) { windows?.showSetup() } }
                                    .controlSize(.small).padding(.top, 2)
                                    .accessibilityLabel("\(action): \(step.title)")
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(step.title): \(step.done ? "done" : "not done")")
            }
        }
        .task { await model.permissions.refresh() }
    }
}

/// A row that highlights on hover, like a menu item.
struct MenuCommandStyle: ButtonStyle {
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 8).padding(.vertical, 4)
            .foregroundStyle(enabled ? .primary : .tertiary)
            .background((hovering && enabled) || configuration.isPressed ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear),
                        in: RoundedRectangle(cornerRadius: OrbitStyle.radius - 2))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}
