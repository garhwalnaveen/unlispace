import Foundation

// auth.* part of the daemon protocol (see mac/DAEMON-PROTOCOL.md, "M1 sign-in").

public struct AuthUser: Codable, Sendable, Equatable {
    public var id: String
    public var email: String
    public init(id: String, email: String) { self.id = id; self.email = email }
}

/// `auth.set` params. Carries secrets: `description` and `debugDescription` redact them.
public struct AuthSetParams: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public var apiEndpoint: String
    public var accessToken: String
    public var refreshToken: String
    public init(apiEndpoint: String, accessToken: String, refreshToken: String) {
        self.apiEndpoint = apiEndpoint; self.accessToken = accessToken; self.refreshToken = refreshToken
    }
    public var description: String {
        "AuthSetParams(apiEndpoint: \(apiEndpoint), accessToken: \(LogFormat.redacted), refreshToken: \(LogFormat.redacted))"
    }
    public var debugDescription: String { description }
}

/// `auth.set` result.
public struct AuthSetResult: Codable, Sendable, Equatable {
    public var user: AuthUser
    public init(user: AuthUser) { self.user = user }
}

/// `auth.status` result.
public struct AuthStatus: Codable, Sendable, Equatable {
    public var signedIn: Bool
    public var user: AuthUser?
    public var apiEndpoint: String?
    public init(signedIn: Bool, user: AuthUser? = nil, apiEndpoint: String? = nil) {
        self.signedIn = signedIn; self.user = user; self.apiEndpoint = apiEndpoint
    }
}

extension DaemonConfig: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        "DaemonConfig(endpoint: \(endpoint ?? "nil"), token: \(token == nil ? "nil" : LogFormat.redacted), cacheCapBytes: \(cacheCapBytes.map(String.init) ?? "nil"))"
    }
    public var debugDescription: String { description }
}
