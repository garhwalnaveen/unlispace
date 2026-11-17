import SwiftUI
import OrbitKit

/// Plan and storage problems, one line per affected workspace.
/// Each line says the files are safe before it says what to do.
struct PlanNotices: View {
    var directory: WorkspaceDirectory

    var body: some View {
        let notices = Self.notices(access: directory.access, workspaces: directory.workspaces)
        VStack(spacing: 0) {
            ForEach(notices) { notice in
                InlineMessage(kind: notice.waiting ? .info : .warning, text: notice.text) {
                    if !notice.waiting, let url = directory.config?.page(orgId: notice.id, section: "billing") {
                        Link("Manage Plan on the Web", destination: url)
                    }
                }
            }
            if !notices.isEmpty { Divider() }
        }
        .task(id: directory.loadKey) { await directory.load() }
    }

    struct Notice: Identifiable, Equatable {
        var id: String
        var text: String
        /// Nothing for the user to do: storage is still being prepared.
        var waiting = false
    }

    /// Uses `/me/access` when the server has it and falls back to trial dates from the workspace list.
    static func notices(access: [MeAccess.Workspace]?, workspaces: [WorkspaceInfo], now: Date = Date()) -> [Notice] {
        if let access {
            return access.compactMap { workspace in
                if workspace.state == "expired" {
                    return Notice(id: workspace.id, text: "\(workspace.name): Your files are safe. The trial has ended, so new changes are paused. Choose a plan to keep saving.")
                }
                if !workspace.storageReady {
                    return Notice(id: workspace.id, text: "\(workspace.name): Storage is being set up. Your drive appears when it is ready.", waiting: true)
                }
                // Over quota is reported as not writable too; it is a storage problem, not a plan problem.
                if workspace.pausedByStorage, let used = workspace.usedBytes, let quota = workspace.quotaBytes {
                    return Notice(id: workspace.id, text: "\(workspace.name): Your files are safe. Storage is full (\(Format.bytes(used)) of \(Format.bytes(quota))), so new changes are paused. Free up space or add storage.")
                }
                if workspace.writable == false {
                    return Notice(id: workspace.id, text: "\(workspace.name): Your files are safe. Saving changes is paused. Check the plan to continue.")
                }
                // Exactly at the quota changes still save, so nothing here may say they are paused.
                if workspace.isFull, let used = workspace.usedBytes, let quota = workspace.quotaBytes {
                    return Notice(id: workspace.id, text: "\(workspace.name): Your files are safe. Storage is full (\(Format.bytes(used)) of \(Format.bytes(quota))). Free up space or add storage to keep saving changes.")
                }
                if let fraction = workspace.storageFraction, fraction >= MenuHeadline.almostFull,
                   let used = workspace.usedBytes, let quota = workspace.quotaBytes {
                    return Notice(id: workspace.id, text: "\(workspace.name): Your files are safe. \(Format.bytes(used)) of \(Format.bytes(quota)) is used. Free up space or add storage before it runs out.")
                }
                return nil
            }
        }
        return workspaces.compactMap { workspace in
            if workspace.trialPending == true {
                return Notice(id: workspace.id, text: "\(workspace.name): Storage is being set up. Your drive appears when it is ready.", waiting: true)
            }
            if let end = workspace.trialEndDate, end <= now {
                return Notice(id: workspace.id, text: "\(workspace.name): Your files are safe. The trial has ended, so new changes may be paused. Check the plan.")
            }
            return nil
        }
    }
}

extension GetStarted {
    /// False when every workspace is known to reject uploads or every drive is view-only,
    /// so the list never asks for a first file that cannot be added.
    static func canAddFile(access: [MeAccess.Workspace]?, drives: [DriveInfo], mounts: [DaemonMount]?) -> Bool {
        if let access, !access.isEmpty, access.allSatisfy({ $0.state == "expired" || $0.writable == false }) { return false }
        if !drives.isEmpty, let mounts {
            let readOnly = Set(mounts.filter(\.readOnly).map(\.driveId))
            if drives.allSatisfy({ readOnly.contains($0.driveId) }) { return false }
        }
        return true
    }
}
