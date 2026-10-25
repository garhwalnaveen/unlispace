import Foundation
import Testing
@testable import UnlispaceKit

@Suite struct DistributionTests {
    @Test func freshStatusAndBothQueuesGateInstallation() {
        let idle = DaemonStatus(version: "test", state: .idle, pendingOps: 0)
        let empty = UploadsSnapshot(pending: [], journalBytes: 0, journalCapBytes: 100)
        let pending = UploadsSnapshot(pending: [PendingUpload(driveId: "d", path: "/x", bytes: 10)], journalBytes: 10, journalCapBytes: 100)
        #expect(UpdateSafety.canInstall(status: idle, uploads: empty))
        #expect(UpdateSafety.canInstall(status: idle, uploads: nil)) // older engine
        #expect(!UpdateSafety.canInstall(status: nil, uploads: empty))
        #expect(!UpdateSafety.canInstall(status: DaemonStatus(version: "old", state: .idle), uploads: empty))
        #expect(!UpdateSafety.canInstall(status: DaemonStatus(version: "test", state: .idle, pendingOps: 1), uploads: empty))
        #expect(!UpdateSafety.canInstall(status: idle, uploads: pending))
    }

    @Test func onlyUnknownMethodsHideFeatures() {
        #expect(DaemonError(code: "bad_request", message: "unknown method \"uploads\"").isUnknownMethod)
        #expect(DaemonError(code: "method_not_found", message: "uploads").isUnknownMethod)
        #expect(DaemonError(code: "unknown_method", message: "uploads").isUnknownMethod)
        #expect(!DaemonError(code: "bad_request", message: "invalid parameters").isUnknownMethod)
        #expect(!DaemonError(code: "unauthorized", message: "not signed in").isUnknownMethod)
    }

    @Test func m3WireIgnoresFutureFieldsAndAdapters() throws {
        let line = Data(#"{"event":"pin","data":{"driveId":"d","path":"/x","bytes":100,"cachedBytes":25,"future":true}}"#.utf8)
        let pin = OfflinePin(driveId: "d", path: "/x", bytes: 100, cachedBytes: 25)
        #expect(try DaemonCodec.decodeServerLine(line) == .event(.pin(pin)))
        #expect(pin.progress == 0.25)
        #expect(OfflinePin(driveId: "d", path: "/x", bytes: 10, cachedBytes: 20).progress == 1)
        let mount = try JSONDecoder().decode(DaemonMount.self, from: Data(#"{"driveId":"d","mountpoint":"/Volumes/X","readOnly":true,"adapter":"future"}"#.utf8))
        #expect(mount.adapter == "future")
    }

    @Test func mockPinsUploadsAndMountpoints() async throws {
        let mock = MockDaemonClient()
        try await mock.mount(driveId: "demo")
        #expect(try await mock.listMounts()?.first?.mountpoint == "/Volumes/Demo Drive")
        try await mock.pin(driveId: "demo", path: "/", pinned: true)
        #expect(try await mock.listPins(driveId: "demo")?.count == 1)
        #expect(try await mock.listPins(driveId: "other")?.isEmpty == true)
        await mock.pushPin(OfflinePin(driveId: "demo", path: "/", bytes: 100, cachedBytes: 50))
        #expect(try await mock.listPins(driveId: nil)?.first?.progress == 0.5)
        try await mock.pin(driveId: "demo", path: "/", pinned: false)
        #expect(try await mock.listPins(driveId: nil)?.isEmpty == true)
        let snapshot = UploadsSnapshot(pending: [PendingUpload(driveId: "demo", path: "/x", bytes: 10)], journalBytes: 10, journalCapBytes: 100)
        await mock.setUploads(snapshot)
        #expect(try await mock.uploads() == snapshot)
        #expect(try await mock.status().pendingOps == 1)
    }
}
