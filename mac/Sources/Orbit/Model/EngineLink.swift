import Foundation
import Observation
import OrbitKit

/// What the rest of the app does with a connection. `AppModel` is the only conformer.
@MainActor protocol EngineLinkDelegate: AnyObject {
    /// Runs at the start of every refresh, connected or not. The place to read state kept on this Mac.
    func engineWillRefresh()
    /// A new connection was made; hand over anything that was waiting for the engine.
    func engineDidConnect(_ client: any DaemonClient) async
    /// Read the engine's current state. Throwing a transport error drops the connection.
    func engineRefresh(_ client: any DaemonClient) async throws
    /// The engine answered a refresh with an error. The connection stays up.
    func engineRefreshFailed(_ error: Error)
    /// Called whenever a refresh ends without a connection, or the connection is lost.
    func engineIsUnavailable(error: Error?)
    func engineReceived(_ events: [DaemonEvent])
    /// True while transfers or mounts are in flight, which keeps polling frequent.
    var engineIsBusy: Bool { get }
}

/// The single connection to the background engine: connect, reconnect, poll, and deliver events.
/// There is no stand-in engine. When the socket is unreachable, `client` is nil and the UI says so.
@MainActor @Observable
final class EngineLink {
    private(set) var isConnected = false
    var install: EngineInstallState = .notInstalled

    @ObservationIgnored weak var delegate: (any EngineLinkDelegate)?
    @ObservationIgnored private(set) var client: (any DaemonClient)?
    @ObservationIgnored private let makeClient: @Sendable () -> any DaemonClient
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var failures = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshQueued = false
    @ObservationIgnored private var eventBuffer: [DaemonEvent] = []
    @ObservationIgnored private var flushTask: Task<Void, Never>?

    /// Events arriving within this window reach the UI as one update.
    static let eventBatchWindow: Duration = .milliseconds(50)

    init(makeClient: @escaping @Sendable () -> any DaemonClient = { UnixSocketDaemonClient() }) {
        self.makeClient = makeClient
    }

    /// The connected client, or `notConnected`.
    func connectedClient() throws -> any DaemonClient {
        guard let client else { throw DaemonClientError.notConnected }
        return client
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                let delay = PollSchedule.delay(connected: self.isConnected,
                                               busy: self.delegate?.engineIsBusy ?? false,
                                               failures: self.failures)
                try? await Task.sleep(for: delay)
            }
        }
    }

    /// Reconciles with the engine now. Concurrent callers share one pass; a request made while a pass
    /// is running schedules exactly one more, so the caller always sees state newer than its request.
    func refresh() async {
        guard !Task.isCancelled else { return }
        if let running = refreshTask {
            refreshQueued = true
            await running.value
            return
        }
        let task = Task { [weak self] in
            repeat {
                self?.refreshQueued = false
                await self?.refreshOnce()
            } while self?.refreshQueued == true
            self?.refreshTask = nil
        }
        refreshTask = task
        await task.value
    }

    private func refreshOnce() async {
        install = DaemonLifecycle.state()
        delegate?.engineWillRefresh()
        if client == nil {
            let candidate = makeClient()
            do {
                try await candidate.connect()
                adopt(candidate)
                await delegate?.engineDidConnect(candidate)
            } catch {
                failures += 1
                delegate?.engineIsUnavailable(error: nil)
                return
            }
        }
        guard let client else { return }
        do {
            try await delegate?.engineRefresh(client)
        } catch let error as DaemonClientError where error.isRemote {
            delegate?.engineRefreshFailed(error)
        } catch {
            await drop()
            delegate?.engineIsUnavailable(error: error)
        }
    }

    /// Uses an already-open client. The app connects through `refresh()`; tests attach a double.
    func adopt(_ newClient: any DaemonClient) {
        generation += 1
        client = newClient
        isConnected = true
        failures = 0
        let expected = generation
        let stream = newClient.events()
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await event in stream { self?.enqueue(event) }
            // The stream ends when the socket closes: report it now instead of at the next poll.
            guard !Task.isCancelled, let self, self.generation == expected else { return }
            await self.drop()
            self.delegate?.engineIsUnavailable(error: DaemonClientError.disconnected)
        }
    }

    private func drop() async {
        guard let old = client else { return }
        generation += 1
        client = nil
        isConnected = false
        failures = 1
        eventTask?.cancel()
        eventTask = nil
        flushEvents()
        await old.disconnect()
    }

    private func enqueue(_ event: DaemonEvent) {
        eventBuffer.append(event)
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: Self.eventBatchWindow)
            self?.flushEvents()
        }
    }

    private func flushEvents() {
        flushTask = nil
        guard !eventBuffer.isEmpty else { return }
        let events = eventBuffer
        eventBuffer = []
        delegate?.engineReceived(events)
    }

    /// Registers the launch agent. macOS may ask for approval in Login Items.
    func enable() {
        install = DaemonLifecycle.register()
        if install == .requiresApproval { DaemonLifecycle.openLoginItemsSettings() }
        failures = 0
        Task { await refresh() }
    }
}

extension DaemonClientError {
    /// The engine replied with an error, as opposed to the socket failing.
    var isRemote: Bool {
        if case .remote = self { return true }
        return false
    }
}
