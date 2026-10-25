import SwiftUI
import UnlispaceKit

struct OnboardingView: View {
    var model: AppModel
    var finish: () -> Void
    @AppStorage("onboardingCompleted") private var completed = false
    @State private var step = Step.signIn
    @State private var selected: Set<String> = []
    @State private var mounting = false
    @State private var error: String?

    private enum Step { case signIn, drives, privacy }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title).font(.largeTitle).accessibilityAddTraits(.isHeader)
            switch step {
            case .signIn: signInStep
            case .drives: driveStep
            case .privacy: privacyStep
            }
            if let notice = model.notice { Text(notice).foregroundStyle(.secondary) }
            if let message = error ?? model.lastError {
                Text(message).accessibilityLabel("Error: \(message)")
            }
            Spacer(minLength: 0)
            HStack {
                if step != .signIn {
                    Button("Back") { error = nil; step = step == .privacy ? .drives : .signIn }
                        .disabled(mounting)
                }
                Spacer()
                Button("Set up later") { finish() }.disabled(mounting)
            }
        }
        .padding(28)
        .frame(width: 500, height: 480)
        .onChange(of: model.isSignedIn) { _, signedIn in
            if signedIn, step == .signIn { step = .drives }
            if !signedIn { step = .signIn; selected = [] }
        }
        .onChange(of: Set(model.drives.map(\.driveId))) { _, ids in selected.formIntersection(ids) }
    }

    private var signInStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sign in to bring your Unlispace drives to Finder.")
            if let account = model.account {
                Text("Signed in as \(account.email)")
                Button("Choose drives") { step = .drives }
                    .keyboardShortcut(.defaultAction)
            } else {
                Button(model.signingIn ? "Waiting for browser…" : "Sign in to Unlispace") { model.signIn() }
                    .disabled(model.signingIn)
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private var driveStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose the drives you want to mount. You can change this from the menu later.")
            if model.usingMock || model.sessionPending {
                Text("Waiting for the engine. Your drives will appear when it connects.")
                if model.engineInstall == .notRegistered || model.engineInstall == .requiresApproval {
                    Button("Enable engine…") { model.installEngine() }
                } else if model.engineInstall == .notInstalled {
                    Text("The engine is not installed. Install a bundle that includes ulsd to continue.")
                }
            } else if model.drives.isEmpty {
                Text("No drives are available yet. You can finish setup and mount a drive later.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.drives) { drive in
                            Toggle(drive.name, isOn: selection(for: drive.driveId))
                                .accessibilityLabel("Mount \(drive.name)")
                        }
                    }
                }
                .frame(maxHeight: 150)
            }
            Button("Continue") { step = .privacy }
                .disabled(model.usingMock || model.sessionPending || !model.isSignedIn)
                .keyboardShortcut(.defaultAction)
        }
    }

    private var privacyStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("macOS treats mounted drives as network volumes, even though Unlispace connects locally on your Mac. Each app, such as Terminal or your editor, may ask once for permission to access “Network Volumes”. Allow access for apps you want to use with your drives.")
            Text("If you deny access, you can change it later in System Settings → Privacy & Security → Files and Folders for that app.")
                .foregroundStyle(.secondary)
            Text("Unlispace can notify you when a conflicting edit is saved as a separate copy.")
            Button("Enable conflict notifications…") { Task { await model.enableConflictNotifications() } }
            if let message = model.notificationMessage { Text(message).foregroundStyle(.secondary) }
            Button(mounting ? "Mounting drives…" : "Finish setup", action: finishSetup)
                .disabled(mounting || model.usingMock || !model.isSignedIn)
                .keyboardShortcut(.defaultAction)
        }
    }

    private func selection(for driveId: String) -> Binding<Bool> {
        Binding(
            get: { selected.contains(driveId) },
            set: { if $0 { selected.insert(driveId) } else { selected.remove(driveId) } }
        )
    }

    private func finishSetup() {
        mounting = true
        error = nil
        Task {
            defer { mounting = false }
            do {
                try await model.mountSelectedDrives(selected)
                completed = true
                finish()
            } catch { self.error = "Could not finish setup: \(LogFormat.describe(error))" }
        }
    }

    private var title: String {
        switch step {
        case .signIn: "Welcome to Unlispace"
        case .drives: "Choose your drives"
        case .privacy: "Network Volumes privacy"
        }
    }
}
