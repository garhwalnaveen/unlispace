import SwiftUI
import UnlispaceKit

struct MenuContent: View {
    @Bindable var model: AppModel
    @Environment(\.openSettings) private var openSettings
    @State private var showingTransfers = false

    private var showsSignedInUI: Bool { model.isSignedIn || model.hasDevToken }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Unlispace", systemImage: "square.stack.3d.up.fill").font(.headline)
                Spacer()
                Button("Open app") { AppDelegate.showWorkspace() }
            }
            Divider()
            if !showsSignedInUI {
                Text("Your cloud drives, right in Finder.").foregroundStyle(.secondary)
                Button(model.signingIn ? "Waiting for browser…" : "Sign in to Unlispace") { model.signIn() }
                    .disabled(model.signingIn)
                if model.signingIn {
                    Button("Open browser") { model.openSignInBrowser() }
                    Button("Cancel sign-in") { model.cancelSignIn() }
                }
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
                    .popover(isPresented: $showingTransfers) { TransfersView(transfers: model.transfers, uploads: model.uploads, available: !model.usingMock) }
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
                        if let mounts = model.mounts,
                           let mount = mounts.first(where: { $0.driveId == d.driveId }) {
                            Text("\(mount.mountpoint) (\(mount.adapter)\(mount.readOnly ? ", read only" : ""))")
                        }
                        if let pins = model.pins {
                            Menu("Keep offline") {
                                Button("Keep entire drive offline") { model.setPin(driveId: d.driveId, path: "/", pinned: true) }
                                ForEach(pins.filter { $0.driveId == d.driveId }) { pin in
                                    Text("\(pin.path) — \(Int(pin.progress * 100))% cached")
                                    Button("Stop keeping \(pin.path) offline") {
                                        model.setPin(driveId: d.driveId, path: pin.path, pinned: false)
                                    }
                                }
                            }
                        }
                        if d.mountState == .mounted {
                            Button("Open in Finder") { model.openInFinder(d) }
                            Button("Unmount") { model.unmount(d) }
                        } else {
                            Button("Mount") { model.mount(d) }
                                .disabled(d.mountState == .mounting || d.mountState == .unmounting)
                        }
                    }
                    .disabled(model.usingMock || model.isDriveBusy(d))
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
            if model.updates.isEnabled {
                Button("Check for Updates…") { model.updates.checkForUpdates() }
            }
            Button("Quit Unlispace") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
        .padding(16)
        .frame(width: 360)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Unlispace menu")
    }
}
