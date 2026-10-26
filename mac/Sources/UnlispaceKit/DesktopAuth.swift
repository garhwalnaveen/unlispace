import Foundation
import AuthenticationServices
import AppKit

public enum AuthError: Error, Equatable, Sendable {
    case invalidCallback
    case stateMismatch
    case missingCode
    case providerError(String)
    case cancelled
    case exchangeFailed(Int)
    case startFailed(Int)
    case badEndpoint
    case badResponse
}

public struct AuthCallback: Equatable, Sendable {
    public let code: String
    public let state: String
}

public enum CallbackParser {
    /// Parses `uls://auth/callback#code=...&state=...` and verifies state.
    public static func parse(_ url: URL, expectedState: String) throws -> AuthCallback {
        guard url.scheme == "uls", url.host == "auth", url.path == "/callback" else {
            throw AuthError.invalidCallback
        }
        guard let fragment = url.fragment else { throw AuthError.invalidCallback }
        var comps = URLComponents()
        comps.query = fragment
        var map: [String: String] = [:]
        for item in comps.queryItems ?? [] { if let v = item.value { map[item.name] = v } }

        // Check state first so a forged callback never reaches the code.
        guard let state = map["state"], constantTimeEqual(state, expectedState) else {
            throw AuthError.stateMismatch
        }
        if let err = map["error"] { throw AuthError.providerError(err) }
        guard let code = map["code"], !code.isEmpty else { throw AuthError.missingCode }
        return AuthCallback(code: code, state: state)
    }

    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<x.count { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}

/// Pure request/response pieces of the contract §5.1 desktop flow (unit-tested).
public enum DesktopAuthWire {
    /// `GET {api}/auth/desktop/start?state&code_challenge&code_challenge_method=S256`
    public static func startURL(api: URL, challenge: String, state: String) throws -> URL {
        guard var c = URLComponents(url: api.appendingPathComponent("auth/desktop/start"), resolvingAgainstBaseURL: false) else {
            throw AuthError.badEndpoint
        }
        c.queryItems = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let u = c.url else { throw AuthError.badEndpoint }
        return u
    }

    /// `POST {api}/auth/desktop/exchange {code, codeVerifier}`
    public static func exchangeRequest(api: URL, code: String, verifier: String) throws -> URLRequest {
        struct Body: Encodable { var code: String; var codeVerifier: String }
        var req = URLRequest(url: api.appendingPathComponent("auth/desktop/exchange"))
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        req.httpBody = try enc.encode(Body(code: code, codeVerifier: verifier))
        return req
    }

    public static func decodeExchange(status: Int, data: Data) throws -> Session {
        guard status == 200 else { throw AuthError.exchangeFailed(status) }
        guard let s = try? JSONDecoder().decode(Session.self, from: data) else { throw AuthError.badResponse }
        return s
    }
}

/// M1 sign-in: ASWebAuthenticationSession (callback scheme `uls`) -> state check -> exchange.
/// Returns the `Session`; the caller hands it to the daemon via `SessionHandoff`. This type
/// stores nothing.
@MainActor
public final class DesktopAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let session: URLSession
    private var webSession: ASWebAuthenticationSession?
    private var callback: (id: UUID, state: String, startURL: URL, continuation: CheckedContinuation<URL, any Error>)?

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func signIn(api: URL) async throws -> Session {
        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(forVerifier: verifier)
        let state = PKCE.makeState()
        let url = try DesktopAuthWire.startURL(api: api, challenge: challenge, state: state)
        try await checkSignInService(url: url)
        try Task.checkCancellation()

        let callbackURL = try await waitForCallback(url: url, state: state)
        return try await exchange(callbackURL: callbackURL, api: api, expectedState: state, verifier: verifier)
    }

    var isAwaitingCallback: Bool { callback != nil }

    func waitForCallback(url: URL, state: String,
                         start: (ASWebAuthenticationSession) -> Bool = { $0.start() }) async throws -> URL {
        return try await withCheckedThrowingContinuation { cont in
            let id = UUID()
            callback = (id, state, url, cont)
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "uls") { [weak self] url, error in
                let result: Result<URL, any Error>
                if let url { result = .success(url) }
                else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    result = .failure(AuthError.cancelled)
                } else {
                    result = .failure(error ?? AuthError.invalidCallback)
                }
                Task { @MainActor in self?.completeCallback(result, id: id) }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            self.webSession = s
            if !start(s) { completeCallback(.failure(AuthError.invalidCallback), id: id) }
        }
    }

    /// Explicit fallback when the system authentication window doesn't appear.
    public func openBrowser() -> Bool {
        guard let pending = callback else { return false }
        return NSWorkspace.shared.open(pending.startURL)
    }

    /// Only an outstanding, state-matched sign-in can consume a custom-scheme callback.
    public func receiveCallback(_ url: URL) -> Bool {
        guard let pending = callback else { return false }
        let result: Result<URL, any Error>
        do {
            _ = try CallbackParser.parse(url, expectedState: pending.state)
            result = .success(url)
        } catch let error as AuthError {
            guard case .providerError = error else { return false }
            result = .failure(error)
        } catch { return false }
        let activeSession = webSession
        completeCallback(result, id: pending.id)
        activeSession?.cancel()
        return true
    }

    /// Check the configured API and web redirect before opening a browser that could stall.
    func checkSignInService(url: URL) async throws {
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AuthError.badResponse }
        guard (200..<400).contains(http.statusCode) else { throw AuthError.startFailed(http.statusCode) }
    }

    /// Shared by browser sign-in and the opt-in real-Worker acceptance test.
    func exchange(callbackURL: URL, api: URL, expectedState: String, verifier: String) async throws -> Session {
        let cb = try CallbackParser.parse(callbackURL, expectedState: expectedState)
        let req = try DesktopAuthWire.exchangeRequest(api: api, code: cb.code, verifier: verifier)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw AuthError.badResponse }
        let result = try DesktopAuthWire.decodeExchange(status: http.statusCode, data: data)
        Log.auth.info("desktop sign-in exchange completed")
        return result
    }

    private func completeCallback(_ result: Result<URL, any Error>, id: UUID) {
        guard let pending = callback, pending.id == id else { return }
        callback = nil
        webSession = nil
        pending.continuation.resume(with: result)
    }

    public func cancel() {
        let activeSession = webSession
        // ASWebAuthenticationSession.cancel() need not invoke its completion handler.
        if let pending = callback { completeCallback(.failure(AuthError.cancelled), id: pending.id) }
        activeSession?.cancel()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}
