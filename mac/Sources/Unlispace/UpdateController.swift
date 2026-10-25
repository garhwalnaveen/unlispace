import Foundation
import Sparkle
import UnlispaceKit

@MainActor
final class UpdateController: NSObject, @preconcurrency SPUUpdaterDelegate {
    let isEnabled: Bool
    private var controller: SPUStandardUpdaterController?
    private let makeClient: () -> any DaemonClient
    private var retryTask: Task<Void, Never>?

    init(info: [String: Any] = Bundle.main.infoDictionary ?? [:],
         makeClient: @escaping () -> any DaemonClient = { UnixSocketDaemonClient() }) {
        self.makeClient = makeClient
        isEnabled = (info["SUFeedURL"] as? String)?.isEmpty == false &&
            (info["SUPublicEDKey"] as? String)?.isEmpty == false
        super.init()
    }

    func start() {
        guard isEnabled, controller == nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                             untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        // Always defer first: check fresh daemon state, never a cached UI snapshot.
        retryTask?.cancel()
        retryTask = Task { @MainActor in
            while !Task.isCancelled {
                if await self.prepareForInstallation(), !Task.isCancelled {
                    installHandler()
                    return
                }
                try? await Task.sleep(for: .seconds(30))
            }
        }
        return true
    }

    private func mountedDriveIDs(_ client: any DaemonClient, status: DaemonStatus) async throws -> [String] {
        if let mounts = try await client.listMounts() { return mounts.map(\.driveId) }
        // Older engines unmount on sign-out; drives.list would require a network session.
        if status.state == .signedOut { return [] }
        let drives = try await client.listDrives()
        guard drives.allSatisfy({ $0.mountState == .mounted || $0.mountState == .unmounted }) else {
            throw DaemonClientError.remote(DaemonError(code: "busy", message: "Mount transition in progress"))
        }
        return drives.filter { $0.mountState == .mounted }.map(\.driveId)
    }

    func prepareForInstallation() async -> Bool {
        let client = makeClient()
        do {
            try await client.connect()
            let status = try await client.status()
            let uploads = try await client.uploads()
            guard UpdateSafety.canInstall(status: status, uploads: uploads) else {
                await client.disconnect()
                return false
            }
            // Product §5.4: unmount cleanly before replacing the app/embedded daemon.
            let mounted = try await mountedDriveIDs(client, status: status)
            for driveID in mounted {
                try await client.unmount(driveId: driveID)
            }
            let finalStatus = try await client.status()
            let finalUploads = try await client.uploads()
            let finalMounted = try await mountedDriveIDs(client, status: finalStatus)
            await client.disconnect()
            return UpdateSafety.canInstall(status: finalStatus, uploads: finalUploads) &&
                finalMounted.isEmpty
        } catch {
            await client.disconnect()
            return false
        }
    }
}
