import AppKit
import SwiftUI

/// UserDefaults keys for app preferences. Secrets never go here; they live in the Keychain.
enum Preference {
    static let appearance = "appearance"
    static let setupCompleted = "onboardingCompleted"
    static let settingsPage = "settingsPage"
    static let workspaceShortcut = "workspaceShortcut"
}

enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: Self { self }
    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
    var nsAppearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }

    static func stored(in defaults: UserDefaults = .standard) -> Self {
        Self(rawValue: defaults.string(forKey: Preference.appearance) ?? "") ?? .system
    }

    /// One app-wide setting covers every window, alert, and panel.
    @MainActor func apply() { NSApp.appearance = nsAppearance }
}

enum SettingsPage: String, CaseIterable, Identifiable {
    case general = "General", account = "Account", storage = "Storage", permissions = "Permissions", advanced = "Advanced"

    var id: Self { self }
    /// The raw value is what is saved, so it stays as it was; this is what the tab says.
    var title: String { self == .storage ? "Drives & Storage" : rawValue }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .account: "person.crop.circle"
        case .storage: "internaldrive"
        case .permissions: "hand.raised"
        case .advanced: "wrench.and.screwdriver"
        }
    }
}
