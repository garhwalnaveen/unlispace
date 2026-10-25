import SwiftUI
import Observation
import UnlispaceKit

@MainActor
@Observable
final class AppModel {
    var status: AppStatus = .signedOut
    var drives: [DriveInfo] = []
    var transfers: [TransferInfo] = []
    var usingMock = false
    var engineInstall: EngineInstallState = .notInstalled
    var lastError: String?
    var hasCredentials = false

    private var client: any DaemonClient
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private let keychain = Keychain()

    init() {
        client = MockDaemonClient()
        usingMock = true
    }

    var symbolName: String { status.symbolName }
    var transferLine: String? { TransferSummary.line(for: transfers) }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    /// Picks the real client if the socket is reachable, else the mock.
    func refresh() async {
        engineInstall = DaemonLifecycle.state()
        hasCredentials = ((try? keychain.get(account: Keychain.Account.devToken)) ?? nil) != nil

        if usingMock {
            let real = UnixSocketDaemonClient()
            if (try? await real.connect()) != nil {
                await client.disconnect()
                client = real
                usingMock = false
                subscribe()
            }
        }
        do {
            let st = try await client.status()
            status = hasCredentials || !usingMock ? AppStatus(engine: st.state) : .signedOut
            drives = try await client.listDrives()
            transfers = try await client.transfers()
            lastError = nil
        } catch {
            if !usingMock {
                // Daemon went away: fall back to mock and say so.
                client = MockDaemonClient()
                usingMock = true
            }
            status = .error
            lastError = "\(error)"
            Log.app.error("refresh failed: \(String(describing: error))")
        }
        if engineInstall == .notInstalled && usingMock { status = hasCredentials ? .engineMissing : .signedOut }
    }

    private func subscribe() {
        eventTask?.cancel()
        let stream = client.events()
        eventTask = Task { [weak self] in
            for await ev in stream {
                guard let self else { return }
                switch ev {
                case .state(let s): self.status = AppStatus(engine: s.state)
                case .transfer(let t):
                    self.transfers.removeAll { $0.id == t.id }
                    if !t.isFinished { self.transfers.append(t) }
                case .change, .unknown: break
                }
            }
        }
    }

    func mount(_ d: DriveInfo) { run { try await $0.mount(driveId: d.driveId) } }
    func unmount(_ d: DriveInfo) { run { try await $0.unmount(driveId: d.driveId) } }

    private func run(_ op: @escaping @Sendable (any DaemonClient) async throws -> Void) {
        let c = client
        Task {
            do { try await op(c); await refresh() }
            catch { lastError = "\(error)"; Log.app.error("daemon op failed: \(String(describing: error))") }
        }
    }

    func openInFinder(_ d: DriveInfo) {
        guard let p = d.mountPath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: p))
    }

    func installEngine() {
        engineInstall = DaemonLifecycle.register()
        if engineInstall == .requiresApproval { DaemonLifecycle.openLoginItemsSettings() }
    }

    /// Pushes endpoint + token to the daemon (token never logged).
    func pushConfig() {
        let token = (try? keychain.get(account: Keychain.Account.devToken)) ?? nil
        let cfg = DaemonConfig(endpoint: AppSettings.endpoint, token: token, cacheCapBytes: AppSettings.cacheCapBytes)
        let c = client
        Task { try? await c.setConfig(cfg); await refresh() }
    }
}
