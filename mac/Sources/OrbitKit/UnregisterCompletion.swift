import Foundation

// Shared with the standalone installer probe so both wait for macOS to reap the service.
final class UnregisterCompletion: @unchecked Sendable {
    private let condition = NSCondition()
    private var finished = false
    private var error: Error?

    func finish(_ error: Error?) {
        condition.lock()
        self.error = error
        finished = true
        condition.signal()
        condition.unlock()
    }

    func wait(timeout: TimeInterval) throws {
        let deadline = Date(timeIntervalSinceNow: timeout)
        condition.lock()
        defer { condition.unlock() }
        while !finished {
            guard condition.wait(until: deadline) || finished else {
                throw NSError(domain: "OrbitEngine", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "macOS has not finished stopping the engine. Wait a moment, then retry."])
            }
        }
        if let error { throw error }
    }
}
