import SwiftUI
import OrbitKit

struct WorkspaceAccountView: View {
    var model: AppModel
    @State private var workspaces: [WorkspaceInfo] = []
    @State private var config: ClientConfiguration?
    @State private var error: String?
    @State private var loading = false
    @State private var creating = false
    @State private var drafts: [String: String] = [:]
    @State private var targetId = ""
    @State private var revision = 0
    @State private var creationTask: Task<Void, Never>?

    private var identity: String { "\(model.account?.id ?? "")|\(model.usingMock)" }
    private var loadKey: String { "\(identity)|\(revision)" }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Team and billing open in your browser, where you may need to sign in.").font(.callout).foregroundStyle(AppDesign.muted)
            if !model.isSignedIn || model.usingMock {
                ContentUnavailableView("Connect your account", systemImage: "person.crop.circle", description: Text("Sign in and connect the engine to manage drives and your workspace."))
                    .frame(maxWidth: .infinity)
            } else {
                if let email = model.account?.email {
                    HStack {
                        Text("Signed in as \(email)").foregroundStyle(AppDesign.muted)
                        Button("Use a different account…") { model.useDifferentAccount() }.disabled(model.signingIn)
                    }
                }
                if loading { ProgressView("Loading workspaces…") }
                if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
                Button("Refresh workspaces") { revision += 1 }.disabled(loading || creating)
                ForEach(workspaces) { org in
                    GroupBox {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(org.name).font(.headline)
                            Text("\(org.tier.capitalized) · \(org.role.capitalized)").font(.callout).foregroundStyle(AppDesign.muted)
                            if org.trialPending == true {
                                Text("Your seven-day trial starts when storage is ready.").font(.callout)
                            } else if let end = org.trialEndDate {
                                Text("Trial end date: \(end.formatted(date: .abbreviated, time: .omitted))").font(.callout).foregroundStyle(AppDesign.muted)
                            }
                            HStack {
                                if let url = config?.page(orgId: org.id, section: "team") { Link("Manage team in browser", destination: url) }
                                if let url = config?.page(orgId: org.id, section: "billing") { Link("Plan & billing in browser", destination: url) }
                            }
                            if org.canManage {
                                Divider()
                                Text("Create a drive").font(.headline)
                                HStack {
                                    TextField("New drive name", text: Binding(get: { drafts[org.id] ?? "" }, set: { drafts[org.id] = $0 })).textFieldStyle(.roundedBorder)
                                        .disabled(creating)
                                    Button(creating && targetId == org.id ? "Creating…" : "Create drive") {
                                        targetId = org.id
                                        let creator = identity
                                        let name = drafts[org.id] ?? ""
                                        creationTask = Task { await create(org, creator: creator, draft: name) }
                                    }.disabled(creating || (drafts[org.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !loading, workspaces.isEmpty, error == nil { Text("No workspaces are available for this account.") }
            }
        }
        .task(id: loadKey) { await load() }
        .onChange(of: identity) { _, _ in
            creationTask?.cancel(); creating = false; drafts = [:]; targetId = ""
        }
        .onDisappear { creationTask?.cancel() }
    }

    private func load() async {
        let key = loadKey
        workspaces = []; config = nil; error = nil
        guard model.isSignedIn, !model.usingMock else { return }
        loading = true
        defer { if key == loadKey { loading = false } }
        do {
            let result = try await model.workspaceRequest("/orgs").decode(WorkspacesResult.self)
            guard !Task.isCancelled, key == loadKey else { return }
            workspaces = result.orgs
            do {
                let value = try await model.workspaceRequest("/client-config").decode(ClientConfiguration.self)
                guard !Task.isCancelled, key == loadKey else { return }
                config = value
            } catch { if !Task.isCancelled, key == loadKey { self.error = "Team and billing links are unavailable. Update the API server and try again." } }
        } catch { if !Task.isCancelled, key == loadKey { self.error = LogFormat.describe(error) } }
    }

    private func create(_ org: WorkspaceInfo, creator owner: String, draft: String) async {
        guard !Task.isCancelled, owner == identity else { return }
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !creating, org.canManage, !name.isEmpty, name.count <= 100 else { error = "Use a drive name of 1–100 characters."; return }
        creating = true; error = nil
        defer { if owner == identity { creating = false } }
        do {
            _ = try await model.workspaceRequest("/orgs/\(org.id)/drives", method: "POST", body: .object(["name": .string(name)]))
            guard !Task.isCancelled, owner == identity else { return }
            drafts[org.id] = ""
            await model.refresh()
            guard !Task.isCancelled, owner == identity else { return }
            revision += 1
        } catch { if !Task.isCancelled, owner == identity { self.error = "Could not create drive: \(LogFormat.describe(error))" } }
    }
}
