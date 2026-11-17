import SwiftUI
import OrbitKit

/// Plan problems that stop uploads, one line per affected workspace.
struct PlanNotices: View {
    var directory: WorkspaceDirectory

    var body: some View {
        let notices = Self.notices(access: directory.access, workspaces: directory.workspaces)
        VStack(spacing: 0) {
            ForEach(notices) { notice in
                InlineMessage(kind: .warning, text: notice.text) {
                    if let url = directory.config?.page(orgId: notice.id, section: "billing") {
                        Link("Billing", destination: url)
                    }
                }
            }
            if !notices.isEmpty { Divider() }
        }
        .task(id: directory.isAvailable) { await directory.load() }
    }

    struct Notice: Identifiable, Equatable {
        var id: String
        var text: String
    }

    /// Uses `/me/access` when the server has it and falls back to trial dates from the workspace list.
    static func notices(access: [MeAccess.Workspace]?, workspaces: [WorkspaceInfo], now: Date = Date()) -> [Notice] {
        if let access {
            return access.compactMap { workspace in
                if workspace.state == "expired" {
                    return Notice(id: workspace.id, text: "\(workspace.name): the trial has ended. Choose a plan to keep uploading.")
                }
                if !workspace.storageReady { return Notice(id: workspace.id, text: "\(workspace.name): storage is being set up.") }
                if workspace.writable == false {
                    return Notice(id: workspace.id, text: "\(workspace.name): uploads are turned off. Check the plan.")
                }
                return nil
            }
        }
        return workspaces.compactMap { workspace in
            if workspace.trialPending == true {
                return Notice(id: workspace.id, text: "\(workspace.name): storage is being set up.")
            }
            if let end = workspace.trialEndDate, end <= now {
                return Notice(id: workspace.id, text: "\(workspace.name): the trial end date has passed. Check the plan.")
            }
            return nil
        }
    }
}

/// A three-step checklist shown until the account's first file has uploaded, or the user dismisses it.
struct FirstFileChecklist: View {
    var model: AppModel

    var body: some View {
        let progress = model.activation.progress
        if model.isAccountLive, progress.showsChecklist,
           Self.canAddFile(access: model.workspaces.access, drives: model.drives.drives, mounts: model.drives.mounts) {
            Section {
                step("Open a drive in Finder", done: progress.finderOpened)
                step("Add a file to it", done: progress.fileAdded)
                step("Wait for the upload to finish", done: progress.cloudSaveConfirmed)
            } header: {
                HStack {
                    Text("Add your first file")
                    Spacer()
                    Button("Dismiss") { model.activation.record { $0.dismissed = true } }
                        .buttonStyle(.link).font(.caption)
                }
            }
        }
    }

    /// False when every workspace is known to reject uploads or every drive is mounted read-only.
    static func canAddFile(access: [MeAccess.Workspace]?, drives: [DriveInfo], mounts: [DaemonMount]?) -> Bool {
        if let access, !access.isEmpty, access.allSatisfy({ $0.state == "expired" || $0.writable == false }) { return false }
        if !drives.isEmpty, let mounts {
            let readOnly = Set(mounts.filter(\.readOnly).map(\.driveId))
            if drives.allSatisfy({ readOnly.contains($0.driveId) }) { return false }
        }
        return true
    }

    private func step(_ title: String, done: Bool) -> some View {
        Label(title, systemImage: done ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(done ? .primary : .secondary)
            .accessibilityLabel("\(title): \(done ? "done" : "not done")")
    }
}
