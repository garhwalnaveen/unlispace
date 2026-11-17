import Foundation
import Observation

/// First-use milestones, stored per account. They record history and say nothing about current sync state.
struct ActivationProgress: Codable, Equatable {
    var finderOpened = false
    var fileAdded = false
    var cloudSaveConfirmed = false
    var dismissed = false

    var complete: Bool { finderOpened && fileAdded && cloudSaveConfirmed }
    var showsChecklist: Bool { !dismissed && !complete }

    static func load(accountID: String?, defaults: UserDefaults) -> Self {
        guard let accountID, accountID != SessionStore.pendingAccountID,
              let data = defaults.data(forKey: key(accountID)),
              let progress = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return progress
    }

    func save(accountID: String?, defaults: UserDefaults) {
        guard let accountID, accountID != SessionStore.pendingAccountID,
              let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(accountID))
    }

    private static func key(_ accountID: String) -> String { "first-file-progress.\(accountID)" }
}

@MainActor @Observable
final class ActivationStore {
    private(set) var progress = ActivationProgress()
    @ObservationIgnored private var accountID: String?
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults) { self.defaults = defaults }

    func load(accountID: String?) {
        self.accountID = accountID
        progress = .load(accountID: accountID, defaults: defaults)
    }

    func record(_ change: (inout ActivationProgress) -> Void) {
        var updated = progress
        change(&updated)
        guard updated != progress else { return }
        progress = updated
        progress.save(accountID: accountID, defaults: defaults)
    }
}
