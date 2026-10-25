import SwiftUI
import UnlispaceKit

struct MenuContent: View {
    @Bindable var model: AppModel
    @Environment(\.openSettings) private var openSettings
    @State private var showingTransfers = false

    private var showsSignedInUI: Bool { model.isSignedIn || model.hasDevToken }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !showsSignedInUI {
                Text("Signed out")
                Button(model.signingIn ? "Waiting for browser…" : "Sign in to Unlispace") { model.signIn() }
                    .disabled(model.signingIn)
                if let err = model.lastError { Text(err).lineLimit(3) }
            } else {
                if let acct = model.account { Text(acct.email) }
                Text(model.status.title)
                if model.usingMock { Text("Engine not running") }
                if model.status == .engineMissing || model.engineInstall == .notInstalled && !model.usingMock {
                    Text("Engine not installed")
                }
                if let n = model.notice { Text(n).lineLimit(3) }
                Button(model.transferLine ?? "Transfers") { showingTransfers.toggle() }
                    .accessibilityLabel("Show transfers")
                    .accessibilityValue(model.transferLine ?? "No transfers in progress")
                    .popover(isPresented: $showingTransfers) { TransfersView(transfers: model.transfers) }
                if let conflict = model.lastConflict {
                    Label("Conflicting edit: \(conflict.path). Saved as \(conflict.copy).", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let c = model.lastChangeLine { Text(c) }
                if let m = model.stateMessage, !m.isEmpty { Text(m).lineLimit(2) }
                if let err = model.lastError { Text("Error: \(err)").lineLimit(2) }
                Divider()

                if model.drives.isEmpty {
                    Text("No drives")
                }
                ForEach(model.drives) { d in
                    Menu("\(d.name) — \(d.mountState.rawValue)") {
                        if d.mountState == .mounted {
                            Button("Open in Finder") { model.openInFinder(d) }
                            Button("Unmount") { model.unmount(d) }
                        } else {
                            Button("Mount") { model.mount(d) }
                                .disabled(d.mountState == .mounting || d.mountState == .unmounting)
                        }
                    }
                    .accessibilityLabel("\(d.name), \(d.mountState.rawValue), drive actions")
                }
            }
            Divider()
            Button("Set up Unlispace…") { AppDelegate.showOnboarding() }
            if model.engineInstall == .notRegistered || model.engineInstall == .requiresApproval {
                Button("Enable engine…") { model.installEngine() }
            }
            Button("Settings…") {
                NSApp.activate()
                openSettings()
            }
            .keyboardShortcut(",")
            if showsSignedInUI {
                Button("Sign out") { model.signOut() }
            }
            Button("Quit Unlispace") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
        .padding(16)
        .frame(width: 320)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Unlispace menu")
    }
}
