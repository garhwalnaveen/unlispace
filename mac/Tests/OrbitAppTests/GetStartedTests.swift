import Foundation
import Testing
import OrbitKit
@testable import Orbit

/// The "Get started" list that stays after setup until every step is done.
@Suite @MainActor struct GetStartedTests {
    private func steps(_ change: (inout GetStarted.Input) -> Void = { _ in }) -> [GetStartedStep] {
        var input = GetStarted.Input()
        change(&input)
        return GetStarted.steps(input)
    }

    @Test func aNewAccountHasEveryStepOpenAndSignInNext() {
        let steps = steps()
        #expect(steps.map(\.id) == [.signIn, .background, .finder, .firstFile])
        #expect(steps.allSatisfy { !$0.done })
        #expect(GetStarted.summary(steps) == "Get started · 0 of 4 done")
        #expect(GetStarted.next(steps)?.id == .signIn)
        #expect(GetStarted.isVisible(steps, dismissed: false))
    }

    @Test func aSkippedStepStaysOpenWhileLaterOnesFinish() {
        // Signed in and using the drive, but the background permission was skipped during setup.
        let steps = steps {
            $0.signedIn = true
            $0.hasDrive = true
            $0.progress.finderOpened = true
        }
        #expect(steps.filter(\.done).map(\.id) == [.signIn, .finder])
        #expect(GetStarted.summary(steps) == "Get started · 2 of 4 done")
        let next = GetStarted.next(steps)
        #expect(next?.id == .background && next?.action == "Allow")
        #expect(GetStarted.isVisible(steps, dismissed: false))
    }

    @Test func theFirstFileCountsOnlyOnceItIsSaved() {
        let adding = steps { $0.signedIn = true; $0.backgroundRunning = true; $0.hasDrive = true; $0.progress.finderOpened = true }
        #expect(GetStarted.next(adding)?.id == .firstFile)
        #expect(GetStarted.next(adding)?.action == "Add a File…")
        let uploading = steps {
            $0.signedIn = true; $0.backgroundRunning = true; $0.hasDrive = true
            $0.progress.finderOpened = true; $0.progress.fileAdded = true
        }
        let step = uploading.first { $0.id == .firstFile }
        #expect(step?.done == false && step?.action == nil)
        #expect(step?.detail.hasPrefix("Uploading") == true)
        let saved = steps {
            $0.signedIn = true; $0.backgroundRunning = true; $0.hasDrive = true
            $0.progress.finderOpened = true; $0.progress.fileAdded = true; $0.progress.cloudSaveConfirmed = true
        }
        #expect(saved.allSatisfy { $0.done })
        #expect(!GetStarted.isVisible(saved, dismissed: false))
        #expect(GetStarted.next(saved) == nil)
    }

    @Test func alertsAreOptionalAndListedOnlyWhenMacOSCanBeAsked() {
        #expect(!steps { $0.notifications = .unavailable }.contains { $0.id == .alerts })
        #expect(!steps { $0.notifications = .checking }.contains { $0.id == .alerts })
        let asked = steps { $0.notifications = .notRequested }
        #expect(asked.last?.id == .alerts && asked.last?.optional == true && asked.last?.action == "Allow")
        #expect(GetStarted.summary(asked) == "Get started · 0 of 5 done")
        #expect(steps { $0.notifications = .denied }.last?.action == "Open Settings…")
        #expect(steps { $0.notifications = .quiet }.last?.done == true)
    }

    @Test func stepsWithoutADriveOrAServiceOfferNoButtonThatCannotWork() {
        let steps = steps { $0.signedIn = true; $0.backgroundAction = nil }
        #expect(steps.first { $0.id == .background }?.action == nil)
        #expect(steps.first { $0.id == .finder }?.action == nil)
        #expect(steps.first { $0.id == .firstFile }?.action == nil)
    }

    @Test func hidingTheListIsRememberedPerAccount() async throws {
        let model = try await Fixtures.showing(SnapshotClient(drives: [DriveInfo(driveId: "one", name: "One", mountState: .unmounted)]))
        #expect(model.showsGetStarted)
        #expect(model.getStartedSteps.filter(\.done).map(\.id) == [.signIn, .background])
        model.activation.record { $0.dismissed = true }
        #expect(!model.showsGetStarted)
    }

    @Test func theListFollowsRealProgress() async throws {
        let drive = DriveInfo(driveId: "one", name: "One", mountState: .mounted, mountPath: "/Volumes/One")
        let model = try await Fixtures.showing(SnapshotClient(drives: [drive]))
        model.activation.record { $0.finderOpened = true }
        model.apply(.transfer(TransferInfo(id: "t", driveId: "one", path: "/a.txt", direction: .upload,
                                           bytesDone: 1, bytesTotal: 1, status: .done)))
        #expect(model.getStartedSteps.allSatisfy { $0.done })
        #expect(!model.showsGetStarted)
    }

    @Test func aFirstRunAsksForSignInButSigningOutLaterDoesNotStartOver() {
        let model = Fixtures.offline()
        model.setupCompleted = false
        model.engineIsUnavailable(error: nil)
        #expect(model.showsGetStarted)
        #expect(GetStarted.next(model.getStartedSteps)?.id == .signIn)
        // Progress is kept per account, so a signed-out Mac that finished setup has nothing to show.
        model.setupCompleted = true
        #expect(!model.showsGetStarted)
    }

    @Test func theBackgroundStepOffersWhatMacOSNeedsNext() {
        let model = Fixtures.offline()
        model.session.setAccount(Fixtures.account)
        func action(_ install: EngineInstallState) -> String? {
            model.engine.install = install
            return model.getStartedSteps.first { $0.id == .background }?.action
        }
        #expect(action(.notRegistered) == "Allow")
        #expect(action(.requiresApproval) == "Approve…")
        #expect(action(.enabled) == nil)
        #expect(action(.notInstalled) == nil)
    }

    @Test func aStepTheHeadlineAlreadyOffersGetsNoSecondButton() {
        #expect(GetStarted.isCovered(.signIn, by: .continueSetup))
        #expect(GetStarted.isCovered(.signIn, by: .signIn))
        #expect(GetStarted.isCovered(.background, by: .approveBackground))
        #expect(GetStarted.isCovered(.finder, by: .openInFinder(driveID: "one")))
        #expect(!GetStarted.isCovered(.finder, by: .showActivity))
        #expect(!GetStarted.isCovered(.firstFile, by: .openInFinder(driveID: "one")))
        #expect(!GetStarted.isCovered(.background, by: nil))
    }
}
