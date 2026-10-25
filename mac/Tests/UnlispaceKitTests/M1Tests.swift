import Testing
import Foundation
@testable import UnlispaceKit

private let contractSession = #"""
{"accessToken":"eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1XzEifQ.c2ln","refreshToken":"rt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","expiresIn":900,"user":{"id":"u_01","email":"a@b.co"},"accountCreated":true}
"""#

@Suite struct SessionTests {
    @Test func decodesContractShape() throws {
        let s = try JSONDecoder().decode(Session.self, from: Data(contractSession.utf8))
        #expect(s.expiresIn == 900)
        #expect(s.user == SessionUser(id: "u_01", email: "a@b.co"))
        #expect(s.accountCreated)
        #expect(s.refreshToken.hasPrefix("rt_"))
    }

    @Test func ignoresUnknownFields() throws {
        let j = #"{"accessToken":"a","refreshToken":"r","expiresIn":900,"user":{"id":"u","email":"e","x":1},"accountCreated":false,"extra":true}"#
        #expect(try JSONDecoder().decode(Session.self, from: Data(j.utf8)).accountCreated == false)
    }

    @Test(arguments: ["accessToken", "refreshToken", "expiresIn", "user", "accountCreated"])
    func missingTopLevelFieldFails(_ field: String) throws {
        var obj = try #require(JSONSerialization.jsonObject(with: Data(contractSession.utf8)) as? [String: Any])
        obj.removeValue(forKey: field)
        let data = try JSONSerialization.data(withJSONObject: obj)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(Session.self, from: data) }
    }

    @Test func missingUserEmailFails() {
        let j = #"{"accessToken":"a","refreshToken":"r","expiresIn":900,"user":{"id":"u"},"accountCreated":false}"#
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(Session.self, from: Data(j.utf8)) }
    }

    @Test func snakeCaseShapeRejected() {
        let j = #"{"access_token":"a","refresh_token":"r","expiresIn":900,"user":{"id":"u","email":"e"},"accountCreated":false}"#
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(Session.self, from: Data(j.utf8)) }
    }

    @Test func exchangeDecodeStatusHandling() throws {
        #expect(throws: AuthError.exchangeFailed(400)) { try DesktopAuthWire.decodeExchange(status: 400, data: Data()) }
        #expect(throws: AuthError.badResponse) { try DesktopAuthWire.decodeExchange(status: 200, data: Data("{}".utf8)) }
        #expect(try DesktopAuthWire.decodeExchange(status: 200, data: Data(contractSession.utf8)).user.id == "u_01")
    }
}

@Suite struct DesktopWireTests {
    @Test func exchangeRequestBody() throws {
        let api = URL(string: "http://127.0.0.1:8788")!
        let req = try DesktopAuthWire.exchangeRequest(api: api, code: "C0DE", verifier: "VERIFIER")
        #expect(req.httpMethod == "POST")
        #expect(req.url?.absoluteString == "http://127.0.0.1:8788/auth/desktop/exchange")
        #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(String(decoding: try #require(req.httpBody), as: UTF8.self) == #"{"code":"C0DE","codeVerifier":"VERIFIER"}"#)
    }

    @Test func startURL() throws {
        let u = try DesktopAuthWire.startURL(api: URL(string: "https://api.unlispace.com")!, challenge: "CH", state: "ST")
        let c = try #require(URLComponents(url: u, resolvingAgainstBaseURL: false))
        #expect(c.path == "/auth/desktop/start")
        let q = Dictionary(uniqueKeysWithValues: (c.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(q == ["state": "ST", "code_challenge": "CH", "code_challenge_method": "S256"])
    }
}

@Suite struct DeepLinkTests {
    private func parse(_ s: String) throws -> DeepLink { try DeepLink.parse(URL(string: s)!) }

    @Test func authCallbackRecognised() throws {
        #expect(try parse("uls://auth/callback#code=a&state=b") == .authCallback)
    }

    @Test func openParses() throws {
        #expect(try parse("uls://open?drive=d-01abc&path=docs/a%20b.txt") == .open(driveId: "d-01abc", path: "docs/a b.txt"))
        #expect(try parse("uls://open?drive=d-01abc") == .open(driveId: "d-01abc", path: ""))
    }

    @Test func rejectsTraversalAndAbsolute() {
        #expect(throws: DeepLinkError.invalidPath(.traversal)) { try parse("uls://open?drive=d-01abc&path=../etc") }
        #expect(throws: DeepLinkError.invalidPath(.traversal)) { try parse("uls://open?drive=d-01abc&path=a/../../b") }
        #expect(throws: DeepLinkError.invalidPath(.traversal)) { try parse("uls://open?drive=d-01abc&path=a/%2e%2e/b") }
        #expect(throws: DeepLinkError.invalidPath(.absolute)) { try parse("uls://open?drive=d-01abc&path=/etc/passwd") }
        #expect(throws: DeepLinkError.invalidPath(.absolute)) { try parse("uls://open?drive=d-01abc&path=%2Fetc") }
        #expect(throws: DeepLinkError.invalidPath(.controlCharacter)) { try parse("uls://open?drive=d-01abc&path=a%00b") }
    }

    @Test func rejectsBadDriveAndShape() {
        #expect(throws: DeepLinkError.missingDrive) { try parse("uls://open?path=a") }
        #expect(throws: DeepLinkError.invalidDrive) { try parse("uls://open?drive=../x") }
        #expect(throws: DeepLinkError.invalidDrive) { try parse("uls://open?drive=AB") }
        #expect(throws: DeepLinkError.duplicateParameter("drive")) { try parse("uls://open?drive=d-1a&drive=d-2b") }
        #expect(throws: DeepLinkError.notUnlispaceURL) { try parse("https://open?drive=d-01abc") }
        #expect(throws: DeepLinkError.unknownAction("evil")) { try parse("uls://evil") }
    }

    @Test func dotSegmentsAreFineButNamesWithDotsToo() {
        #expect(DeepLink.pathError("a/./b") == nil)
        #expect(DeepLink.pathError("..hidden/file..") == nil)
        #expect(DeepLink.pathError("a/..") == .traversal)
    }

    @Test func resolveStaysInsideMount() {
        #expect(DeepLink.resolve(mountPath: "/Volumes/Space", path: "a/b.txt")?.path == "/Volumes/Space/a/b.txt")
        #expect(DeepLink.resolve(mountPath: "/Volumes/Space", path: "")?.path == "/Volumes/Space")
        #expect(DeepLink.resolve(mountPath: "/Volumes/Space", path: "../x") == nil)
        #expect(DeepLink.resolve(mountPath: "/Volumes/Space", path: "/x") == nil)
        #expect(DeepLink.resolve(mountPath: "relative", path: "x") == nil)
    }
}

@Suite struct AuthProtocolTests {
    @Test func encodeAuthSet() throws {
        let p = AuthSetParams(apiEndpoint: "https://api.unlispace.com", accessToken: "AT", refreshToken: "RT")
        let d = try DaemonCodec.encodeRequest(id: 3, method: "auth.set", params: p)
        #expect(String(decoding: d, as: UTF8.self) ==
            #"{"id":3,"method":"auth.set","params":{"accessToken":"AT","apiEndpoint":"https://api.unlispace.com","refreshToken":"RT"}}"#)
    }

    @Test func encodeStatusAndSignOutHaveNoParams() throws {
        #expect(String(decoding: try DaemonCodec.encodeRequest(id: 4, method: "auth.status"), as: UTF8.self) == #"{"id":4,"method":"auth.status"}"#)
        #expect(String(decoding: try DaemonCodec.encodeRequest(id: 5, method: "auth.signOut"), as: UTF8.self) == #"{"id":5,"method":"auth.signOut"}"#)
    }

    @Test func decodeAuthSetResult() throws {
        let line = Data(#"{"id":3,"result":{"user":{"id":"u_1","email":"a@b.co"}}}"#.utf8)
        guard case .response(let r) = try DaemonCodec.decodeServerLine(line) else { Issue.record(); return }
        #expect(try #require(r.result).decode(AuthSetResult.self).user == AuthUser(id: "u_1", email: "a@b.co"))
    }

    @Test func decodeAuthStatus() throws {
        let on = JSONValue.object(["signedIn": .bool(true), "user": .object(["id": .string("u"), "email": .string("e")]), "apiEndpoint": .string("http://x")])
        #expect(try on.decode(AuthStatus.self) == AuthStatus(signedIn: true, user: AuthUser(id: "u", email: "e"), apiEndpoint: "http://x"))
        let off = JSONValue.object(["signedIn": .bool(false)])
        #expect(try off.decode(AuthStatus.self) == AuthStatus(signedIn: false))
    }

    @Test func decodeUnauthorizedError() throws {
        let line = Data(#"{"id":3,"error":{"code":"unauthorized","message":"bad"}}"#.utf8)
        guard case .response(let r) = try DaemonCodec.decodeServerLine(line) else { Issue.record(); return }
        #expect(r.error?.code == "unauthorized")
    }

    @Test func signedOutStateEvent() throws {
        let line = Data(#"{"event":"state","data":{"state":"signed_out"}}"#.utf8)
        #expect(try DaemonCodec.decodeServerLine(line) == .event(.state(StateEvent(state: .signedOut))))
    }

    @Test func mockCoversAuthMethods() async throws {
        let m = MockDaemonClient()
        #expect(try await m.authStatus().signedIn == false)
        let res = try await m.authSet(AuthSetParams(apiEndpoint: "http://x", accessToken: "a", refreshToken: "r"))
        #expect(try await m.authStatus() == AuthStatus(signedIn: true, user: res.user, apiEndpoint: "http://x"))
        try await m.mount(driveId: "demo")
        try await m.authSignOut()
        #expect(try await m.authStatus().signedIn == false)
        #expect(try await m.listDrives().allSatisfy { $0.mountState == .unmounted })
        await #expect(throws: DaemonClientError.self) {
            try await m.authSet(AuthSetParams(apiEndpoint: "x", accessToken: "", refreshToken: "r"))
        }
    }
}

/// A client that fails `authSet` in a configurable way.
private actor FlakyClient: DaemonClient {
    var failure: DaemonClientError?
    var received: [AuthSetParams] = []
    init(failure: DaemonClientError?) { self.failure = failure }
    func setFailure(_ f: DaemonClientError?) { failure = f }
    func connect() async throws {}
    func disconnect() async {}
    func status() async throws -> DaemonStatus { DaemonStatus(version: "t", state: .idle) }
    func listDrives() async throws -> [DriveInfo] { [] }
    func mount(driveId: String) async throws {}
    func unmount(driveId: String) async throws {}
    func transfers() async throws -> [TransferInfo] { [] }
    func setConfig(_ config: DaemonConfig) async throws {}
    func authSet(_ params: AuthSetParams) async throws -> AuthSetResult {
        received.append(params)
        if let failure { throw failure }
        return AuthSetResult(user: AuthUser(id: "u_1", email: "a@b.co"))
    }
    func authStatus() async throws -> AuthStatus { AuthStatus(signedIn: false) }
    func authSignOut() async throws {}
    nonisolated func events() -> AsyncStream<DaemonEvent> { AsyncStream { $0.finish() } }
}

@Suite(.serialized) struct HandoffTests {
    private func makeSession() -> Session {
        Session(accessToken: "AT", refreshToken: "RT", expiresIn: 900, user: SessionUser(id: "u_1", email: "a@b.co"), accountCreated: false)
    }
    private func kc() -> Keychain { Keychain(service: "com.unlispace.app.tests.\(UUID().uuidString)") }
    private let api = URL(string: "http://127.0.0.1:8788")!

    @Test func daemonAbsentKeepsPendingThenRetryDeletesIt() async throws {
        let k = kc()
        defer { try? k.delete(account: Keychain.Account.pendingSession) }
        let h = SessionHandoff(keychain: k)

        // No daemon at all (mock mode): stored, deferred.
        #expect(try await h.deliver(makeSession(), api: api, to: nil) == .deferred)
        #expect(h.hasPending)
        #expect(h.pending()?.refreshToken == "RT")

        // Daemon refuses the connection too: still deferred.
        let flaky = FlakyClient(failure: .notConnected)
        #expect(try await h.retryPending(to: flaky) == .deferred)
        #expect(h.hasPending)

        // Daemon connects: acked, app copy gone.
        await flaky.setFailure(nil)
        #expect(try await h.retryPending(to: flaky) == .delivered(AuthUser(id: "u_1", email: "a@b.co")))
        #expect(!h.hasPending)
        #expect(try k.get(account: Keychain.Account.pendingSession) == nil)
        let sent = await flaky.received.last
        #expect(sent == AuthSetParams(apiEndpoint: api.absoluteString, accessToken: "AT", refreshToken: "RT"))

        // Nothing left to retry.
        #expect(try await h.retryPending(to: flaky) == nil)
    }

    @Test func ackedImmediatelyNeverTouchesKeychain() async throws {
        let k = kc()
        let h = SessionHandoff(keychain: k)
        let ok = FlakyClient(failure: nil)
        #expect(try await h.deliver(makeSession(), api: api, to: ok) == .delivered(AuthUser(id: "u_1", email: "a@b.co")))
        #expect(try k.get(account: Keychain.Account.pendingSession) == nil)
    }

    @Test func rejectedSessionIsDroppedNotRetried() async throws {
        let k = kc()
        let h = SessionHandoff(keychain: k)
        let bad = FlakyClient(failure: .remote(DaemonError(code: "unauthorized", message: "no")))
        await #expect(throws: DaemonClientError.self) { try await h.deliver(makeSession(), api: api, to: bad) }
        #expect(!h.hasPending)
    }

    @Test func realClientWithoutSocketIsRetryable() async {
        let c = UnixSocketDaemonClient(socketPath: "/tmp/nope-\(UUID().uuidString).sock")
        await #expect(throws: DaemonClientError.notConnected) { try await c.authSet(AuthSetParams(apiEndpoint: "x", accessToken: "a", refreshToken: "r")) }
        #expect(SessionHandoff.isRetryable(DaemonClientError.notConnected))
        #expect(SessionHandoff.isRetryable(DaemonClientError.remote(DaemonError(code: "offline", message: ""))))
        #expect(!SessionHandoff.isRetryable(DaemonClientError.remote(DaemonError(code: "unauthorized", message: ""))))
    }
}

@Suite struct LogFormatTests {
    let jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1XzEifQ.c2lnbmF0dXJl"
    let rt = "rt_" + String(repeating: "A", count: 43)

    @Test func scrubsTokensFromFreeText() {
        let text = "failed Authorization: Bearer \(jwt) refresh \(rt) code=SECRETCODE&state=S1 {\"refreshToken\":\"\(rt)\",\"codeVerifier\":\"V\"}"
        let out = LogFormat.scrub(text)
        for secret in [jwt, rt, "SECRETCODE", "S1", "\"V\""] { #expect(!out.contains(secret), "leaked \(secret)") }
    }

    @Test func descriptionsRedact() {
        let p = AuthSetParams(apiEndpoint: "http://x", accessToken: jwt, refreshToken: rt)
        for s in [p.description, p.debugDescription, "\(p)", String(reflecting: p)] {
            #expect(!s.contains(jwt) && !s.contains(rt))
        }
        let sess = Session(accessToken: jwt, refreshToken: rt, expiresIn: 900, user: SessionUser(id: "u", email: "e"), accountCreated: false)
        for s in ["\(sess)", String(reflecting: sess), sess.description] { #expect(!s.contains(jwt) && !s.contains(rt)) }
        let pend = PendingSession(apiEndpoint: "x", accessToken: jwt, refreshToken: rt, email: "e")
        #expect(!"\(pend)".contains(rt) && !"\(pend)".contains(jwt))
        let cfg = DaemonConfig(endpoint: "http://x", token: "DEVTOKEN", cacheCapBytes: 5)
        #expect(!"\(cfg)".contains("DEVTOKEN"))
    }

    @Test func callbackURLLogsWithoutFragment() {
        let u = URL(string: "uls://auth/callback#code=SECRETCODE&state=ST")!
        let s = LogFormat.url(u)
        #expect(s == "uls://auth/callback")
        #expect(!LogFormat.url(URL(string: "uls://open?drive=d-1a&path=secret/x")!).contains("secret"))
    }

    @Test func describeScrubsErrors() {
        let e = DaemonClientError.remote(DaemonError(code: "bad_request", message: "bad token \(rt)"))
        #expect(!LogFormat.describe(e).contains(rt))
        #expect(LogFormat.describe(e).contains("bad_request"))
        struct Leaky: Error { var tok: String }
        #expect(!LogFormat.describe(Leaky(tok: "Bearer \(jwt)")).contains(jwt))
    }
}
