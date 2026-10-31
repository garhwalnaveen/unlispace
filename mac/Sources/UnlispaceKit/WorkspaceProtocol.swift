import Foundation

public struct FileSearchEntry: Codable, Sendable, Equatable, Identifiable {
    public var path: String
    public var type: String
    public var size: Int64
    public var id: String { path }

    /// Server paths must stay within the mounted volume, including when an old engine is used.
    public func localURL(mountPath: String) -> URL? {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.hasPrefix("/"), !path.contains("\0"),
              components.enumerated().allSatisfy({ i, c in
                  c != "." && c != ".." && (!c.isEmpty || i == components.count - 1)
              }) else { return nil }
        return URL(fileURLWithPath: mountPath, isDirectory: true).appendingPathComponent(path)
    }
}

public struct FileSearchPage: Codable, Sendable, Equatable {
    public var entries: [FileSearchEntry]
    public var cursor: String?
}

public struct WorkspaceInfo: Decodable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var role: String
    public var tier: String
    public var trialEndsAt: Int64?
    public var trialPending: Bool?
    public var drives: [WorkspaceDriveInfo]?
    public var canManage: Bool { role == "owner" || role == "admin" }

    public var trialEndDate: Date? { trialEndsAt.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
}

public struct WorkspaceDriveInfo: Decodable, Sendable {
    public var id: String
    public var status: String
}

/// `GET /me/access`.
public struct MeAccess: Decodable, Sendable {
    public struct User: Decodable, Sendable { public var id: String; public var email: String }
    public struct Workspace: Decodable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var role: String?
        public var tier: String?
        /// `provisioning`, `trial_active`, `paid` or `expired`; a string so new states don't break decoding.
        public var state: String
        public var trialPending: Bool?
        public var trialEndsAt: Int64?
        public var writable: Bool?
        public var storageReady: Bool
        public var quotaBytes: Int64?
        public var usedBytes: Int64?
        public var trialEndDate: Date? { trialEndsAt.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
    }
    public var user: User?
    public var workspaces: [Workspace]
}

public struct WorkspacesResult: Decodable, Sendable { public var orgs: [WorkspaceInfo] }
public struct ClientConfiguration: Decodable, Sendable {
    public var webOrigin: String

    public func page(orgId: String, section: String) -> URL? {
        guard let url = AppSettings.validateEndpoint(webOrigin), url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path == "" || url.path == "/",
              ["team", "billing"].contains(section),
              !orgId.isEmpty, orgId.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }) else { return nil }
        return url.appendingPathComponent("orgs").appendingPathComponent(orgId).appendingPathComponent(section)
    }
}
