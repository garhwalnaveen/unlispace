import Foundation

import Testing
import OrbitKit
@testable import Orbit

@Suite @MainActor struct AppModelTests {
    @Test func firstFileChecklistStaysDismissedAndIsScopedToAccount() throws {
        let suite = "activation-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var progress = ActivationProgress()
        #expect(progress.showsChecklist)
        progress.finderOpened = true
        progress.fileAdded = true
        #expect(progress.showsChecklist)
        progress.cloudSaveConfirmed = true
        #expect(!progress.showsChecklist)
        progress.cloudSaveConfirmed = false
        progress.dismissed = true
        progress.save(accountID: "one", defaults: defaults)
        #expect(!ActivationProgress.load(accountID: "one", defaults: defaults).showsChecklist)
        #expect(ActivationProgress.load(accountID: "two", defaults: defaults).showsChecklist)
    }

    @Test func firstFileChecklistRequiresKnownWritableAccess() throws {
        func access(_ workspaces: String) throws -> [MeAccess.Workspace] {
            try JSONDecoder().decode(MeAccess.self, from: Data("{\"workspaces\":[\(workspaces)]}".utf8)).workspaces
        }
        let expired = #"{"id":"a","name":"A","state":"expired","storageReady":true,"writable":false}"#
        let writable = #"{"id":"b","name":"B","state":"paid","storageReady":true,"writable":true}"#
        let unknown = #"{"id":"c","name":"C","state":"paid","storageReady":true}"#
        let drive = DriveInfo(driveId: "one", name: "One", mountState: .mounted)
        let readOnly = DaemonMount(driveId: "one", mountpoint: "/Volumes/One", readOnly: true, adapter: "smb")
        #expect(!ActivationCard.canAddFile(access: try access(expired), drives: [], mounts: nil))
        #expect(ActivationCard.canAddFile(access: try access("\(expired),\(writable)"), drives: [], mounts: nil))
        #expect(ActivationCard.canAddFile(access: try access(unknown), drives: [], mounts: nil))
        #expect(ActivationCard.canAddFile(access: nil, drives: [drive], mounts: nil))
        #expect(!ActivationCard.canAddFile(access: nil, drives: [drive], mounts: [readOnly]))
    }

    @Test func searchSelectsOnlyDriveAndKeepsValidSelection() {
        #expect(FileSearchView.selectedDrive("", available: ["a"]) == "a")
        #expect(FileSearchView.selectedDrive("a", available: ["a", "b"]) == "a")
        #expect(FileSearchView.selectedDrive("a", available: ["b", "c"]) == "")
        #expect(FileSearchView.selectedDrive("a", available: []) == "")
    }

    @Test func driveSummaryDoesNotConfirmTheFirstFileUpload() throws {
        let suite = "upload-milestone-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(defaults: defaults)
        model.usingMock = false
        model.account = AuthUser(id: "one", email: "local@example.invalid")
        model.drives = [DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)]
        var transfer = TransferInfo(id: "drive:upload", driveId: "drive", path: "/", direction: .upload,
                                    bytesDone: 100, bytesTotal: 100, status: .done)
        model.apply(.transfer(transfer))
        #expect(!model.activation.fileAdded)
        #expect(!model.activation.cloudSaveConfirmed)
        transfer.path = "/.DS_Store"
        model.apply(.transfer(transfer))
        #expect(!model.activation.cloudSaveConfirmed)
        transfer.id = "drive:upload:/notes.txt"
        transfer.path = "/notes.txt"
        model.apply(.transfer(transfer))
        #expect(model.activation.fileAdded)
        #expect(model.activation.cloudSaveConfirmed)
    }

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

    @Test func successfulRefreshOnlyClearsItsOwnError() {
        let model = AppModel()
        model.setRefreshError("Engine unavailable")
        model.setRefreshError(nil)
        #expect(model.lastError == nil)

        model.setRefreshError("Engine unavailable")
        model.lastError = "Sign-in failed"
        model.setRefreshError(nil)
        #expect(model.lastError == "Sign-in failed")
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
            UnixSocketDaemonClient(socketPath: "/tmp/orbit-no-socket-\(UUID().uuidString)")
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

private actor SavedSignInDeniedClient: DaemonClient {
    func connect() async throws {}
    func disconnect() async {}
    func status() async throws -> DaemonStatus { DaemonStatus(version:"test",state:.error,message:"macOS could not read saved sign-in. Approve Keychain access.",canRetrySignIn:true) }
    func authStatus() async throws -> AuthStatus { AuthStatus(signedIn:false) }
    func listDrives() async throws -> [DriveInfo] { throw DaemonClientError.remote(DaemonError(code:"unauthorized",message:"credentials unavailable")) }
    func transfers() async throws -> [TransferInfo] { [] }
    func mount(driveId:String) async throws {}
    func unmount(driveId:String) async throws {}
    func setConfig(_ config:DaemonConfig) async throws {}
    func authSet(_ params:AuthSetParams) async throws -> AuthSetResult { throw DaemonClientError.notConnected }
    func authSignOut() async throws {}
    nonisolated func events() -> AsyncStream<DaemonEvent> { AsyncStream { $0.finish() } }
}

@Suite @MainActor struct SavedSignInRecoveryModelTests {
    @Test func aCredentialErrorKeepsTheEngineConnectedAndShowsExplicitRecovery() async throws {
        let model=AppModel();model.usingMock=false
        model.drives=[DriveInfo(driveId:"stale",name:"Stale account drive",mountState:.mounted)]
        try await model.refreshConnected(using:SavedSignInDeniedClient())
        #expect(!model.usingMock)
        #expect(!model.isSignedIn)
        #expect(model.canRetrySignIn)
        #expect(model.stateMessage?.contains("Keychain") == true)
        #expect(model.drives.isEmpty)
        #expect(model.uploads == nil)
    }
}
