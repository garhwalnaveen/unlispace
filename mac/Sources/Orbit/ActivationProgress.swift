import Foundation

/// Historical first-use milestones, never a substitute for the engine's current sync state.
struct ActivationProgress: Codable, Equatable {
    var finderOpened = false
    var fileAdded = false
    var cloudSaveConfirmed = false
    var dismissed = false

    static func load(accountID: String?, defaults: UserDefaults) -> Self {
        guard let accountID, accountID != "pending",
              let data = defaults.data(forKey: key(accountID)),
              let progress = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return progress
    }

    func save(accountID: String?, defaults: UserDefaults) {
        guard let accountID, accountID != "pending", let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(accountID))
    }

    private static func key(_ accountID: String) -> String { "first-file-progress.\(accountID)" }
}
