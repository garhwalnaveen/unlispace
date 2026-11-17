import Foundation
import OrbitKit

/// The pages of first-run setup, in order.
enum SetupStep: Int, CaseIterable {
    case welcome, benefits, signIn, permissions, done

    var title: String {
        switch self {
        case .welcome: "Welcome"
        case .benefits: "What you get"
        case .signIn: "Sign in"
        case .permissions: "Permissions"
        case .done: "Done"
        }
    }
    var next: Self { Self(rawValue: rawValue + 1) ?? self }
    var previous: Self { Self(rawValue: rawValue - 1) ?? self }
}

/// What the sign-in page is waiting for.
enum SignInPhase: Equatable {
    case signedOut
    /// The browser has the sign-in page; Orbit waits for it to come back.
    case waitingForBrowser
    /// Signed in, and the drive is being prepared.
    case settingUp
    case signedIn

    var title: String {
        switch self {
        case .signedOut: "Sign in to Orbit"
        case .waitingForBrowser: "Finish in your browser"
        case .settingUp: "Setting up your drive"
        case .signedIn: "You're signed in"
        }
    }

    /// `prepared` is true once setup has loaded the account's drives and put the first one in Finder.
    static func current(signingIn: Bool, signedIn: Bool, connected: Bool, prepared: Bool) -> Self {
        if signingIn { return .waitingForBrowser }
        guard signedIn else { return .signedOut }
        // Without the background service there is nothing to wait for yet: the next page asks for it.
        return connected && !prepared ? .settingUp : .signedIn
    }
}

/// What the last page of setup can promise about the drive.
enum SetupDrive: Equatable {
    /// Orbit is not allowed to run in the background yet, so no drive can appear.
    case needsBackground
    case settingUp
    case noDrives
    case failed(String)
    case ready(DriveInfo)

    static func current(connected: Bool, prepared: Bool, drives: [DriveInfo], error: String?) -> Self {
        guard connected else { return .needsBackground }
        if let drive = firstInFinder(drives) { return .ready(drive) }
        if !prepared || drives.contains(where: { $0.mountState == .mounting }) { return .settingUp }
        if let error { return .failed(error) }
        if drives.isEmpty { return .noDrives }
        return .failed("The drive has not appeared in Finder yet.")
    }

    /// A drive counts as in Finder only with both a confirmed mount and a path to open.
    static func firstInFinder(_ drives: [DriveInfo]) -> DriveInfo? {
        drives.first { $0.mountState == .mounted && $0.mountPath != nil }
    }

    /// The drive setup puts in Finder: none if one is already there, otherwise the account's first.
    static func driveToMount(_ drives: [DriveInfo]) -> DriveInfo? {
        firstInFinder(drives) == nil ? drives.first : nil
    }
}
