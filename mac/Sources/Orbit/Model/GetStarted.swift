import Foundation
import OrbitKit

/// One task on the "Get started" list. A step the user skipped during setup stays open here.
struct GetStartedStep: Identifiable, Equatable {
    enum ID: String, CaseIterable { case signIn, background, finder, firstFile, alerts }

    var id: ID
    var title: String
    var detail: String
    var done: Bool
    var optional = false
    /// The button shown on the first open step; nil when the step finishes on its own.
    var action: String?
}

enum GetStarted {
    struct Input {
        var signedIn = false
        var backgroundRunning = false
        /// The button for the background step: "Allow", "Approve…", or nil when pressing it would not help.
        var backgroundAction: String? = "Allow"
        var hasDrive = false
        var progress = ActivationProgress()
        var notifications = AccessStatus.unavailable
    }

    static func steps(_ input: Input) -> [GetStartedStep] {
        let progress = input.progress
        var steps = [
            GetStartedStep(id: .signIn, title: "Sign in", detail: "Connects this Mac to your Orbit account.",
                           done: input.signedIn, action: "Sign In…"),
            GetStartedStep(id: .background, title: "Let Orbit run in the background",
                           detail: "Keeps your drive in Finder and uploads your changes.",
                           done: input.backgroundRunning, action: input.backgroundAction),
            GetStartedStep(id: .finder, title: "Open your drive in Finder",
                           detail: "It sits in Finder's sidebar like any other disk.",
                           done: progress.finderOpened, action: input.hasDrive ? "Open in Finder" : nil),
            GetStartedStep(id: .firstFile, title: "Add your first file",
                           detail: progress.fileAdded && !progress.cloudSaveConfirmed
                               ? "Uploading… this step finishes when the file is saved to Orbit."
                               : "Drag a file into the drive. Orbit uploads it and keeps its history.",
                           done: progress.fileAdded && progress.cloudSaveConfirmed,
                           action: input.hasDrive && !progress.fileAdded ? "Add a File…" : nil),
        ]
        // An unbundled build cannot ask for notifications, so the step would never close.
        if input.notifications != .unavailable && input.notifications != .checking {
            steps.append(GetStartedStep(id: .alerts, title: "Turn on conflict alerts",
                                        detail: "Tells you when two versions of a file were kept.",
                                        done: input.notifications == .enabled || input.notifications == .quiet,
                                        optional: true,
                                        action: input.notifications == .notRequested ? "Allow" : "Open Settings…"))
        }
        return steps
    }

    /// "Get started · 2 of 5 done"
    static func summary(_ steps: [GetStartedStep]) -> String {
        "Get started · \(steps.filter(\.done).count) of \(steps.count) done"
    }

    /// The list stays until every step is done or the user hides it.
    static func isVisible(_ steps: [GetStartedStep], dismissed: Bool) -> Bool {
        !dismissed && steps.contains { !$0.done }
    }

    /// The step the list offers a button for: the first one still open.
    static func next(_ steps: [GetStartedStep]) -> GetStartedStep? { steps.first { !$0.done } }

    /// True when the headline above the list already offers this step's button, so it is not shown twice.
    static func isCovered(_ step: GetStartedStep.ID, by action: MenuHeadline.Action?) -> Bool {
        switch (step, action) {
        case (.signIn, .signIn), (.signIn, .continueSetup), (.signIn, .openBrowserAgain), (.signIn, .restoreSignIn),
             (.background, .allowBackground), (.background, .approveBackground), (.finder, .openInFinder):
            true
        default:
            false
        }
    }
}

extension AppModel {
    var getStartedSteps: [GetStartedStep] {
        GetStarted.steps(.init(signedIn: session.isSignedIn,
                               backgroundRunning: engine.isConnected,
                               backgroundAction: backgroundAction,
                               hasDrive: isAccountLive && !drives.drives.isEmpty,
                               progress: activation.progress,
                               notifications: permissions.notificationAccess))
    }

    private var backgroundAction: String? {
        switch engine.install {
        case .requiresApproval: "Approve…"
        case .notRegistered, .failed: "Allow"
        // Nothing to allow: the app has no background service, or it is allowed and still starting.
        case .notInstalled, .enabled: nil
        }
    }

    var showsGetStarted: Bool {
        // A developer token has no account to guide.
        if session.hasDevToken && !session.isSignedIn { return false }
        // Progress belongs to an account. Someone who finished setup and signed out is not starting over.
        if !session.isSignedIn && setupCompleted { return false }
        if isAccountLive, !GetStarted.canAddFile(access: workspaces.access, drives: drives.drives, mounts: drives.mounts) { return false }
        return GetStarted.isVisible(getStartedSteps, dismissed: activation.progress.dismissed)
    }

    /// Runs the step's button. Steps without one finish through normal use.
    func perform(_ step: GetStartedStep.ID, showSetup: () -> Void) {
        switch step {
        case .signIn: if setupCompleted { session.signIn() } else { showSetup() }
        case .background: act(on: .background)
        case .finder:
            if let drive = drives.drives.first(where: { $0.mountState == .mounted }) ?? drives.drives.first { drives.open(drive) }
        case .firstFile:
            guard let drive = drives.drives.first(where: { $0.mountState == .mounted }) ?? drives.drives.first else { return }
            if drives.canAddFile(to: drive) { drives.addFile(to: drive) } else { drives.open(drive) }
        case .alerts: act(on: .notifications)
        }
    }
}
