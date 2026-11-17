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

    public var trialEndDate: Date? { trialEndsAt.map(Date.init(epochMilliseconds:)) }
}

public struct WorkspaceDriveInfo: Decodable, Sendable {
    public var id: String
    public var status: String
}

/// `GET /me/access`.
public struct MeAccess: Decodable, Sendable {
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
        public var trialEndDate: Date? { trialEndsAt.map(Date.init(epochMilliseconds:)) }
    }
    public var user: AuthUser?
    public var workspaces: [Workspace]
}

extension Date {
    init(epochMilliseconds ms: Int64) { self.init(timeIntervalSince1970: Double(ms) / 1000) }
}

public struct WorkspacesResult: Decodable, Sendable { public var orgs: [WorkspaceInfo] }
public struct ClientConfiguration: Decodable, Sendable {
    public var webOrigin: String

    /// The web origin, only when it is a bare https (or loopback http) origin.
    private var origin: URL? {
        guard let url = AppSettings.validateEndpoint(webOrigin), url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path == "" || url.path == "/" else { return nil }
        return url
    }

    /// `[A-Za-z0-9_-]` only.
    private static func isSafeToken(_ s: String) -> Bool {
        s.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }
    }

    public func page(orgId: String, section: String) -> URL? {
        guard let url = origin, ["team", "billing"].contains(section),
              !orgId.isEmpty, Self.isSafeToken(orgId) else { return nil }
        return url.appendingPathComponent("orgs").appendingPathComponent(orgId).appendingPathComponent(section)
    }

    /// The signed-in home of the web app.
    public var home: URL? { origin }

    /// A drive's files on the web (`/drives/<id>`).
    public func drivePage(driveId: String) -> URL? {
        guard let url = origin, !driveId.isEmpty, Self.isSafeToken(driveId) else { return nil }
        return url.appendingPathComponent("drives").appendingPathComponent(driveId)
    }

    /// An embedded web page (`/embed/<page>`) with a one-time handoff in the fragment, which never reaches servers or logs.
    public func embedPage(_ page: String, handoff: String) -> URL? {
        guard let url = origin, ["ai"].contains(page),
              !handoff.isEmpty, handoff.utf8.count <= 256, Self.isSafeToken(handoff),
              var parts = URLComponents(url: url.appendingPathComponent("embed").appendingPathComponent(page), resolvingAgainstBaseURL: false) else { return nil }
        parts.fragment = "handoff=\(handoff)"
        return parts.url
    }
}
