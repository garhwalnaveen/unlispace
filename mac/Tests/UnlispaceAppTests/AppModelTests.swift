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
