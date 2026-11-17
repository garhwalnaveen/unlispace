import Foundation
import Observation
import OrbitKit

/// Workspaces, plan access, and web links for the signed-in account, loaded once and shared.
/// Every screen that shows a plan, a team link, or Ask AI reads this instead of calling the API itself.
@MainActor @Observable
final class WorkspaceDirectory {
    /// How long a loaded copy is reused before a screen asking for it triggers a reload.
    static let freshness: TimeInterval = 300

    private(set) var workspaces: [WorkspaceInfo] = []
    /// Per-workspace plan state. Nil when the server predates `/me/access`.
    private(set) var access: [MeAccess.Workspace]?
    private(set) var config: ClientConfiguration?
    private(set) var isLoading = false
    private(set) var error: String?

    @ObservationIgnored private let engine: EngineLink
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private var loadedFor: String?
    @ObservationIgnored private var loadedAt: Date?
    @ObservationIgnored private var loading: Task<Void, Never>?
    @ObservationIgnored private var generation = 0

    init(engine: EngineLink, session: SessionStore) {
        self.engine = engine
        self.session = session
    }

    /// True when the account's session is in the engine, so API requests can be made.
    var isAvailable: Bool { engine.isConnected && session.isSignedIn && !session.sessionPending }
    var manageable: [WorkspaceInfo] { workspaces.filter(\.canManage) }
    /// Changes whenever a screen should load again: a different account, or the engine coming or going.
    var loadKey: String { "\(session.account?.id ?? "")|\(isAvailable)" }

    func reset() {
        generation += 1
        loading?.cancel()
        loading = nil
        workspaces = []
        access = nil
        config = nil
        error = nil
        isLoading = false
        loadedFor = nil
        loadedAt = nil
    }

    /// Loads if nothing fresh is cached for this account. Callers on different screens share one request.
    func load(force: Bool = false) async {
        guard isAvailable, let accountID = session.account?.id else { reset(); return }
        if loadedFor != nil, loadedFor != accountID { reset() }
        if let running = loading { await running.value; return }
        if !force, let loadedAt, Date().timeIntervalSince(loadedAt) < Self.freshness { return }
        generation += 1
        let expected = generation
        isLoading = true
        let task = Task { await fetch(for: accountID, generation: expected) }
        loading = task
        await task.value
    }

    private func fetch(for accountID: String, generation expected: Int) async {
        async let accessReply = try? await request("/me/access").decode(MeAccess.self)
        async let configReply = try? await request("/client-config").decode(ClientConfiguration.self)
        let orgs: Result<[WorkspaceInfo], Error>
        do { orgs = .success(try await request("/orgs").decode(WorkspacesResult.self).orgs) }
        catch { orgs = .failure(error) }
        let (newAccess, newConfig) = await (accessReply, configReply)
        // A reset or a newer load owns the state now.
        guard expected == generation else { return }
        isLoading = false
        loading = nil
        loadedFor = accountID
        access = newAccess?.workspaces
        config = newConfig
        switch orgs {
        case .success(let list):
            workspaces = list
            error = nil
            // Without the web links the copy is incomplete, so the next request loads again.
            loadedAt = newConfig == nil ? nil : Date()
        case .failure(let failure):
            // Plan access alone is enough for the notices; report only when both are missing.
            error = newAccess == nil ? "Could not load workspaces: \(Format.problem(failure))" : nil
            loadedAt = newAccess == nil ? nil : Date()
        }
    }

    func request(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> JSONValue {
        guard isAvailable else { throw DaemonClientError.notConnected }
        return try await engine.connectedClient().apiRequest(method: method, path: path, body: body)
    }

    func createDrive(named name: String, in workspace: WorkspaceInfo) async throws {
        _ = try await request("/orgs/\(workspace.id)/drives", method: "POST", body: .object(["name": .string(name)]))
        await engine.refresh()
        await load(force: true)
    }

    // MARK: Drives

    func workspace(forDrive driveID: String) -> WorkspaceInfo? {
        workspaces.first { $0.drives?.contains { $0.id == driveID } == true }
    }

    /// Renaming, copying, and deleting need an owner or admin. An unknown workspace is left to the server to decide.
    func canManage(driveID: String) -> Bool {
        guard isAvailable else { return false }
        return workspace(forDrive: driveID)?.canManage ?? true
    }

    func renameDrive(_ drive: DriveInfo, to name: String) async throws {
        _ = try await request("/drives/\(drive.driveId)", method: "PATCH", body: .object(["name": .string(name)]))
        await engine.refresh()
        await load(force: true)
    }

    /// A copy starts with the same files and history and changes separately from then on.
    func copyDrive(_ drive: DriveInfo, named name: String) async throws {
        _ = try await request("/drives/\(drive.driveId)/fork", method: "POST", body: .object(["name": .string(name)]))
        await engine.refresh()
        await load(force: true)
    }

    func deleteDrive(_ drive: DriveInfo) async throws {
        let client = try engine.connectedClient()
        _ = try await request("/drives/\(drive.driveId)", method: "DELETE")
        // The drive is gone from the account; take it out of Finder as well.
        if drive.mountState == .mounted { try? await client.unmount(driveId: drive.driveId) }
        await engine.refresh()
        await load(force: true)
    }

    /// A one-time signed-in URL for a page of the web app, with the PKCE verifier that unlocks it.
    func embeddedPage(_ page: String) async throws -> (url: URL, verifier: String) {
        await load(force: config == nil)
        guard let config else { throw URLError(.badServerResponse) }
        let verifier = PKCE.makeVerifier()
        struct Handoff: Decodable { let handoff: String }
        let result = try await request("/auth/web-handoff", method: "POST",
                                       body: .object(["webChallenge": .string(PKCE.challenge(forVerifier: verifier))]))
        guard let url = config.embedPage(page, handoff: try result.decode(Handoff.self).handoff) else { throw URLError(.badURL) }
        return (url, verifier)
    }
}
