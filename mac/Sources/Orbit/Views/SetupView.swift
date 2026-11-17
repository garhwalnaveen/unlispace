import SwiftUI
import OrbitKit

/// First-run setup: the promise, what you get, sign in, permissions, and the drive in Finder.
struct SetupView: View {
    var model: AppModel
    /// Ends setup. `true` also opens the Orbit window; `false` leaves the user in Finder.
    var finish: (_ openWindow: Bool) -> Void
    @State var step = SetupStep.welcome
    /// The account whose drives setup has loaded and put in Finder.
    @State var preparedFor: String?
    @State var mountError: String?
    @State private var preparing = false
    /// Shows one sign-in state regardless of the session. Rendering fixtures use it, because the real
    /// waiting state only exists while a browser is open.
    var showing: SignInPhase?
    @Environment(AppWindows.self) private var windows: AppWindows?

    private var session: SessionStore { model.session }
    private var prepared: Bool { preparedFor != nil && preparedFor == session.account?.id }

    private var phase: SignInPhase {
        showing ?? .current(signingIn: session.signingIn, signedIn: session.isSignedIn, connected: model.engine.isConnected, prepared: prepared)
    }
    private var drive: SetupDrive {
        .current(connected: model.engine.isConnected, prepared: prepared, drives: model.drives.drives, error: mountError)
    }
    /// Changes when setup should look at the account's drives again.
    private var prepareKey: String {
        "\(session.account?.id ?? "")|\(model.isAccountLive)|\(step.rawValue >= SetupStep.signIn.rawValue)"
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 20) {
                    switch step {
                    case .welcome: welcome
                    case .benefits: benefits
                    case .signIn: signIn
                    case .permissions: permissions
                    case .done: done
                    }
                }
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 32).padding(.top, 36).padding(.bottom, 20)
            }
            Divider()
            footer.padding(.horizontal, 20).padding(.vertical, 12)
        }
        .frame(minWidth: 520, minHeight: 480)
        .windowTitle("Set Up Orbit")
        .task(id: prepareKey) { await prepareDrive() }
        .task(id: step) { if step == .permissions { await model.permissions.refresh() } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if step == .permissions { Task { await model.permissions.refresh() } }
        }
        .onChange(of: session.account?.id) { _, new in
            mountError = nil
            if new == nil, step.rawValue > SetupStep.signIn.rawValue { step = .signIn }
        }
        .onChange(of: phase) { old, new in
            // The browser came back and the drive is ready: move on without another click.
            if step == .signIn, new == .signedIn, old != .signedIn { step = .permissions }
        }
    }

    // MARK: Pages

    private func heading(_ title: String, _ detail: String?) -> some View {
        VStack(spacing: 8) {
            Text(title).font(.title.weight(.semibold)).multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if let detail {
                Text(detail).font(.title3).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder private var welcome: some View {
        OrbitMark(size: 64).foregroundStyle(.tint).padding(.top, 36)
        heading("Welcome to Orbit", "Your cloud drive in Finder, with history.")
    }

    @ViewBuilder private var benefits: some View {
        heading("What you get", nil)
        VStack(alignment: .leading, spacing: 10) {
            benefit("externaldrive", "A drive in Finder",
                    "Open, save, and move files the way you already do. There is no new app to learn.")
            benefit("clock.arrow.circlepath", "History for every file",
                    "Each save is kept as a version, so you can go back to an earlier one.")
            benefit("globe", "Your files on the web too",
                    "Reach the same drive from a browser or another Mac.")
        }
    }

    private func benefit(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.title2).foregroundStyle(.tint).frame(width: 32).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .orbitCard()
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var signIn: some View {
        switch phase {
        case .signedOut:
            Image(systemName: "person.crop.circle").font(.system(size: 44)).foregroundStyle(.tint).accessibilityHidden(true)
            heading(phase.title, "Orbit opens your browser to sign in or create an account, then brings you back here.")
            if session.canRetrySavedSignIn {
                Button("Restore Saved Sign-In") { session.retrySavedSignIn() }.disabled(session.retryingSavedSignIn)
            }
        case .waitingForBrowser:
            Image(systemName: "safari").font(.system(size: 44)).foregroundStyle(.tint).accessibilityHidden(true)
            heading(phase.title, "Sign in or create your account there. This window updates on its own.")
            waiting("Waiting for your browser…")
            HStack(spacing: 8) {
                Button("Open Browser Again") { session.openSignInBrowser() }
                Button("Cancel") { session.cancelSignIn() }
            }
        case .settingUp:
            Image(systemName: "externaldrive").font(.system(size: 44)).foregroundStyle(.tint).accessibilityHidden(true)
            heading(phase.title, signedInText)
            waiting("Putting your drive in Finder…")
        case .signedIn:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 44)).foregroundStyle(.green).accessibilityHidden(true)
            heading(phase.title, signedInText)
            Button("Use a Different Account…") { model.useDifferentAccount() }
        }
        if let message = model.messages.error { problem(message) }
        else if let text = model.messages.engineMessage, !text.isEmpty, !session.isSignedIn {
            Text(text).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
    }

    private var signedInText: String? { session.account.map { "Signed in as \($0.email)." } }

    private func waiting(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func problem(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.octagon")
            .foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Error: \(message)")
    }

    @ViewBuilder private var permissions: some View {
        heading("Allow what Orbit needs", nil)
        Text("Each one is yours to allow. You can change them later in Settings.")
            .foregroundStyle(.secondary).multilineTextAlignment(.center)
        VStack(spacing: 8) {
            ForEach(model.permissionItems) { PermissionCard(model: model, item: $0) }
        }
        if case .failed(let message) = model.engine.install { problem(message) }
        else if model.engine.install == .notInstalled {
            Text("This copy of Orbit can't run in the background. Install the full app.")
                .font(.callout).foregroundStyle(.secondary)
        }
        if let message = model.permissions.notificationMessage ?? model.permissions.loginMessage {
            Text(message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
    }

    @ViewBuilder private var done: some View {
        switch drive {
        case .ready(let ready):
            Image(systemName: "checkmark.circle.fill").font(.system(size: 52)).foregroundStyle(.green)
                .padding(.top, 20).accessibilityHidden(true)
            heading("Your drive is in Finder",
                    "“\(ready.name)” is in Finder's sidebar under Locations. Save files there and Orbit uploads them and keeps their history.")
            Text("Orbit stays in the menu bar. Press \(model.shortcut.shortcut.label) to open it from any app.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        case .settingUp:
            ProgressView().controlSize(.large).padding(.top, 28)
            heading("Setting up your drive", "It appears in Finder as soon as it is ready.")
        case .noDrives:
            Image(systemName: "externaldrive.badge.plus").font(.system(size: 48)).foregroundStyle(.tint)
                .padding(.top, 20).accessibilityHidden(true)
            heading("You're signed in", "This account has no drive yet. Create one and it appears in Finder like any other disk.")
        case .needsBackground:
            Image(systemName: "hand.raised").font(.system(size: 48)).foregroundStyle(.orange)
                .padding(.top, 20).accessibilityHidden(true)
            heading("One thing left", "Your drive can't appear in Finder until Orbit is allowed to run in the background.")
        case .failed(let message):
            Image(systemName: "exclamationmark.triangle").font(.system(size: 48)).foregroundStyle(.orange)
                .padding(.top, 20).accessibilityHidden(true)
            heading("Your drive isn't in Finder yet", "Your files are safe. Try again, or finish now and open the drive from the menu bar later.")
            problem(message)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                ForEach(SetupStep.allCases, id: \.self) { item in
                    Circle().fill(item == step ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary)).frame(width: 7, height: 7)
                }
            }
            .accessibilityElement()
            .accessibilityLabel("Step \(step.rawValue + 1) of \(SetupStep.allCases.count): \(step.title)")
            Spacer()
            if step != .welcome {
                Button("Back") { step = step.previous }.disabled(session.signingIn)
            }
            if let later = secondaryTitle {
                Button(later) { finish(true) }
            }
            Button(primaryTitle, action: advance)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(primaryDisabled)
        }
    }

    private var primaryTitle: String {
        switch step {
        case .welcome: "Get Started"
        case .benefits, .permissions: "Continue"
        case .signIn: phase == .signedOut ? "Sign In with Browser" : "Continue"
        case .done:
            switch drive {
            case .ready, .settingUp: "Show in Finder"
            case .noDrives: "Create a Drive…"
            case .needsBackground: "Review Permissions"
            case .failed: "Try Again"
            }
        }
    }

    private var primaryDisabled: Bool {
        switch step {
        case .signIn: phase == .waitingForBrowser
        case .done: drive == .settingUp || preparing
        default: false
        }
    }

    /// Leaving without the drive in Finder is allowed; the step stays open on the Get started list.
    private var secondaryTitle: String? {
        guard step == .done else { return nil }
        if case .ready = drive { return nil }
        return "Finish Later"
    }

    private func advance() {
        switch step {
        case .welcome, .benefits, .permissions:
            step = step.next
        case .signIn:
            if phase == .signedOut { session.signIn() } else { step = .permissions }
        case .done:
            switch drive {
            case .ready(let ready):
                guard model.drives.openInFinder(ready) else { return }
                finish(false)
            case .settingUp:
                break
            case .noDrives:
                finish(true)
                windows?.navigation.showingNewDrive = true
            case .needsBackground:
                step = .permissions
            case .failed:
                Task { await prepareDrive(retry: true) }
            }
        }
    }

    /// Loads the account's drives and puts the first one in Finder, once per account.
    private func prepareDrive(retry: Bool = false) async {
        guard step.rawValue >= SetupStep.signIn.rawValue, model.isAccountLive, !preparing,
              let accountID = session.account?.id, retry || preparedFor != accountID else { return }
        preparing = true
        defer { preparing = false }
        if retry { preparedFor = nil }
        mountError = nil
        await model.refresh()
        if let drive = SetupDrive.driveToMount(model.drives.drives) {
            do { try await model.drives.mountSelected([drive.driveId]) }
            catch { mountError = "Orbit could not put “\(drive.name)” in Finder: \(Format.problem(error))" }
        }
        guard session.account?.id == accountID else { return }
        preparedFor = accountID
    }
}

/// A permission as a card: what it is, the one-sentence reason, and its own button or its granted state.
struct PermissionCard: View {
    var model: AppModel
    var item: PermissionItem

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: symbol).font(.title3).foregroundStyle(.tint).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.title).font(.headline)
                    if item.optional {
                        Text("Optional").font(.caption).foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(item.reason).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            trailing
        }
        .orbitCard()
    }

    @ViewBuilder private var trailing: some View {
        if item.granted {
            Label("Allowed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                .font(.callout).accessibilityLabel("\(item.title): allowed")
        } else if item.status == .managed || item.action == nil {
            Text(item.status.label).font(.callout).foregroundStyle(.secondary)
                .accessibilityLabel("\(item.title): \(item.status.label)")
        } else if let action = item.action {
            Button(action) { model.act(on: item.id) }
                .accessibilityLabel("\(action): \(item.title)")
                .disabled(item.status == .checking || (item.id == .notifications && model.permissions.requestingNotifications))
        }
    }

    private var symbol: String {
        switch item.id {
        case .background: "arrow.triangle.2.circlepath"
        case .files: "folder"
        case .notifications: "bell"
        case .login: "power"
        }
    }
}

/// Picks one of the allowed global shortcuts and reports when macOS refuses it.
struct ShortcutPicker: View {
    var store: ShortcutStore

    var body: some View {
        Picker("Shortcut", selection: Binding(get: { store.shortcut }, set: { store.select($0) })) {
            ForEach(WorkspaceShortcut.allCases) { Text($0.label).tag($0) }
        }
        if let problem = store.problem {
            Text(problem).font(.caption).foregroundStyle(.red)
        }
    }
}
