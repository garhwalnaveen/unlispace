import SwiftUI
import OrbitKit

struct ActivationCard: View {
    var model: AppModel
    @State private var workspaces: [WorkspaceInfo] = []
    @State private var access: [MeAccess.Workspace]?
    @State private var error: String?
    @State private var revision = 0

    private var identity: String { "\(model.account?.id ?? "")|\(model.usingMock)|\(model.sessionPending)" }
    private var loadKey: String { "\(identity)|\(revision)" }
    private var connected: Bool { !model.usingMock && !model.sessionPending }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.activation.showsChecklist && Self.canAddFile(access: access, drives: model.drives, mounts: model.mounts) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Your first file").font(.headline)
                        Spacer()
                        Button("Dismiss") { model.dismissActivation(true) }
                    }
                    Text("Open a drive in Finder and add a file. Follow its cloud save in Activity.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), alignment: .leading)], alignment: .leading, spacing: 8) {
                        milestone("Finder opened", complete: model.activation.finderOpened)
                        milestone("File added", complete: model.activation.fileAdded)
                        milestone("Cloud save confirmed", complete: model.activation.cloudSaveConfirmed)
                    }
                    if !connected { Button("Connect this Mac…") { AppDelegate.showOnboarding() } }
                }.padding(16).appPanel()
            }
            if let access {
                ForEach(access) { ws in
                    if let line = planLine(ws) { warning(line) }
                }
            }
            ForEach(access == nil ? workspaces : []) { org in
                if org.trialPending == true {
                    warning("\(org.name): setting up storage. Your trial starts when storage is ready.")
                } else if let end = org.trialEndDate, end <= Date() {
                    warning("\(org.name): check your plan in Settings → Workspace if uploads are blocked.")
                }
            }
            if let error {
                HStack {
                    Text(error).font(.callout).foregroundStyle(AppDesign.muted)
                    Button("Retry") { revision += 1 }
                }.padding(16).appPanel()
            }
        }
        .task(id: loadKey) { await load() }
    }

    static func canAddFile(access: [MeAccess.Workspace]?, drives: [DriveInfo], mounts: [DaemonMount]?) -> Bool {
        if let access, !access.isEmpty, access.allSatisfy({ $0.state == "expired" || $0.writable == false }) { return false }
        if !drives.isEmpty, let mounts, drives.allSatisfy({ drive in
            mounts.contains { $0.driveId == drive.driveId && $0.readOnly }
        }) { return false }
        return true
    }

    private func warning(_ message: String) -> some View {
        Text(message).font(.callout).foregroundStyle(AppDesign.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).appPanel()
    }

    private func planLine(_ ws: MeAccess.Workspace) -> String? {
        if ws.state == "expired" { return "\(ws.name): your trial has ended. Choose a plan in Settings → Workspace to keep saving files." }
        if !ws.storageReady { return "\(ws.name): setting up storage." }
        if ws.writable == false { return "\(ws.name): uploads are unavailable. Check your plan and access in Settings → Workspace." }
        return nil
    }

    private func milestone(_ title: String, complete: Bool) -> some View {
        Label(title, systemImage: complete ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(complete ? Color.primary : Color.secondary)
            .accessibilityLabel("\(title): \(complete ? "complete" : "not complete")")
    }

    private func load() async {
        let key = loadKey
        workspaces = []; access = nil; error = nil
        guard model.isSignedIn, connected else { return }
        // Prefer /me/access; older APIs (404) or any failure fall back to /orgs.
        if let result = try? await model.workspaceRequest("/me/access").decode(MeAccess.self) {
            guard !Task.isCancelled, key == loadKey else { return }
            access = result.workspaces
            return
        }
        guard !Task.isCancelled, key == loadKey else { return }
        do {
            let result = try await model.workspaceRequest("/orgs").decode(WorkspacesResult.self)
            guard !Task.isCancelled, key == loadKey else { return }
            workspaces = result.orgs
        } catch {
            guard !Task.isCancelled, key == loadKey else { return }
            self.error = "Account status is unavailable. Retry or check Settings → Workspace."
        }
    }
}
