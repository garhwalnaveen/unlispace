import Foundation
import OrbitKit

/// Names, warnings, and error text for renaming, copying, and deleting a drive.
enum DriveManagement {
    static let nameLimit = 100

    /// The trimmed name, or nil when it is empty, too long, or unchanged.
    static func validName(_ text: String, current: String? = nil) -> String? {
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= nameLimit, name != current else { return nil }
        return name
    }

    /// "Design copy", then "Design copy 2", skipping names already in use.
    static func copyName(for name: String, existing: [String]) -> String {
        let taken = Set(existing.map { $0.lowercased() })
        let base = String("\(name) copy".suffix(nameLimit))
        if !taken.contains(base.lowercased()) { return base }
        for number in 2...999 {
            let suffix = " copy \(number)"
            let candidate = String(name.prefix(nameLimit - suffix.count)) + suffix
            if !taken.contains(candidate.lowercased()) { return candidate }
        }
        return base
    }

    /// What deleting does, in the order the user will notice it.
    static func deleteWarning(for drive: DriveInfo) -> String {
        var lines = ["The drive leaves Finder on every Mac, and nobody in the workspace can open its files any more."]
        if drive.mountState == .mounted {
            lines.append("Changes that have not finished uploading from this Mac are lost.")
        }
        lines.append("This can't be undone from Orbit. If you might need the files later, make a copy of the drive first.")
        return lines.joined(separator: "\n\n")
    }

    /// The engine forwards only the requests it knows; an older one refuses rename and delete.
    static func isUnsupported(_ error: Error) -> Bool {
        guard case DaemonClientError.remote(let remote) = error else { return false }
        return remote.code == "unsupported" || remote.isUnknownMethod
            || (remote.code == "bad_request" && remote.message.lowercased().contains("unsupported api path"))
    }

    static func message(for error: Error, verb: String) -> String {
        if case DaemonClientError.remote(let remote) = error {
            switch remote.code {
            case "forbidden": return "Only workspace owners and admins can \(verb) a drive."
            case "plan_limit":
                return "Your files are safe. This workspace has reached its limit for drives, so nothing was changed. Manage the plan on the web to add more."
            case "drive_not_ready": return "This drive is busy. Try again in a moment."
            case "drive_has_forks": return "This drive has copies that depend on it. Delete the copies first."
            case "no_such_drive": return "This drive no longer exists."
            default: break
            }
        }
        return "Could not \(verb) the drive: \(Format.problem(error))"
    }
}
