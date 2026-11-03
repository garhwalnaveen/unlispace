import SwiftUI
import OrbitKit

enum OnboardingStep: Int, CaseIterable {
    case welcome, access, ready

    var label: String {
        switch self {
        case .welcome: "Welcome"
        case .access: "Drive access"
        case .ready: "Ready"
        }
    }
    var next: Self { Self(rawValue: rawValue + 1) ?? self }
    var previous: Self { Self(rawValue: rawValue - 1) ?? self }
}

struct OnboardingView: View {
    var model: AppModel
    var finish: () -> Void
    @AppStorage("appearance") private var appearance = "dark"
    @AppStorage("onboardingCompleted") private var completed = false
    @State var step = OnboardingStep.welcome
    @State private var selected: Set<String> = []
    @State private var selectedDefault = false
    @State private var mounting = false
    @State private var error: String?
    @State private var recordingShortcut = false

    private var connected: Bool { model.isSignedIn && !model.usingMock && !model.sessionPending }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label { Text("Orbit") } icon: { OrbitMark() }
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
                if let account = model.account {
                    Text(account.email).font(.system(size: 12)).foregroundStyle(AppDesign.muted)
                }
            }.padding(.horizontal, 36).padding(.top, 22)
            ScrollView {
                Group {
                    switch step {
                    case .welcome: welcome
                    case .access: access
                    case .ready: ready
                    }
                }
                .frame(maxWidth: 960, minHeight: 490)
                .padding(.horizontal, 48).padding(.vertical, 28)
                if let message = error ?? model.lastError {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.red).textSelection(.enabled)
                        .accessibilityLabel("Error: \(message)")
                        .padding(.horizontal, 48).padding(.bottom, 12)
                }
            }
            .id(step)
            footer.padding(.horizontal, 36).padding(.bottom, 24).padding(.top, 12)
        }
        .frame(minWidth: 800, idealWidth: 1100, minHeight: 640, idealHeight: 760)
        .appStyle()
        .background(AppDesign.surface)
        .preferredColorScheme(appearance == "system" ? nil : appearance == "dark" ? .dark : .light)
        .task(id: step) {
            if step == .access { selectDefaultDrive(); await model.refreshPermissions() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if step == .access { Task { await model.refreshPermissions() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .workspaceShortcutPressed)) { _ in
            if step == .ready && !recordingShortcut { advance() }
        }
        .onChange(of: recordingShortcut) { _, recording in
            if recording { model.stopWorkspaceShortcut() }
            else { model.resumeWorkspaceShortcut() }
        }
        .onDisappear {
            if recordingShortcut { model.resumeWorkspaceShortcut() }
        }
        .onChange(of: model.account?.id) { old, new in
            selected = []; selectedDefault = false; error = nil
            if new == nil { step = .welcome }
            else if old == nil && step == .welcome { step = .access }
        }
        .onChange(of: Set(model.drives.map(\.driveId))) { _, ids in
            selected.formIntersection(ids)
            if step == .access { selectDefaultDrive() }
        }
    }

    private var welcome: some View {
        VStack(spacing: 22) {
            OrbitMark(size: 76)
                .padding(.bottom, 12)
            heading("Welcome to Orbit", "Your cloud files, right at home on your Mac.")
            if let account = model.account {
                Text("Signed in as \(account.email)").foregroundStyle(AppDesign.muted)
                Button("Use a different account…") { model.useDifferentAccount() }.disabled(model.signingIn)
            } else {
                Text("Sign in securely in your browser, then return here to finish setup.")
                    .foregroundStyle(AppDesign.muted)
                if model.canRetrySignIn {
                    Button("Retry saved sign-in") { model.retrySavedSignIn() }.disabled(model.retryingSavedSignIn)
                }
                if let message = model.stateMessage { Text(message).font(.callout).foregroundStyle(AppDesign.muted) }
            }
            if model.signingIn {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Waiting for your browser…").foregroundStyle(AppDesign.muted) }
                HStack(spacing: 16) {
                    Button("Open browser again") { model.openSignInBrowser() }
                    Button("Cancel sign-in") { model.cancelSignIn() }
                }
            }
        }.frame(maxWidth: .infinity)
    }

    private var access: some View {
        HStack(alignment: .top, spacing: 40) {
            VStack(alignment: .leading, spacing: 20) {
                Text("Bring your drives\nto Finder").font(.system(size: 36, weight: .semibold)).tracking(-1)
                    .accessibilityAddTraits(.isHeader)
                Text("Choose what to connect. You can change these settings later.")
                    .font(.system(size: 17)).foregroundStyle(AppDesign.muted).lineSpacing(4)
                if !connected {
                    Label("Mac connection pending", systemImage: "circle.dashed").font(.callout)
                    Button("Refresh connection") { Task { await model.refresh() } }
                } else if model.drives.isEmpty {
                    Text("No drives are available yet. Refresh to check again, or finish without a drive.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                    Button("Refresh drives") { Task { await model.refresh() } }
                }
                ForEach(model.drives) { drive in
                    Toggle(isOn: Binding(
                        get: { selected.contains(drive.driveId) },
                        set: { if $0 { selected.insert(drive.driveId) } else { selected.remove(drive.driveId) } }
                    )) { Label(drive.name, systemImage: "externaldrive") }
                    .toggleStyle(.checkbox)
                    .accessibilityLabel("Mount \(drive.name) in Finder")
                    .disabled(mounting || !connected)
                }
                Text("macOS may ask each app for network volume access when it opens a drive.")
                    .font(.callout).foregroundStyle(AppDesign.muted)
            }.frame(width: 275, alignment: .leading)
            VStack(alignment: .leading, spacing: 12) {
                PermissionsContent(model: model, onboarding: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .disabled(mounting)
        }
    }

    private var ready: some View {
        VStack(spacing: 30) {
            heading("You’re ready for Orbit", "One shortcut to your files and activity.")
            HStack(spacing: 18) {
                keycap(model.workspaceShortcut.modifierLabel, width: 120)
                keycap("space", width: 340)
            }.padding(.vertical, 18).accessibilityElement(children: .ignore)
                .accessibilityLabel("Workspace shortcut: \(model.workspaceShortcut.label)")
            if recordingShortcut {
                Text("Press Option–Space, Control–Option–Space, or Command–Option–Space. Escape cancels.").foregroundStyle(AppDesign.muted)
                ShortcutRecorder { shortcut in
                    recordingShortcut = false
                    if let shortcut { model.setWorkspaceShortcut(shortcut) }
                }.frame(width: 1, height: 1)
            }
            Button(recordingShortcut ? "Cancel" : "Change shortcut") { recordingShortcut.toggle() }
            if let message = model.shortcutMessage { Text(message).font(.callout).foregroundStyle(AppDesign.muted) }
            Text("Find Orbit in your menu bar anytime. Add your first file from Files or Finder.")
                .font(.callout).foregroundStyle(AppDesign.muted)
        }
    }

    private var footer: some View {
        HStack {
            Button { error = nil; recordingShortcut = false; step = step.previous } label: {
                Image(systemName: "chevron.left").frame(width: 20, height: 24)
            }
            .clipShape(Circle()).accessibilityLabel("Back")
            .disabled(step == .welcome || mounting)
            Spacer()
            Button(action: advance) {
                HStack(spacing: 16) {
                    Text(primaryTitle)
                    Image(systemName: "return").font(.system(size: 12))
                }.padding(.horizontal, 12).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large)
            .disabled(mounting || (step == .welcome && model.signingIn) || (step == .access && !connected) || recordingShortcut)
            .keyboardShortcut(.defaultAction)
        }
        .overlay {
            HStack(spacing: 7) {
                ForEach(OnboardingStep.allCases, id: \.rawValue) { item in
                    Capsule().fill(item == step ? AppDesign.foreground : AppDesign.border)
                        .frame(width: item == step ? 30 : 10, height: 4)
                }
            }.accessibilityElement(children: .ignore)
                .accessibilityLabel("Step \(step.rawValue + 1) of \(OnboardingStep.allCases.count): \(step.label)")
                .allowsHitTesting(false)
        }
    }

    private var primaryTitle: String {
        if mounting { return "Connecting drives…" }
        switch step {
        case .welcome: return model.isSignedIn ? "Continue" : "Sign in with browser"
        case .ready: return selected.isEmpty ? "Finish setup" : "Open Finder"
        default: return "Continue"
        }
    }

    private func advance() {
        error = nil
        if step == .welcome && !model.isSignedIn { model.signIn(); return }
        if step == .access {
            guard connected, !mounting else { return }
            mounting = true
            let accountID = model.account?.id
            Task {
                defer { mounting = false }
                do {
                    try await model.mountSelectedDrives(selected)
                    guard connected, model.account?.id == accountID else { throw DaemonClientError.notConnected }
                    guard Self.mountsReady(selected, drives: model.drives) else {
                        throw DaemonClientError.remote(DaemonError(code: "mount_pending", message: "Your drive has not appeared in Finder yet."))
                    }
                    step = .ready
                } catch { self.error = "Could not connect your drives: \(LogFormat.describe(error)). Try again." }
            }
        } else if step == .ready {
            guard connected, Self.mountsReady(selected, drives: model.drives) else {
                error = "Your connection or drive is no longer available. Go back to reconnect."
                return
            }
            if let drive = model.drives.first(where: { selected.contains($0.driveId) && $0.mountState == .mounted && $0.mountPath != nil }) {
                guard model.openInFinder(drive) else { return }
            }
            completed = true
            finish()
        } else { step = step.next }
    }

    static func mountsReady(_ selected: Set<String>, drives: [DriveInfo]) -> Bool {
        selected.isSubset(of: Set(drives.filter { $0.mountState == .mounted && $0.mountPath != nil }.map(\.driveId)))
    }

    private func selectDefaultDrive() {
        guard !selectedDefault, let first = model.drives.first else { return }
        selected = [first.driveId]
        selectedDefault = true
    }

    private func heading(_ title: String, _ subtitle: String) -> some View {
        VStack(spacing: 16) {
            Text(title).font(.system(size: 36, weight: .semibold)).tracking(-1).accessibilityAddTraits(.isHeader)
            Text(subtitle).font(.system(size: 17)).foregroundStyle(AppDesign.muted).lineSpacing(4)
        }.multilineTextAlignment(.center).frame(maxWidth: .infinity)
    }

    private func keycap(_ label: String, width: CGFloat) -> some View {
        Text(label).font(.system(size: 26, weight: .medium)).foregroundStyle(AppDesign.muted)
            .frame(width: width, height: 110, alignment: .bottomLeading).padding(20)
            .background(AppDesign.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(AppDesign.border))
            .shadow(color: .black.opacity(0.05), radius: 12, y: 8)
    }
}
