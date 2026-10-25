import Foundation

public enum DeepLinkError: Error, Equatable, Sendable {
    case notUnlispaceURL
    case unknownAction(String)
    case missingDrive
    case invalidDrive
    case duplicateParameter(String)
    case invalidPath(PathError)
}

public enum PathError: Error, Equatable, Sendable {
    case absolute
    case traversal      // ".." segment
    case tooLong
    case controlCharacter
}

/// `uls://` URLs the app accepts.
///  - `uls://auth/callback#code=..&state=..`   (completed by the sign-in session)
///  - `uls://open?drive=<id>&path=<relative path>`
public enum DeepLink: Equatable, Sendable {
    case authCallback
    case open(driveId: String, path: String)

    public static let maxPathBytes = 4096

    public static func parse(_ url: URL) throws -> DeepLink {
        guard url.scheme?.lowercased() == "uls", let host = url.host?.lowercased() else {
            throw DeepLinkError.notUnlispaceURL
        }
        switch host {
        case "auth":
            guard url.path == "/callback" else { throw DeepLinkError.unknownAction("auth\(url.path)") }
            return .authCallback
        case "open":
            guard url.path.isEmpty || url.path == "/" else { throw DeepLinkError.unknownAction("open\(url.path)") }
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func single(_ name: String) throws -> String? {
                let m = items.filter { $0.name == name }
                if m.count > 1 { throw DeepLinkError.duplicateParameter(name) }
                return m.first?.value
            }
            guard let drive = try single("drive"), !drive.isEmpty else { throw DeepLinkError.missingDrive }
            guard isValidDriveId(drive) else { throw DeepLinkError.invalidDrive }
            let path = try single("path") ?? ""
            if let err = pathError(path) { throw DeepLinkError.invalidPath(err) }
            return .open(driveId: drive, path: path)
        default:
            throw DeepLinkError.unknownAction(host)
        }
    }

    /// Drive ids follow the M0 regex `[a-z0-9][a-z0-9-]{2,62}`.
    public static func isValidDriveId(_ s: String) -> Bool {
        let b = Array(s.utf8)
        guard (3...63).contains(b.count) else { return false }
        func alnum(_ c: UInt8) -> Bool { (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) }
        return alnum(b[0]) && b.dropFirst().allSatisfy { alnum($0) || $0 == 0x2D }
    }

    /// `nil` when `path` is an acceptable drive-relative path. Empty means the drive root.
    public static func pathError(_ path: String) -> PathError? {
        if path.utf8.count > maxPathBytes { return .tooLong }
        if path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) { return .controlCharacter }
        if path.hasPrefix("/") { return .absolute }
        if path.split(separator: "/", omittingEmptySubsequences: true).contains("..") { return .traversal }
        return nil
    }

    /// Joins a validated relative `path` onto the drive's mount path. Returns `nil` if the path is
    /// invalid or the result would leave the mount root.
    public static func resolve(mountPath: String, path: String) -> URL? {
        guard pathError(path) == nil, mountPath.hasPrefix("/") else { return nil }
        let root = URL(fileURLWithPath: mountPath, isDirectory: true).standardizedFileURL
        var url = root
        for seg in path.split(separator: "/", omittingEmptySubsequences: true) where seg != "." {
            url.appendPathComponent(String(seg))
        }
        let std = url.standardizedFileURL
        guard std.path == root.path || std.path.hasPrefix(root.path == "/" ? "/" : root.path + "/") else { return nil }
        return std
    }
}
