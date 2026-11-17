import Foundation
import Testing
import OrbitKit
@testable import Orbit

/// The menu-bar panel says one thing and offers one action. These cover which thing wins.
@Suite @MainActor struct MenuHeadlineTests {
    private static let finder = DriveInfo(driveId: "design", name: "Design", mountState: .mounted, mountPath: "/Volumes/Design")
    private static let idle = DriveInfo(driveId: "archive", name: "Archive", mountState: .unmounted)
    private static let broken = DriveInfo(driveId: "legal", name: "Legal", mountState: .error)

    /// Signed in, connected, set up, one drive in Finder, nothing in flight.
    private func ready(_ change: (inout MenuHeadline.Input) -> Void = { _ in }) -> MenuHeadline {
        var input = MenuHeadline.Input()
        input.hasCredentials = true
        input.connected = true
        input.drives = [Self.idle, Self.finder]
        change(&input)
        return MenuHeadline.make(input)
    }

    private func access(_ json: String) throws -> [MeAccess.Workspace] {
        try JSONDecoder().decode(MeAccess.self, from: Data(#"{"workspaces":[\#(json)]}"#.utf8)).workspaces
    }

    @Test func aQuietAccountIsUpToDateAndOpensTheDriveInFinder() {
        let headline = ready()
        #expect(headline.title == "All files are up to date")
        #expect(headline.tone == .good)
        // The drive already in Finder is the one to open, not simply the first in the list.
        #expect(headline.action == .openInFinder(driveID: "design"))
        #expect(headline.action?.title == "Open in Finder")
        #expect(ready { $0.drives = [Self.idle] }.action == .openInFinder(driveID: "archive"))
        // An engine that does not report its upload queue cannot promise everything is uploaded.
        #expect(ready { $0.uploadQueueKnown = false }.title == "Your drives are connected")
    }

    @Test func syncingCountsFilesAndNeverCountsTheDriveTotal() {
        #expect(ready { $0.filesInFlight = 1; $0.changesInFlight = true }.title == "Syncing 1 file")
        let three = ready { $0.filesInFlight = 3; $0.changesInFlight = true; $0.transferredBytes = (6_200_000, 10_400_000) }
        #expect(three.title == "Syncing 3 files")
        #expect(three.detail == "\(Format.bytes(6_200_000)) of \(Format.bytes(10_400_000))")
        #expect(three.detail?.contains("MB") == true)
        #expect(three.action == .showActivity && three.tone == .busy)
        #expect(ready { $0.changesInFlight = true }.title == "Syncing changes")
        #expect(ready { $0.status = .syncing }.title == "Syncing changes")
    }

    @Test func setupAndSignInComeBeforeEverythingElse() {
        let waiting = ready { $0.signingIn = true; $0.setupCompleted = false }
        #expect(waiting.title == "Finish in your browser" && waiting.action == .openBrowserAgain)
        let unfinished = ready { $0.setupCompleted = false; $0.filesInFlight = 2 }
        #expect(unfinished.title == "Setup not finished" && unfinished.action == .continueSetup)
        let signedOut = ready { $0.hasCredentials = false }
        #expect(signedOut.title == "You're signed out" && signedOut.action == .signIn)
        #expect(ready { $0.hasCredentials = false; $0.canRestoreSignIn = true }.action == .restoreSignIn)
        #expect(ready { $0.sessionPending = true }.title == "Setting up your drive")
    }

    @Test func aStoppedBackgroundServiceSaysHowToBringDrivesBack() {
        func stopped(_ install: EngineInstallState) -> MenuHeadline { ready { $0.connected = false; $0.install = install } }
        #expect(stopped(.notRegistered).action == .allowBackground)
        #expect(stopped(.requiresApproval).action == .approveBackground)
        #expect(stopped(.enabled).action == .tryAgain)
        #expect(stopped(.failed("Launch agent rejected")).detail == "Launch agent rejected")
        #expect(stopped(.notInstalled).action == nil)
        let all = [stopped(.notRegistered), stopped(.requiresApproval), stopped(.enabled), stopped(.notInstalled)]
        #expect(all.allSatisfy { $0.tone == .attention })
        // The default UI never names the machinery.
        #expect(all.allSatisfy { text in ["daemon", "engine", "service"].allSatisfy { !"\(text.title) \(text.detail ?? "")".lowercased().contains($0) } })
    }

    @Test func planAndStorageMessagesReassureBeforeTheyAsk() throws {
        let expired = try access(#"{"id":"a","name":"Acme","state":"expired","storageReady":true,"writable":false}"#)
        let paused = ready { $0.access = expired; $0.filesInFlight = 4 }
        #expect(paused.title == "Changes are paused — plan inactive")
        #expect(paused.detail?.hasPrefix("Your files are safe.") == true)
        #expect(paused.action == .managePlan(workspaceID: "a"))
        #expect(paused.action?.title == "Manage Plan on the Web")

        let nearly = try access(#"{"id":"a","name":"Acme","state":"paid","storageReady":true,"writable":true,"usedBytes":9500000000,"quotaBytes":10000000000}"#)
        let almost = ready { $0.access = nearly }
        #expect(almost.title == "Storage almost full")
        #expect(almost.detail?.hasPrefix("Your files are safe.") == true && almost.detail?.contains("GB") == true)
        #expect(almost.action == .managePlan(workspaceID: "a"))
        let over = try access(#"{"id":"a","name":"Acme","state":"paid","storageReady":true,"writable":true,"usedBytes":10000000000,"quotaBytes":10000000000}"#)
        #expect(ready { $0.access = over }.title == "Storage is full")
        let roomy = try access(#"{"id":"a","name":"Acme","state":"paid","storageReady":true,"writable":true,"usedBytes":8900000000,"quotaBytes":10000000000}"#)
        #expect(ready { $0.access = roomy }.title == "All files are up to date")
        // A server that reports no quota is never called full.
        let unmetered = try access(#"{"id":"a","name":"Acme","state":"paid","storageReady":true,"writable":true}"#)
        #expect(ready { $0.access = unmetered }.title == "All files are up to date")
    }

    @Test func anEndedTrialPausesChangesWhenTheServerHasNoAccessReport() throws {
        let now = Date(timeIntervalSince1970: 2_000_000)
        let orgs = try JSONDecoder().decode(WorkspacesResult.self, from: Data(#"""
        {"orgs":[{"id":"a","name":"Acme","role":"owner","tier":"teams","trialEndsAt":1000000000},
                 {"id":"b","name":"Later","role":"owner","tier":"teams","trialEndsAt":3000000000}]}
        """#.utf8)).orgs
        let ended = ready { $0.workspaces = orgs; $0.now = now }
        #expect(ended.title == "Changes are paused — plan inactive" && ended.action == .managePlan(workspaceID: "a"))
        #expect(ready { $0.workspaces = [orgs[1]]; $0.now = now }.title == "All files are up to date")
    }

    @Test func problemsOutrankProgressInAFixedOrder() {
        let drive = ready { $0.drives = [Self.finder, Self.broken]; $0.failedUpload = "Plan.pdf"; $0.filesInFlight = 2 }
        #expect(drive.title == "A drive needs attention")
        #expect(drive.detail?.contains("Legal") == true)
        #expect(drive.action == .retryDrive(driveID: "legal"))
        let upload = ready { $0.failedUpload = "Plan.pdf"; $0.filesInFlight = 2 }
        #expect(upload.title == "An upload didn't finish")
        #expect(upload.detail?.contains("Plan.pdf") == true && upload.action == .showActivity)
        #expect(ready { $0.status = .offline; $0.filesInFlight = 2 }.title == "You're offline")
        let failing = ready { $0.status = .error; $0.error = "timed out" }
        #expect(failing.title == "Orbit can't sync right now" && failing.detail == "timed out" && failing.action == .tryAgain)
    }

    @Test func anAccountWithoutDrivesIsOfferedOne() {
        let none = ready { $0.drives = [] }
        #expect(none.title == "No drives yet" && none.action == .newDrive)
    }

    @Test func everyHeadlineHasWordsASymbolAndAtMostOneAction() {
        let headlines = [ready(), ready { $0.signingIn = true }, ready { $0.hasCredentials = false },
                         ready { $0.connected = false }, ready { $0.status = .offline }, ready { $0.drives = [] }]
        #expect(headlines.allSatisfy { !$0.title.isEmpty && !$0.symbol.isEmpty })
        #expect(headlines.allSatisfy { $0.action == nil || !$0.action!.title.isEmpty })
    }

    @Test func theModelCountsFilesFromLiveTransfersAndTheUploadQueue() async throws {
        let transfers = [
            TransferInfo(id: "up", driveId: "design", path: "/Brand/Style guide.pdf", direction: .upload,
                         bytesDone: 5_200_000, bytesTotal: 10_400_000, status: .active),
            TransferInfo(id: "total", driveId: "design", path: "/", direction: .upload, bytesDone: 0, bytesTotal: 0, status: .queued),
        ]
        let queue = UploadsSnapshot(pending: [PendingUpload(driveId: "design", path: "/Brand/Logo.svg", bytes: 48_000)],
                                    journalBytes: 48_000, journalCapBytes: 10_000_000_000)
        let model = try await Fixtures.showing(SnapshotClient(drives: [Self.finder], transfers: transfers, queue: queue, state: .syncing))
        #expect(model.headline.title == "Syncing 2 files")
        #expect(model.statusTitle == model.headline.title)

        model.apply(.transfer(TransferInfo(id: "failed", driveId: "design", path: "/Brand/Interrupted.pdf",
                                           direction: .upload, bytesDone: 20, bytesTotal: 100, status: .failed)))
        #expect(model.headline.title == "An upload didn't finish")
        #expect(model.headline.detail?.contains("Interrupted.pdf") == true)
    }
}
