import Foundation

import Testing
import OrbitKit
import OrbitTestSupport
@testable import Orbit

@Suite @MainActor struct AppModelTests {
    @Test func firstFileChecklistStaysDismissedAndIsScopedToAccount() throws {
        let (defaults, cleanup) = Fixtures.defaults()
        defer { cleanup() }
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
        // A session that has not reached the engine has no identity to store progress under.
        progress.save(accountID: SessionStore.pendingAccountID, defaults: defaults)
        #expect(ActivationProgress.load(accountID: SessionStore.pendingAccountID, defaults: defaults).showsChecklist)
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
        #expect(!GetStarted.canAddFile(access: try access(expired), drives: [], mounts: nil))
        #expect(GetStarted.canAddFile(access: try access("\(expired),\(writable)"), drives: [], mounts: nil))
        #expect(GetStarted.canAddFile(access: try access(unknown), drives: [], mounts: nil))
        #expect(GetStarted.canAddFile(access: nil, drives: [drive], mounts: nil))
        #expect(!GetStarted.canAddFile(access: nil, drives: [drive], mounts: [readOnly]))
    }

    @Test func planNoticesNameTheWorkspaceAndPreferServerAccess() throws {
        let access = try JSONDecoder().decode(MeAccess.self, from: Data(#"""
        {"workspaces":[{"id":"a","name":"A","state":"expired","storageReady":true,"writable":false},
                       {"id":"b","name":"B","state":"paid","storageReady":false},
                       {"id":"c","name":"C","state":"paid","storageReady":true,"writable":false},
                       {"id":"d","name":"D","state":"paid","storageReady":true,"writable":true}]}
        """#.utf8)).workspaces
        let notices = PlanNotices.notices(access: access, workspaces: [])
        #expect(notices.map(\.id) == ["a", "b", "c"])
        #expect(notices.allSatisfy { $0.text.hasPrefix("\($0.id.uppercased()):") })
        #expect(PlanNotices.notices(access: [], workspaces: []).isEmpty)
        #expect(PlanNotices.notices(access: nil, workspaces: []).isEmpty)
    }

    @Test func searchSelectsOnlyDriveAndKeepsValidSelection() {
        #expect(FileSearchView.selectedDrive("", available: ["a"]) == "a")
        #expect(FileSearchView.selectedDrive("a", available: ["a", "b"]) == "a")
        #expect(FileSearchView.selectedDrive("a", available: ["b", "c"]) == "")
        #expect(FileSearchView.selectedDrive("a", available: []) == "")
    }

    @Test func driveSummaryDoesNotConfirmTheFirstFileUpload() throws {
        let (defaults, cleanup) = Fixtures.defaults()
        defer { cleanup() }
        let model = Fixtures.connected(defaults: defaults)
        model.session.setAccount(Fixtures.account)
        model.drives.setDrives([DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)])
        var transfer = TransferInfo(id: "drive:upload", driveId: "drive", path: "/", direction: .upload,
                                    bytesDone: 100, bytesTotal: 100, status: .done)
        model.apply(.transfer(transfer))
        #expect(!model.activation.progress.fileAdded)
        #expect(!model.activation.progress.cloudSaveConfirmed)
        transfer.path = "/.DS_Store"
        model.apply(.transfer(transfer))
        #expect(!model.activation.progress.cloudSaveConfirmed)
        transfer.id = "drive:upload:/notes.txt"
        transfer.path = "/notes.txt"
        model.apply(.transfer(transfer))
        #expect(model.activation.progress.fileAdded)
        #expect(model.activation.progress.cloudSaveConfirmed)
        #expect(ActivationProgress.load(accountID: "one", defaults: defaults).cloudSaveConfirmed)
    }

    @Test func uploadsForUnknownDrivesOrWithoutTheEngineAreNotMilestones() throws {
        let (defaults, cleanup) = Fixtures.defaults()
        defer { cleanup() }
        let upload = TransferInfo(id: "u", driveId: "drive", path: "/notes.txt", direction: .upload,
                                  bytesDone: 1, bytesTotal: 1, status: .done)
        let offline = Fixtures.offline(defaults: defaults)
        offline.session.setAccount(Fixtures.account)
        offline.drives.setDrives([DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)])
        offline.apply(.transfer(upload))
        #expect(!offline.activation.progress.fileAdded)
        #expect(offline.activity.recentUploads.isEmpty)

        let connected = Fixtures.connected(defaults: defaults)
        connected.session.setAccount(Fixtures.account)
        connected.apply(.transfer(upload))
        #expect(!connected.activation.progress.fileAdded)
    }

    @Test func transferEventsReplaceProgressAndRemoveFinishedTransfers() {
        let model = Fixtures.offline()
        var transfer = TransferInfo(id: "one", driveId: "drive", path: "/notes.txt", direction: .upload,
                                    bytesDone: 0, bytesTotal: 100, status: .queued)
        model.apply(.transfer(transfer))
        #expect(model.activity.transfers == [transfer])
        transfer.bytesDone = 50
        transfer.status = .active
        model.apply(.transfer(transfer))
        #expect(model.activity.transfers.count == 1)
        #expect(model.activity.transfers.first?.progress == 0.5)
        transfer.status = .done
        model.apply(.transfer(transfer))
        #expect(model.activity.transfers.isEmpty)
        transfer.status = .failed
        model.apply(.transfer(transfer))
        #expect(model.activity.transfers.isEmpty)
        #expect(model.messages.error == "“notes.txt” didn't finish uploading.")
    }

    @Test func finishedUploadHistoryIsBounded() {
        let model = Fixtures.connected()
        model.session.setAccount(Fixtures.account)
        model.drives.setDrives([DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)])
        for index in 0..<(ActivityStore.historyLimit + 10) {
            model.apply(.transfer(TransferInfo(id: "t\(index)", driveId: "drive", path: "/f\(index)", direction: .upload,
                                               bytesDone: 1, bytesTotal: 1, status: .done)))
        }
        #expect(model.activity.recentUploads.count == ActivityStore.historyLimit)
        #expect(model.activity.recentUploads.first?.id == "t\(ActivityStore.historyLimit + 9)")
    }

    @Test func setupCannotMountWithoutTheEngine() async {
        let model = Fixtures.offline()
        await #expect(throws: DaemonClientError.notConnected) { try await model.drives.mountSelected(["demo"]) }
        model.session.setAccount(Fixtures.account)
        await #expect(throws: DaemonClientError.notConnected) { try await model.drives.mountSelected(["demo"]) }
    }

    @Test func signOutEventClearsVisibleState() {
        let model = Fixtures.offline()
        model.session.setAccount(Fixtures.account)
        model.drives.setDrives([DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)])
        model.apply(.state(StateEvent(state: .signedOut)))
        #expect(!model.session.isSignedIn)
        #expect(model.drives.drives.isEmpty)
        #expect(model.activity.transfers.isEmpty)
        #expect(model.status == .signedOut)
    }

    @Test func changingAccountDropsThePreviousAccountsHistory() {
        let model = Fixtures.connected()
        model.session.setAccount(Fixtures.account)
        model.drives.setDrives([DriveInfo(driveId: "drive", name: "Drive", mountState: .mounted)])
        model.apply(.transfer(TransferInfo(id: "t", driveId: "drive", path: "/f", direction: .upload,
                                           bytesDone: 1, bytesTotal: 1, status: .done)))
        model.messages.fileCopy = "Copied"
        #expect(model.activity.recentUploads.count == 1)
        model.session.setAccount(AuthUser(id: "two", email: "other@example.invalid"))
        #expect(model.activity.recentUploads.isEmpty)
        #expect(model.messages.fileCopy == nil)
    }
}

@Suite @MainActor struct EngineConnectionTests {
    @Test func aModelWithoutAnEngineShowsNoDrivesAndSaysWhy() {
        let model = Fixtures.offline()
        model.engineIsUnavailable(error: nil)
        #expect(!model.engine.isConnected)
        #expect(!model.isLive)
        #expect(model.drives.drives.isEmpty)
        #expect(model.status == .signedOut)
        model.session.setAccount(Fixtures.account)
        model.engine.install = .enabled
        model.engineIsUnavailable(error: DaemonClientError.disconnected)
        #expect(model.status == .engineStopped)
        #expect(model.statusTitle == "Drives are disconnected")
        model.engine.install = .notInstalled
        model.engineIsUnavailable(error: nil)
        #expect(model.status == .engineMissing)
        // The engine still holds the session, so the account stays visible while it is away.
        #expect(model.session.account == Fixtures.account)
    }

    @Test func aSnapshotReadsDrivesMountsPinsAndUploads() async throws {
        let mock = MockDaemonClient()
        _ = try await mock.authSet(AuthSetParams(apiEndpoint: "http://localhost", accessToken: "a", refreshToken: "r"))
        try await mock.mount(driveId: "demo")
        try await mock.pin(driveId: "work", path: "/", pinned: true)
        let model = Fixtures.connected(to: mock)
        try await model.engineRefresh(mock)
        #expect(model.isLive && model.isAccountLive)
        #expect(model.status == .idle)
        #expect(model.drives.drives.map(\.driveId) == ["demo", "work"])
        #expect(model.drives.drive(id: "demo")?.mountPath == "/Volumes/Demo Drive")
        #expect(model.drives.drive(id: "demo")?.mountState == .mounted)
        #expect(model.drives.drive(id: "work")?.mountState == .unmounted)
        #expect(model.drives.mountedCount == 1)
        #expect(model.drives.mount(for: "demo")?.readOnly == false)
        #expect(model.drives.isKeptOffline("work") && !model.drives.isKeptOffline("demo"))
        #expect(model.drives.pins(for: "work").count == 1)
        #expect(model.activity.uploads != nil)
        #expect(model.statusTitle == "All files are up to date")
    }

    @Test func aSignedOutEngineClearsStaleDrives() async throws {
        let client = SavedSignInDeniedClient()
        let model = Fixtures.connected(to: client)
        model.drives.setDrives([DriveInfo(driveId: "stale", name: "Stale account drive", mountState: .mounted)])
        try await model.engineRefresh(client)
        #expect(model.engine.isConnected)
        #expect(!model.session.isSignedIn)
        #expect(model.session.canRetrySavedSignIn)
        #expect(model.messages.engineMessage?.contains("Keychain") == true)
        #expect(model.drives.drives.isEmpty)
        #expect(model.activity.uploads == nil)
    }

    @Test func aRefreshFromACancelledTaskChangesNothing() async {
        let model = Fixtures.offline()
        model.messages.engineMessage = "Previous engine status"
        await Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            await model.refresh()
        }.value
        #expect(model.messages.engineMessage == "Previous engine status")
        #expect(model.messages.error == nil)
    }

    @Test func anEngineErrorKeepsTheConnectionAndIsReported() {
        let model = Fixtures.connected()
        model.engineRefreshFailed(DaemonClientError.remote(DaemonError(code: "internal", message: "index unavailable")))
        #expect(model.engine.isConnected)
        #expect(model.status == .error)
        #expect(model.messages.error?.contains("index unavailable") == true)
        model.messages.setRefreshError(nil)
        #expect(model.messages.error == nil)
    }

    @Test func aSignOutMadeWhileTheEngineWasAwayIsDeliveredOnConnect() async throws {
        let mock = MockDaemonClient()
        _ = try await mock.authSet(AuthSetParams(apiEndpoint: "http://localhost", accessToken: "a", refreshToken: "r"))
        let defaults = MemoryDefaults()
        defaults.set(true, forKey: SessionStore.signOutPendingKey)
        #expect(defaults.bool(forKey: SessionStore.signOutPendingKey))
        let model = Fixtures.connected(to: mock, defaults: defaults)
        await model.engineDidConnect(mock)
        #expect(try await mock.authStatus().signedIn == false)
        #expect(!defaults.bool(forKey: SessionStore.signOutPendingKey))
        try await model.engineRefresh(mock)
        #expect(!model.session.isSignedIn)
        #expect(model.drives.drives.isEmpty)
    }

    @Test func eventsFromTheEngineArriveInOrderAsOneBatch() async throws {
        let mock = MockDaemonClient()
        let recorder = EventRecorder()
        let link = EngineLink(makeClient: { mock })
        link.delegate = recorder
        link.adopt(mock)
        for _ in 0..<50 where await mock.subscriberCount == 0 { try await Task.sleep(for: .milliseconds(10)) }
        for index in 0..<200 {
            await mock.pushPin(OfflinePin(driveId: "d", path: "/\(index)", bytes: 10, cachedBytes: 1))
        }
        for _ in 0..<100 where recorder.events.count < 200 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(recorder.events.count == 200)
        #expect(recorder.events.first == .pin(OfflinePin(driveId: "d", path: "/0", bytes: 10, cachedBytes: 1)))
        #expect(recorder.events.last == .pin(OfflinePin(driveId: "d", path: "/199", bytes: 10, cachedBytes: 1)))
        #expect(recorder.batches < 200, "Events inside the batch window must be delivered together")
    }
}

@MainActor private final class EventRecorder: EngineLinkDelegate {
    var events: [DaemonEvent] = []
    var batches = 0
    func engineWillRefresh() {}
    func engineDidConnect(_ client: any DaemonClient) async {}
    func engineRefresh(_ client: any DaemonClient) async throws {}
    func engineRefreshFailed(_ error: Error) {}
    func engineIsUnavailable(error: Error?) {}
    func engineReceived(_ events: [DaemonEvent]) { self.events += events; batches += 1 }
    var engineIsBusy: Bool { false }
}

@Suite @MainActor struct DistributionModelTests {
    @Test func keepingAnUnmountedDriveOfflineMountsItFirst() async throws {
        let mock = MockDaemonClient()
        let model = Fixtures.connected(to: mock)
        model.drives.setDrives(try await mock.listDrives())
        model.drives.setPin(driveId: "demo", path: "/", pinned: true)
        for _ in 0..<100 where model.drives.pendingActions.contains("demo") {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try await mock.listDrives().first { $0.driveId == "demo" }?.mountState == .mounted)
        #expect(try await mock.listPins(driveId: "demo")?.count == 1)
    }

    @Test func pinEventsUpdateOnlyAnAvailableFeatureAndSignOutClearsIt() {
        let model = Fixtures.offline()
        let pin = OfflinePin(driveId: "d", path: "/", bytes: 100, cachedBytes: 20)
        model.apply(.pin(pin))
        #expect(model.drives.pins == nil)
        model.drives.setPins([])
        model.apply(.pin(pin))
        var updated = pin
        updated.cachedBytes = 80
        model.apply(.pin(updated))
        #expect(model.drives.pins == [updated])
        #expect(model.drives.pins(for: "d") == [updated])
        #expect(model.drives.isKeptOffline("d"))
        model.apply(.state(StateEvent(state: .signedOut)))
        #expect(model.drives.pins == nil)
        #expect(model.drives.pins(for: "d").isEmpty)
        #expect(model.activity.uploads == nil)
        #expect(model.drives.mounts == nil)
    }

    @Test func successfulRefreshOnlyClearsItsOwnError() {
        let messages = AppMessages()
        messages.setRefreshError("Engine unavailable")
        messages.setRefreshError(nil)
        #expect(messages.error == nil)

        messages.setRefreshError("Engine unavailable")
        messages.error = "Sign-in failed"
        messages.setRefreshError(nil)
        #expect(messages.error == "Sign-in failed")
    }

    @Test func aReportedMountListDecidesMountState() {
        let model = Fixtures.offline()
        let stale = DriveInfo(driveId: "a", name: "A", mountState: .mounted, mountPath: "/Volumes/Old")
        let other = DriveInfo(driveId: "b", name: "B", mountState: .unmounted)
        let mount = DaemonMount(driveId: "b", mountpoint: "/Volumes/B", readOnly: true, adapter: "smb")
        model.drives.apply(drives: [stale, other], mounts: [mount], pins: nil)
        #expect(model.drives.drive(id: "a")?.mountState == .unmounted)
        #expect(model.drives.drive(id: "a")?.mountPath == nil)
        #expect(model.drives.drive(id: "b")?.mountPath == "/Volumes/B")
        #expect(model.drives.isReadOnly("b") && !model.drives.isReadOnly("a"))
        // An engine that does not report mounts leaves the drive list's own state alone.
        model.drives.apply(drives: [stale], mounts: nil, pins: nil)
        #expect(model.drives.drive(id: "a")?.mountPath == "/Volumes/Old")
        #expect(model.drives.drive(id: "b") == nil)
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
        #expect(DriveFilter.failed.apply(to: drives, query: "").map(\.driveId) == ["broken"])
        #expect(DriveFilter.all.apply(to: drives, query: "   ") == drives)
        #expect(DriveFilter.mounted.apply(to: drives, query: "archive").isEmpty)
    }

    @Test func driveActionsNeedTheEngineAndRejectDuplicateRequests() async {
        let offline = Fixtures.offline()
        offline.drives.setDrives(drives)
        offline.drives.unmount(drives[0])
        #expect(offline.drives.pendingActions.isEmpty)
        #expect(!offline.drives.openInFinder(drives[0]))

        let model = Fixtures.connected()
        let drive = drives[0]
        model.drives.setDrives(drives)
        model.drives.unmount(drive)
        #expect(model.drives.pendingActions == [drive.driveId])
        model.drives.mount(drive)
        #expect(model.drives.pendingActions == [drive.driveId])
        // The test engine has no such drive: the failure must release the lock and be reported.
        for _ in 0..<100 where !model.drives.pendingActions.isEmpty { await Task.yield() }
        #expect(model.drives.pendingActions.isEmpty)
        #expect(model.messages.error != nil)
        #expect(model.drives.isBusy(drives[2]))
        #expect(model.drives.hasTransition)
    }

    @Test func aFileCanOnlyBeAddedToAWritableMountedDriveOfASignedInAccount() {
        let model = Fixtures.connected()
        let mounted = DriveInfo(driveId: "a", name: "A", mountState: .mounted, mountPath: "/Volumes/A")
        let readOnly = DriveInfo(driveId: "b", name: "B", mountState: .mounted, mountPath: "/Volumes/B")
        let unmounted = DriveInfo(driveId: "c", name: "C", mountState: .unmounted)
        model.drives.apply(drives: [mounted, readOnly, unmounted],
                           mounts: [DaemonMount(driveId: "a", mountpoint: "/Volumes/A", readOnly: false, adapter: "smb"),
                                    DaemonMount(driveId: "b", mountpoint: "/Volumes/B", readOnly: true, adapter: "smb")], pins: nil)
        #expect(!model.drives.canAddFile(to: mounted))
        model.session.setAccount(Fixtures.account)
        #expect(model.drives.canAddFile(to: mounted))
        #expect(!model.drives.canAddFile(to: readOnly))
        #expect(!model.drives.canAddFile(to: unmounted))
    }
}

/// An engine that is reachable but cannot read its saved credentials.
private final class SavedSignInDeniedClient: DaemonClient, @unchecked Sendable {
    private let stream: AsyncStream<DaemonEvent>
    private let continuation: AsyncStream<DaemonEvent>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream() }

    func connect() async throws {}
    func disconnect() async { continuation.finish() }
    func status() async throws -> DaemonStatus {
        DaemonStatus(version: "test", state: .error, message: "macOS could not read saved sign-in. Approve Keychain access.", canRetrySignIn: true)
    }
    func authStatus() async throws -> AuthStatus { AuthStatus(signedIn: false) }
    func listDrives() async throws -> [DriveInfo] {
        throw DaemonClientError.remote(DaemonError(code: "unauthorized", message: "credentials unavailable"))
    }
    func transfers() async throws -> [TransferInfo] { [] }
    func mount(driveId: String) async throws {}
    func unmount(driveId: String) async throws {}
    func setConfig(_ config: DaemonConfig) async throws {}
    func authSet(_ params: AuthSetParams) async throws -> AuthSetResult { throw DaemonClientError.notConnected }
    func authSignOut() async throws {}
    func events() -> AsyncStream<DaemonEvent> { stream }
}
