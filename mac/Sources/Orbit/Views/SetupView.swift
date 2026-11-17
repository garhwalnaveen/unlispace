import SwiftUI
import OrbitKit

enum SetupStep: Int, CaseIterable {
    case signIn, drives, shortcut

    var title: String {
        switch self {
        case .signIn: "Sign In"
        case .drives: "Drives"
        case .shortcut: "Shortcut"
        }
    }
    var next: Self { Self(rawValue: rawValue + 1) ?? self }
    var previous: Self { Self(rawValue: rawValue - 1) ?? self }
}

/// First-run setup: sign in, mount drives and review permissions, then learn the shortcut.
struct SetupView: View {
    var model: AppModel
    var finish: () -> Void
    @State var step = SetupStep.signIn
    @State private var selected: Set<String> = []
    @State private var choseDefault = false
    @State private var mounting = false
    @State private var error: String?

    private var session: SessionStore { model.session }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch step {
                    case .signIn: signIn
                    case .drives: drives
                    case .shortcut: shortcut
                    }
                    if let message = error ?? model.messages.error {
                        Label(message, systemImage: "exclamationmark.octagon")
                            .foregroundStyle(Theme.danger).textSelection(.enabled)
                            .accessibilityLabel("Error: \(message)")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            Divider()
            footer.padding(.horizontal, 20).padding(.vertical, 12)
        }
        .background(Theme.canvas)
        .orbitControls()
        .frame(minWidth: 520, minHeight: 480)
        .windowTitle("Set Up Orbit")
        .task(id: step) {
            if step == .drives { chooseDefaultDrive(); await model.permissions.refresh() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if step == .drives { Task { await model.permissions.refresh() } }
        }
        .onChange(of: session.account?.id) { old, new in
            selected = []; choseDefault = false; error = nil
            if new == nil { step = .signIn }
            else if old == nil && step == .signIn { step = .drives }
        }
        .onChange(of: model.drives.drives.map(\.driveId)) { _, ids in
            selected.formIntersection(ids)
            if step == .drives { chooseDefaultDrive() }
        }
    }

    private func heading(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.display(26)).accessibilityAddTraits(.isHeader)
            Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var signIn: some View {
        OrbitMark(size: 40)
        heading("Set up Orbit", "Orbit mounts your drives in Finder. Sign in with your browser to start.")
        if let account = session.account {
            LabeledContent("Signed in as", value: account.email)
            Button("Use a Different Account…") { model.useDifferentAccount() }.disabled(session.signingIn)
        }
        if session.signingIn || session.canRetrySavedSignIn {
            HStack(spacing: 8) { SignInControls(session: session, prominent: false) }
        }
        if let text = model.messages.engineMessage, !text.isEmpty, !session.isSignedIn {
            Text(text).font(.callout).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var drives: some View {
        heading("Choose drives to mount", "Mounted drives appear in Finder like any other disk. You can change this later.")
        if !model.isAccountLive {
            HStack(spacing: 8) {
                Label("Waiting for the background service.", systemImage: "circle.dashed").foregroundStyle(.secondary)
                Button("Check Again") { Task { await model.refresh() } }
            }
        } else if model.drives.drives.isEmpty {
            HStack(spacing: 8) {
                Text("This account has no drives yet. You can finish setup without one.").foregroundStyle(.secondary)
                Button("Check Again") { Task { await model.refresh() } }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(model.drives.drives) { drive in
                    Toggle(drive.name, isOn: Binding(
                        get: { selected.contains(drive.driveId) },
                        set: { if $0 { selected.insert(drive.driveId) } else { selected.remove(drive.driveId) } }
                    ))
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Mount \(drive.name)")
                }
            }
            .disabled(mounting)
        }
        Form { PermissionsContent(model: model) }
            .formStyle(.grouped).scrollContentBackground(.hidden).scrollDisabled(true).padding(.horizontal, -20)
            .disabled(mounting)
    }

    @ViewBuilder private var shortcut: some View {
        heading("Open Orbit from any app", "Press \(model.shortcut.shortcut.label) to open this window. Orbit also stays in the menu bar.")
        ShortcutPicker(store: model.shortcut).frame(maxWidth: 280)
    }

    private var footer: some View {
        HStack {
            Text("Step \(step.rawValue + 1) of \(SetupStep.allCases.count)").orbitLabel().foregroundStyle(.secondary)
            Spacer()
            if mounting { ProgressView().controlSize(.small) }
            Button("Back") { error = nil; step = step.previous }
                .disabled(step == .signIn || mounting)
            Button(primaryTitle, action: advance)
                .keyboardShortcut(.defaultAction).buttonStyle(.orbitProminent)
                .disabled(mounting || (step == .signIn && session.signingIn) || (step == .drives && !model.isAccountLive))
        }
    }

    private var primaryTitle: String {
        switch step {
        case .signIn: session.isSignedIn ? "Continue" : "Sign In…"
        case .drives: mounting ? "Mounting…" : selected.isEmpty ? "Continue" : "Mount and Continue"
        case .shortcut: selected.isEmpty ? "Done" : "Open in Finder"
        }
    }

    private func advance() {
        error = nil
        switch step {
        case .signIn:
            if session.isSignedIn { step = .drives } else { session.signIn() }
        case .drives:
            guard model.isAccountLive, !mounting else { return }
            mounting = true
            let accountID = session.account?.id
            Task {
                defer { mounting = false }
                do {
                    try await model.drives.mountSelected(selected)
                    guard model.isAccountLive, session.account?.id == accountID else { throw DaemonClientError.notConnected }
                    guard Self.mountsReady(selected, drives: model.drives.drives) else {
                        throw DaemonClientError.remote(DaemonError(code: "mount_pending", message: "The drive has not appeared in Finder yet"))
                    }
                    step = .shortcut
                } catch {
                    self.error = "Could not mount: \(LogFormat.describe(error)). Try again."
                }
            }
        case .shortcut:
            guard model.isAccountLive, Self.mountsReady(selected, drives: model.drives.drives) else {
                error = "A selected drive is no longer mounted. Go back and mount it again."
                return
            }
            if let drive = model.drives.drives.first(where: { selected.contains($0.driveId) && $0.mountState == .mounted && $0.mountPath != nil }) {
                guard model.drives.openInFinder(drive) else { return }
            }
            finish()
        }
    }

    /// Every selected drive is mounted and has a Finder path.
    static func mountsReady(_ selected: Set<String>, drives: [DriveInfo]) -> Bool {
        selected.isSubset(of: Set(drives.filter { $0.mountState == .mounted && $0.mountPath != nil }.map(\.driveId)))
    }

    private func chooseDefaultDrive() {
        guard !choseDefault, let first = model.drives.drives.first else { return }
        selected = [first.driveId]
        choseDefault = true
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
            Text(problem).font(.caption).foregroundStyle(Theme.danger)
        }
    }
}
