import Foundation

import Testing
import UnlispaceKit
@testable import Unlispace

@Suite @MainActor struct AppModelTests {
    @Test func transferEventsReplaceProgressAndRemoveFinishedTransfers() {
        let model = AppModel()
        var transfer = TransferInfo(id: "one", driveId: "drive", path: "/notes.txt", direction: .upload,
                                    bytesDone: 0, bytesTotal: 100, status: .queued)
        model.apply(.transfer(transfer))
        #expect(model.transfers == [transfer])
        transfer.bytesDone = 50
        transfer.status = .active
        model.apply(.transfer(transfer))
        #expect(model.transfers.count == 1)
        #expect(model.transfers.first?.progress == 0.5)
        transfer.status = .done
        model.apply(.transfer(transfer))
        #expect(model.transfers.isEmpty)
        transfer.status = .failed
        model.apply(.transfer(transfer))
        #expect(model.transfers.isEmpty)
        #expect(model.lastError == "Transfer failed: /notes.txt")
    }

    @Test func onboardingCannotMountMockDrives() async {
        let model = AppModel()
        await #expect(throws: DaemonClientError.notConnected) { try await model.mountSelectedDrives(["demo"]) }
    }

    @Test func signOutEventClearsVisibleTransfers() {
        let model = AppModel()
        model.account = AuthUser(id: "one", email: "local@example.invalid")
        model.drives = [DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)]
        model.apply(.state(StateEvent(state: .signedOut)))
        #expect(!model.isSignedIn)
        #expect(model.drives.isEmpty)
        #expect(model.transfers.isEmpty)
    }
}

@Suite @MainActor struct DistributionModelTests {
    @Test func pinEventsUpdateOnlyAnAvailableFeatureAndSignOutClearsIt() {
        let model = AppModel()
        let pin = OfflinePin(driveId: "d", path: "/", bytes: 100, cachedBytes: 20)
        model.apply(.pin(pin))
        #expect(model.pins == nil)
        model.pins = []
        model.apply(.pin(pin))
        var updated = pin
        updated.cachedBytes = 80
        model.apply(.pin(updated))
        #expect(model.pins == [updated])
        model.apply(.state(StateEvent(state: .signedOut)))
        #expect(model.pins == nil)
        #expect(model.uploads == nil)
        #expect(model.mounts == nil)
    }

    @Test func refreshUsesM3Mountpoints() async throws {
        let model = AppModel()
        let mock = MockDaemonClient()
        model.drives = try await mock.listDrives()
        try await mock.mount(driveId: "demo")
        try await model.refreshDistribution(using: mock)
        #expect(model.drives.first?.mountPath == "/Volumes/Demo Drive")
        #expect(model.drives.first?.mountState == .mounted)
        #expect(model.uploads != nil)
        #expect(model.pins == [])
    }
}

@Suite @MainActor struct UpdateControllerTests {
    @Test func requiresBothFeedKeys() {
        #expect(!UpdateController(info: [:]).isEnabled)
        #expect(!UpdateController(info: ["SUFeedURL": "https://example.invalid/feed"]).isEnabled)
        #expect(UpdateController(info: ["SUFeedURL": "https://example.invalid/feed", "SUPublicEDKey": "test"]).isEnabled)
    }

    @Test func pendingWritesPostponeAndIdleUnmountsCleanly() async throws {
        let mock = MockDaemonClient()
        let updater = UpdateController(info: [:], makeClient: { mock })
        try await mock.mount(driveId: "demo")
        await mock.setUploads(UploadsSnapshot(pending: [PendingUpload(driveId: "demo", path: "/x", bytes: 1)], journalBytes: 1, journalCapBytes: 100))
        #expect(await updater.prepareForInstallation() == false)
        #expect(try await mock.listMounts()?.count == 1)
        await mock.setUploads(UploadsSnapshot(pending: [], journalBytes: 0, journalCapBytes: 100))
        #expect(await updater.prepareForInstallation())
        #expect(try await mock.listMounts()?.isEmpty == true)
    }

    @Test func unreachableDaemonPostpones() async {
        let updater = UpdateController(info: [:], makeClient: {
            UnixSocketDaemonClient(socketPath: "/tmp/unlispace-no-socket-\(UUID().uuidString)")
        })
        #expect(await updater.prepareForInstallation() == false)
    }
}

@Suite @MainActor struct DriveWorkspaceTests {
    private var drives: [DriveInfo] {
        [DriveInfo(driveId: "design", name: "Design & brand", mountState: .mounted),
         DriveInfo(driveId: "archive", name: "Archive", mountState: .unmounted),
         DriveInfo(driveId: "busy", name: "Work", mountState: .mounting),
         DriveInfo(driveId: "broken", name: "Design backup", mountState: .error)]
    }

    @Test func filtersCombineNameAndMountStateWithoutReordering() {
        #expect(DriveFilter.all.apply(to: drives, query: " DESIGN ").map(\.driveId) == ["design", "broken"])
        #expect(DriveFilter.mounted.apply(to: drives, query: "design").map(\.driveId) == ["design"])
        #expect(DriveFilter.unmounted.apply(to: drives, query: "").map(\.driveId) == ["archive"])
        #expect(DriveFilter.attention.apply(to: drives, query: "").map(\.driveId) == ["broken"])
        #expect(DriveFilter.all.apply(to: drives, query: "   ") == drives)
        #expect(DriveFilter.mounted.apply(to: drives, query: "archive").isEmpty)
    }

    @Test func driveActionsRejectMocksAndDuplicateRequests() async {
        let model = AppModel()
        let drive = drives[0]
        model.drives = drives
        model.unmount(drive)
        #expect(model.pendingDriveActions.isEmpty)
        model.usingMock = false
        model.unmount(drive)
        #expect(model.pendingDriveActions == [drive.driveId])
        model.mount(drive)
        #expect(model.pendingDriveActions == [drive.driveId])
        // The default mock has no design drive: failure must release the action lock.
        for _ in 0..<100 where !model.pendingDriveActions.isEmpty { await Task.yield() }
        #expect(model.pendingDriveActions.isEmpty)
        #expect(model.lastError != nil)
        #expect(model.isDriveBusy(drives[2]))
    }
}
