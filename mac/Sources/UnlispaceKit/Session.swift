import Foundation

public struct SessionUser: Decodable, Sendable, Equatable {
    public let id: String
    public let email: String
    public init(id: String, email: String) { self.id = id; self.email = email }
}

/// `Session` from docs/design/m1-contract.md §5.1:
/// `{"accessToken","refreshToken","expiresIn":900,"user":{"id","email"},"accountCreated":bool}`.
/// Every field is required; a missing one fails decoding. Deliberately not `Encodable`, and its
/// `description` redacts the tokens.
public struct Session: Decodable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public let accessToken: String
    public let refreshToken: String
    public let expiresIn: Int
    public let user: SessionUser
    public let accountCreated: Bool

    public init(accessToken: String, refreshToken: String, expiresIn: Int, user: SessionUser, accountCreated: Bool) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresIn = expiresIn
        self.user = user; self.accountCreated = accountCreated
    }

    public var description: String {
        "Session(user: \(user.id), expiresIn: \(expiresIn), accountCreated: \(accountCreated), tokens: \(LogFormat.redacted))"
    }
    public var debugDescription: String { description }
}

/// A session that could not yet be handed to the daemon. Stored as ONE Keychain item
/// (service `com.unlispace.app`, account `pending-session`) and removed once the daemon acks.
public struct PendingSession: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public var apiEndpoint: String
    public var accessToken: String
    public var refreshToken: String
    public var email: String
    public init(apiEndpoint: String, accessToken: String, refreshToken: String, email: String) {
        self.apiEndpoint = apiEndpoint; self.accessToken = accessToken
        self.refreshToken = refreshToken; self.email = email
    }
    public var authParams: AuthSetParams {
        AuthSetParams(apiEndpoint: apiEndpoint, accessToken: accessToken, refreshToken: refreshToken)
    }
    public var description: String { "PendingSession(email: \(email), tokens: \(LogFormat.redacted))" }
    public var debugDescription: String { description }
}
