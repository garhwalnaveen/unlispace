import Observation
import OrbitKit

/// Status text shared by every window: the latest error, notices, and what the engine last reported.
@MainActor @Observable
final class AppMessages {
    var error: String? { didSet { errorCameFromRefresh = false } }
    var notice: String?
    var conflict: ConflictEvent?
    /// The engine's own explanation of its state, when it sends one.
    var engineMessage: String?
    var lastChange: String?
    var fileCopy: String?

    @ObservationIgnored private var errorCameFromRefresh = false

    func report(_ message: String) { error = message }

    /// A successful refresh clears only the error an earlier refresh raised, never one from a user action.
    func setRefreshError(_ message: String?) {
        if let message {
            error = message
            errorCameFromRefresh = true
        } else if errorCameFromRefresh {
            error = nil
        }
    }

    func clearForSignOut() {
        conflict = nil
        notice = nil
        lastChange = nil
        fileCopy = nil
    }
}
