import Foundation
import OrbitKit
import OrbitTestSupport
@testable import Orbit

/// Defaults that live only in memory, so tests never read or leave behind real preferences.
final class MemoryDefaults: UserDefaults, @unchecked Sendable {
    private var values: [String: Any] = [:]
    private let lock = NSLock()
    init() { super.init(suiteName: nil)! }
    override func object(forKey defaultName: String) -> Any? { lock.withLock { values[defaultName] } }
    override func set(_ value: Any?, forKey defaultName: String) { lock.withLock { values[defaultName] = value } }
    override func removeObject(forKey defaultName: String) { lock.withLock { values[defaultName] = nil } }
}

/// Prompts that answer without showing UI.
struct StubPrompts: UserPrompts {
    var confirms = true
    var file: URL?
    func confirm(title: String, message: String, action: String) -> Bool { confirms }
    func chooseFile(message: String, action: String) -> URL? { file }
}

@MainActor enum Fixtures {
    /// A model whose engine socket does not exist, so it can never connect to a real engine.
    static func offline(defaults: UserDefaults = MemoryDefaults()) -> AppModel {
        let socket = "/tmp/orbit-no-socket-\(UUID().uuidString)"
        let model = AppModel(defaults: defaults, engine: EngineLink(makeClient: { UnixSocketDaemonClient(socketPath: socket) }),
                             prompts: StubPrompts())
        // Most tests describe the app after first-run setup; the ones about setup turn this off.
        model.setupCompleted = true
        return model
    }

    /// A model connected to a test double.
    static func connected(to client: any DaemonClient = MockDaemonClient(), defaults: UserDefaults = MemoryDefaults(),
                          prompts: any UserPrompts = StubPrompts()) -> AppModel {
        let model = AppModel(defaults: defaults, engine: EngineLink(makeClient: { client }), prompts: prompts)
        model.setupCompleted = true
        model.engine.adopt(client)
        return model
    }

    static func defaults() -> (UserDefaults, cleanup: () -> Void) {
        let name = "orbit-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        return (defaults, { defaults.removePersistentDomain(forName: name) })
    }

    nonisolated static let account = AuthUser(id: "one", email: "local@example.invalid")
}

/// An engine that returns a fixed snapshot, for rendering exact states.
actor SnapshotClient: DaemonClient {
    var daemon = DaemonStatus(version: "test", state: .idle)
    var auth = AuthStatus(signedIn: true, user: Fixtures.account)
    var drives: [DriveInfo] = []
    var live: [TransferInfo] = []
    var queue: UploadsSnapshot? = UploadsSnapshot(pending: [], journalBytes: 0, journalCapBytes: 10_000_000_000)
    var pins: [OfflinePin]? = []
    /// Replies to `apiRequest`, keyed by "METHOD /path". A request without a reply is refused like an older engine would.
    var replies: [String: JSONValue] = [:]
    var failures: [String: DaemonError] = [:]
    private(set) var requests: [String] = []
    private(set) var unmounted: [String] = []
    private let stream: AsyncStream<DaemonEvent>
    private let continuation: AsyncStream<DaemonEvent>.Continuation

    init(drives: [DriveInfo] = [], transfers: [TransferInfo] = [], queue: UploadsSnapshot? = nil, pins: [OfflinePin]? = [],
         state: EngineState = .idle, api: [String: JSONValue] = [:]) {
        self.replies = Dictionary(uniqueKeysWithValues: api.map { ("GET " + $0.key, $0.value) })
        self.drives = drives
        live = transfers
        if let queue { self.queue = queue }
        self.pins = pins
        daemon = DaemonStatus(version: "test", state: state)
        (stream, continuation) = AsyncStream.makeStream()
    }

    func connect() async throws {}
    func disconnect() async { continuation.finish() }
    func status() async throws -> DaemonStatus { daemon }
    func authStatus() async throws -> AuthStatus { auth }
    func listDrives() async throws -> [DriveInfo] { drives }
    func transfers() async throws -> [TransferInfo] { live }
    func uploads() async throws -> UploadsSnapshot? { queue }
    func listPins(driveId: String?) async throws -> [OfflinePin]? { pins }
    func mount(driveId: String) async throws {}
    func unmount(driveId: String) async throws { unmounted.append(driveId) }
    func reply(_ request: String, _ json: String) throws {
        replies[request] = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }
    func fail(_ request: String, code: String, message: String = "") { failures[request] = DaemonError(code: code, message: message) }
    func setDrives(_ new: [DriveInfo]) { drives = new }
    func apiRequest(method: String, path: String, body: JSONValue?) async throws -> JSONValue {
        let request = "\(method) \(path)"
        requests.append(request)
        if let failure = failures[request] { throw DaemonClientError.remote(failure) }
        if let reply = replies[request] { return reply }
        throw DaemonClientError.remote(DaemonError(code: "bad_request", message: "unsupported API path"))
    }
    func setConfig(_ config: DaemonConfig) async throws {}
    func authSet(_ params: AuthSetParams) async throws -> AuthSetResult { AuthSetResult(user: Fixtures.account) }
    func authSignOut() async throws {}
    nonisolated func events() -> AsyncStream<DaemonEvent> { stream }
}

extension Fixtures {
    /// A connected model showing exactly what `client` reports.
    static func showing(_ client: SnapshotClient, prompts: any UserPrompts = StubPrompts()) async throws -> AppModel {
        let model = connected(to: client, prompts: prompts)
        try await model.engineRefresh(client)
        return model
    }

    /// The account's workspace, plan, and web address as the server reports them.
    static func workspace(_ client: SnapshotClient, drives: [String] = [], role: String = "owner",
                          state: String = "paid", writable: Bool = true, used: Int64 = 2_100_000_000,
                          quota: Int64 = 10_000_000_000) async throws {
        let list = drives.map { #"{"id":"\#($0)","status":"ready"}"# }.joined(separator: ",")
        try await client.reply("GET /orgs", #"{"orgs":[{"id":"org1","name":"Acme","role":"\#(role)","tier":"teams","drives":[\#(list)]}]}"#)
        try await client.reply("GET /me/access", #"{"workspaces":[{"id":"org1","name":"Acme","state":"\#(state)","storageReady":true,"writable":\#(writable),"usedBytes":\#(used),"quotaBytes":\#(quota)}]}"#)
        try await client.reply("GET /client-config", #"{"webOrigin":"https://orbit.example"}"#)
    }
}
