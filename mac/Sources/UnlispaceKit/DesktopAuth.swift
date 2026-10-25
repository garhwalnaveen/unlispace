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

public struct AuthTokens: Sendable, Equatable {
    public let accessToken: String
    public let refreshToken: String
}

/// M1 sign-in flow. Behind a flag and untested against a server.
@MainActor
public final class DesktopAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    public static let enabledDefaultsKey = "m1AuthEnabled"
    public static var isEnabled: Bool { UserDefaults.standard.bool(forKey: enabledDefaultsKey) }

    private let keychain: Keychain
    private let session: URLSession
    private var webSession: ASWebAuthenticationSession?

    public init(keychain: Keychain = Keychain(), session: URLSession = .shared) {
        self.keychain = keychain
        self.session = session
    }

    public func startURL(api: URL, challenge: String, state: String) throws -> URL {
        guard var c = URLComponents(url: api.appendingPathComponent("auth/desktop/start"), resolvingAgainstBaseURL: false) else {
            throw AuthError.badEndpoint
        }
        c.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect_uri", value: "uls://auth/callback"),
        ]
        guard let u = c.url else { throw AuthError.badEndpoint }
        return u
    }

    public func signIn(api: URL) async throws {
        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(forVerifier: verifier)
        let state = PKCE.makeState()
        let url = try startURL(api: api, challenge: challenge, state: state)

        let callbackURL: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "uls") { url, error in
                if let url { cont.resume(returning: url) }
                else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    cont.resume(throwing: AuthError.cancelled)
                } else {
                    cont.resume(throwing: error ?? AuthError.invalidCallback)
                }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            self.webSession = s
            if !s.start() { cont.resume(throwing: AuthError.invalidCallback) }
        }
        webSession = nil

        let cb = try CallbackParser.parse(callbackURL, expectedState: state)
        let tokens = try await exchange(api: api, code: cb.code, verifier: verifier)
        try keychain.set(tokens.refreshToken, account: Keychain.Account.refreshToken)
        Log.auth.info("desktop sign-in completed")
    }

    func exchange(api: URL, code: String, verifier: String) async throws -> AuthTokens {
        var req = URLRequest(url: api.appendingPathComponent("auth/desktop/exchange"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "code_verifier": verifier])
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw AuthError.badResponse }
        guard http.statusCode == 200 else { throw AuthError.exchangeFailed(http.statusCode) }
        struct Body: Decodable { var access_token: String; var refresh_token: String }
        guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw AuthError.badResponse }
        return AuthTokens(accessToken: b.access_token, refreshToken: b.refresh_token)
    }

    public func signOut() {
        try? keychain.delete(account: Keychain.Account.refreshToken)
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}
