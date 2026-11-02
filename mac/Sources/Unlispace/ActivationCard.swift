import SwiftUI
import UnlispaceKit

struct ActivationCard: View {
    var model: AppModel
    @State private var workspaces: [WorkspaceInfo] = []
    @State private var access: [MeAccess.Workspace]?
    @State private var loaded = false
    @State private var loading = false
    @State private var error: String?
    @State private var revision = 0
    @State private var expanded: Bool?

    private var identity: String { "\(model.account?.id ?? "")|\(model.usingMock)|\(model.sessionPending)" }
    private var loadKey: String { "\(identity)|\(revision)" }
    private var mounted: DriveInfo? { model.drives.first { $0.mountState == .mounted && $0.mountPath != nil } }
    private var connected: Bool { !model.usingMock && !model.sessionPending }
    private var complete: Bool { model.activation.finderOpened && model.activation.fileAdded && model.activation.cloudSaveConfirmed }
    private var storageReady: Bool {
        if let access { return access.contains { $0.storageReady } }
        return workspaces.contains { $0.drives?.contains { $0.status == "ready" } == true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            DisclosureGroup("Your first file", isExpanded: Binding(
                get: { expanded ?? (!model.activation.dismissed && !complete) },
                set: { expanded = $0; model.dismissActivation(!$0) }
            )) {
                VStack(alignment: .leading, spacing: 12) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 20) { readiness }
                        VStack(alignment: .leading, spacing: 8) { readiness }
                    }
                    if loading { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Checking storage…").foregroundStyle(AppDesign.muted) } }
                    if let error { Text(error).font(.callout).foregroundStyle(AppDesign.muted) }
                    HStack {
                        Button("Refresh setup status") {
                            Task { await model.refresh(); revision += 1 }
                        }.disabled(loading)
                        if !connected { Button("Connect this Mac…") { AppDelegate.showOnboarding() } }
                    }
                    Divider()
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), alignment: .leading)], alignment: .leading, spacing: 8) {
                        milestone("Drive mounted", complete: mounted != nil)
                        milestone("Finder opened", complete: model.activation.finderOpened)
                        milestone("File added to a drive", complete: model.activation.fileAdded)
                        milestone("First cloud save confirmed", complete: model.activation.cloudSaveConfirmed)
                    }
                    Text("Use Add a file above or copy a file in Finder. Your original stays in place. Follow its upload in Transfers to confirm it is saved to cloud.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                    if model.copyingFile { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Copying selected file…").foregroundStyle(AppDesign.muted) } }
                    if model.activation.cloudSaveConfirmed {
                        Text("One upload is confirmed. This does not mean every file is synced or available offline.")
                            .font(.caption).foregroundStyle(AppDesign.muted)
                    }
                }.padding(.top, 12)
            }
            if let access {
                ForEach(access) { ws in
                    if let line = planLine(ws) { Text(line).font(.callout).foregroundStyle(AppDesign.muted) }
                }
            }
            ForEach(access == nil ? workspaces : []) { org in
                if org.trialPending == true {
                    Text("\(org.name): your seven-day trial starts when storage is ready.").font(.callout)
                } else if let end = org.trialEndDate {
                    Text("\(org.name) · Trial end date: \(end.formatted(date: .abbreviated, time: .omitted))")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                }
            }
        }
        .padding(16).appPanel()
        .task(id: loadKey) { await load() }
        .onChange(of: complete) { _, complete in
            if complete { expanded = false; model.dismissActivation(true) }
        }
    }

    @ViewBuilder private var readiness: some View {
        milestone("Account verified", complete: model.isSignedIn)
        Label(storageReady ? "Storage ready" : loaded ? "Storage needs setup" : "Storage status unknown", systemImage: storageReady ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(storageReady ? Color.primary : Color.secondary)
        milestone("Mac connected", complete: connected)
    }

    private func planLine(_ ws: MeAccess.Workspace) -> String? {
        if ws.trialPending == true { return "\(ws.name): your seven-day trial starts when storage is ready." }
        switch ws.state {
        case "provisioning": return "\(ws.name) · Setting up storage"
        case "trial_active":
            if let end = ws.trialEndDate { return "\(ws.name) · Trial end date: \(end.formatted(date: .abbreviated, time: .omitted))" }
            return "\(ws.name) · Trial active"
        case "paid": return "\(ws.name) · Paid plan"
        case "expired": return "\(ws.name) · Trial expired. Choose a plan to keep saving files."
        default: return nil
        }
    }

    private func milestone(_ title: String, complete: Bool) -> some View {
        Label(title, systemImage: complete ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(complete ? Color.primary : Color.secondary)
            .accessibilityLabel("\(title): \(complete ? "complete" : "not complete")")
    }

    private func load() async {
        let key = loadKey
        workspaces = []; access = nil; loaded = false; error = nil
        guard model.isSignedIn, connected else { return }
        loading = true
        defer { if key == loadKey { loading = false } }
        // Prefer /me/access; older APIs (404) or any failure fall back to /orgs.
        if let result = try? await model.workspaceRequest("/me/access").decode(MeAccess.self) {
            guard !Task.isCancelled, key == loadKey else { return }
            access = result.workspaces
            loaded = true
            return
        }
        guard !Task.isCancelled, key == loadKey else { return }
        do {
            let result = try await model.workspaceRequest("/orgs").decode(WorkspacesResult.self)
            guard !Task.isCancelled, key == loadKey else { return }
            workspaces = result.orgs
            loaded = workspaces.allSatisfy { $0.drives != nil }
        } catch {
            guard !Task.isCancelled, key == loadKey else { return }
            self.error = "Storage details are unavailable. Refresh to retry. Your mounted drives remain usable."
        }
    }
}
