import Foundation
import OrbitKit

/// The one sentence at the top of the menu-bar panel and the one thing it offers to do about it.
/// Built from plain values so every state can be tested without an engine.
struct MenuHeadline: Equatable {
    enum Tone: Equatable { case good, busy, attention, neutral }

    enum Action: Equatable {
        case continueSetup, signIn, restoreSignIn, openBrowserAgain
        case allowBackground, approveBackground, tryAgain
        case managePlan(workspaceID: String)
        case retryDrive(driveID: String)
        case showActivity
        case openInFinder(driveID: String)
        case newDrive

        var title: String {
            switch self {
            case .continueSetup: "Continue Setup"
            case .signIn: "Sign In…"
            case .restoreSignIn, .tryAgain, .retryDrive: "Try Again"
            case .openBrowserAgain: "Open Browser Again"
            case .allowBackground: "Allow"
            case .approveBackground: "Approve…"
            case .managePlan: "Manage Plan on the Web"
            case .showActivity: "Show Activity"
            case .openInFinder: "Open in Finder"
            case .newDrive: "New Drive…"
            }
        }
    }

    var title: String
    var detail: String?
    var tone: Tone
    var action: Action?

    var symbol: String {
        switch tone {
        case .good: "checkmark.circle.fill"
        case .busy: "arrow.triangle.2.circlepath"
        case .attention: "exclamationmark.triangle.fill"
        case .neutral: "circle.dashed"
        }
    }

    struct Input {
        var setupCompleted = true
        var hasCredentials = false
        var signingIn = false
        var sessionPending = false
        var canRestoreSignIn = false
        var connected = false
        var install = EngineInstallState.enabled
        var status = AppStatus.idle
        var drives: [DriveInfo] = []
        var access: [MeAccess.Workspace]?
        var workspaces: [WorkspaceInfo] = []
        /// Files uploading, downloading, or waiting. The engine's per-drive total (`/`) is not a file.
        var filesInFlight = 0
        var changesInFlight = false
        var transferredBytes: (done: Int64, total: Int64)?
        /// Nil when the engine does not report its upload queue, so "up to date" cannot be claimed.
        var uploadQueueKnown = true
        var failedUpload: String?
        var error: String?
        var now = Date()
    }

    /// The fraction of a workspace's storage that counts as almost full.
    static let almostFull = 0.9

    static func make(_ input: Input) -> MenuHeadline {
        if input.signingIn {
            return MenuHeadline(title: "Finish in your browser", detail: "Waiting for your browser…",
                                tone: .busy, action: .openBrowserAgain)
        }
        if !input.setupCompleted {
            return MenuHeadline(title: "Setup not finished", detail: "Finish setting up Orbit to get your drive in Finder.",
                                tone: .attention, action: .continueSetup)
        }
        guard input.hasCredentials else {
            if input.canRestoreSignIn {
                return MenuHeadline(title: "Sign-in needs attention", detail: "Orbit couldn't read your saved sign-in.",
                                    tone: .attention, action: .restoreSignIn)
            }
            return MenuHeadline(title: "You're signed out", detail: "Sign in to see your drives in Finder.",
                                tone: .neutral, action: .signIn)
        }
        guard input.connected else { return disconnected(input.install) }
        if input.sessionPending {
            return MenuHeadline(title: "Setting up your drive", detail: "Finishing sign-in…", tone: .busy, action: nil)
        }
        if let plan = planHeadline(input) { return plan }
        if let drive = input.drives.first(where: { $0.mountState == .error }) {
            return MenuHeadline(title: "A drive needs attention", detail: "“\(drive.name)” couldn't connect to Finder.",
                                tone: .attention, action: .retryDrive(driveID: drive.driveId))
        }
        if let file = input.failedUpload {
            return MenuHeadline(title: "An upload didn't finish",
                                detail: "“\(file)” is still on this Mac. Orbit tries again when the file changes.",
                                tone: .attention, action: .showActivity)
        }
        switch input.status {
        case .offline:
            return MenuHeadline(title: "You're offline", detail: "Changes stay on this Mac and upload when you reconnect.",
                                tone: .neutral, action: nil)
        case .error:
            return MenuHeadline(title: "Orbit can't sync right now", detail: input.error ?? "Check your connection, then try again.",
                                tone: .attention, action: .tryAgain)
        default: break
        }
        if input.filesInFlight > 0 || input.changesInFlight || input.status == .syncing {
            let title = input.filesInFlight > 0
                ? "Syncing \(Format.count(input.filesInFlight, "file", "files"))" : "Syncing changes"
            var detail: String?
            if let bytes = input.transferredBytes, bytes.total > 0 {
                detail = "\(Format.bytes(bytes.done)) of \(Format.bytes(bytes.total))"
            }
            return MenuHeadline(title: title, detail: detail, tone: .busy, action: .showActivity)
        }
        guard let first = input.drives.first(where: { $0.mountState == .mounted }) ?? input.drives.first else {
            return MenuHeadline(title: "No drives yet", detail: "Create a drive and it appears in Finder like any other disk.",
                                tone: .neutral, action: .newDrive)
        }
        let inFinder = input.drives.filter { $0.mountState == .mounted }.count
        return MenuHeadline(title: input.uploadQueueKnown ? "All files are up to date" : "Your drives are connected",
                            detail: inFinder == 0 ? "No drive is in Finder right now."
                                : "\(Format.count(inFinder, "drive", "drives")) in Finder",
                            tone: .good, action: .openInFinder(driveID: first.driveId))
    }

    private static func disconnected(_ install: EngineInstallState) -> MenuHeadline {
        switch install {
        case .notInstalled:
            MenuHeadline(title: "Drives are unavailable", detail: "This copy of Orbit can't connect drives. Install the full app.",
                         tone: .attention, action: nil)
        case .requiresApproval:
            MenuHeadline(title: "Orbit needs your approval", detail: "Allow Orbit in Login Items so your drives stay in Finder.",
                         tone: .attention, action: .approveBackground)
        case .notRegistered:
            MenuHeadline(title: "Drives are disconnected", detail: "Let Orbit run in the background to bring your drives back to Finder.",
                         tone: .attention, action: .allowBackground)
        case .failed(let message):
            MenuHeadline(title: "Drives are disconnected", detail: message, tone: .attention, action: .allowBackground)
        case .enabled:
            MenuHeadline(title: "Drives are disconnected", detail: "Orbit is reconnecting. Your files are safe.",
                         tone: .attention, action: .tryAgain)
        }
    }

    /// Plan and storage problems. Each one says the files are safe before it says what to do.
    private static func planHeadline(_ input: Input) -> MenuHeadline? {
        if let access = input.access {
            // The server also reports a workspace over its quota as not writable. That is a storage
            // problem with an active plan, so it must not be read as the plan being inactive.
            if let paused = access.first(where: { $0.state == "expired" || ($0.storageReady && $0.writable == false && !$0.isFull) }) {
                return MenuHeadline(title: "Changes are paused — plan inactive",
                                    detail: "Your files are safe. Choose a plan for \(paused.name) to keep saving changes.",
                                    tone: .attention, action: .managePlan(workspaceID: paused.id))
            }
            if access.contains(where: { !$0.storageReady }) && input.drives.isEmpty {
                return MenuHeadline(title: "Setting up your drive", detail: "Storage is being prepared.", tone: .busy, action: nil)
            }
            // A full workspace comes before one that is merely close.
            let fullest = access.filter { ($0.storageFraction ?? 0) >= almostFull }
                .max { ($0.storageFraction ?? 0) < ($1.storageFraction ?? 0) }
            if let workspace = fullest, let used = workspace.usedBytes, let quota = workspace.quotaBytes {
                let usage = "\(Format.bytes(used)) of \(Format.bytes(quota)) used in \(workspace.name)."
                return MenuHeadline(title: workspace.isFull ? "Storage is full" : "Storage almost full",
                                    detail: workspace.writable == false
                                        ? "Your files are safe. \(usage) New changes are paused until you free up space or add storage."
                                        : "Your files are safe. \(usage)",
                                    tone: .attention, action: .managePlan(workspaceID: workspace.id))
            }
            return nil
        }
        if let ended = input.workspaces.first(where: { ($0.trialEndDate ?? .distantFuture) <= input.now }) {
            return MenuHeadline(title: "Changes are paused — plan inactive",
                                detail: "Your files are safe. Choose a plan for \(ended.name) to keep saving changes.",
                                tone: .attention, action: .managePlan(workspaceID: ended.id))
        }
        return nil
    }
}

extension MeAccess.Workspace {
    /// Used storage as a fraction of the quota, or nil when the server reports no quota.
    var storageFraction: Double? {
        guard let quota = quotaBytes, quota > 0, let used = usedBytes else { return nil }
        return Double(used) / Double(quota)
    }

    /// At or over the quota. The server stops accepting changes once usage goes over it.
    var isFull: Bool { (storageFraction ?? 0) >= 1 }
}

extension AppModel {
    var headline: MenuHeadline {
        var input = MenuHeadline.Input()
        input.setupCompleted = setupCompleted
        input.hasCredentials = session.hasCredentials
        input.signingIn = session.signingIn
        input.sessionPending = session.sessionPending
        input.canRestoreSignIn = session.canRetrySavedSignIn
        input.connected = engine.isConnected
        input.install = engine.install
        input.status = status
        input.drives = drives.drives
        input.access = workspaces.access
        input.workspaces = workspaces.workspaces
        let active = activity.items.filter(\.isActive)
        input.filesInFlight = active.filter { $0.path != "/" }.count
        input.changesInFlight = !active.isEmpty
        let live = activity.transfers.filter { !$0.isFinished }
        if !live.isEmpty {
            input.transferredBytes = (live.reduce(0) { $0 + $1.bytesDone }, live.reduce(0) { $0 + $1.bytesTotal })
        }
        input.uploadQueueKnown = activity.uploads != nil
        if let failed = activity.transfers.first(where: { $0.direction == .upload && $0.status == .failed })
            ?? activity.recentUploads.first(where: { $0.status == .failed }) {
            input.failedUpload = TransferSummary.fileTitle(path: failed.path)
        }
        input.error = messages.error
        return MenuHeadline.make(input)
    }
}
