import Testing
import Foundation
@testable import OrbitKit

@Suite struct StatusTests {
    @Test func engineStateMapsToStatusAndIcon() {
        let cases: [(EngineState, AppStatus, String)] = [
            (.signedOut, .signedOut, "icloud.slash"),
            (.idle, .idle, "icloud"),
            (.syncing, .syncing, "arrow.triangle.2.circlepath.icloud"),
            (.offline, .offline, "wifi.slash"),
            (.error, .error, "exclamationmark.icloud"),
        ]
        for (e, s, sym) in cases {
            #expect(AppStatus(engine: e) == s)
            #expect(s.symbolName == sym)
        }
        #expect(AppStatus.engineMissing.symbolName == "exclamationmark.icloud")
    }

    @Test func transferLine() {
        #expect(TransferSummary.line(for: []) == nil)
        let done = TransferInfo(id: "1", driveId: "a", path: "/x", direction: .upload, bytesDone: 5, bytesTotal: 5, status: .done)
        #expect(TransferSummary.line(for: [done]) == nil)
        let a = TransferInfo(id: "2", driveId: "a", path: "/y", direction: .download, bytesDone: 1000, bytesTotal: 2000, status: .active)
        let line = TransferSummary.line(for: [a])
        #expect(line?.hasPrefix("1 file:") == true)
    }

    @Test func uploadStatusReportsRecentFailure() {
        let snapshot = UploadsSnapshot(pending: [], journalBytes: 10, journalCapBytes: 100)
        let failure = TransferInfo(id: "1", driveId: "a", path: "/x", direction: .upload, bytesDone: 0, bytesTotal: 5, status: .failed)
        #expect(TransferSummary.uploadTitle(uploads: snapshot, transfers: [], state: .idle, available: true) == "No uploads pending")
        #expect(TransferSummary.uploadTitle(uploads: snapshot, transfers: [], state: .idle, available: true, recentUploads: [failure]) == "A recent upload failed")
        #expect(TransferSummary.uploadTitle(uploads: snapshot, transfers: [], state: .offline, available: true, recentUploads: [failure]) == "Offline · Cloud save not confirmed")
    }

    @Test func activityCombinesQueueAndEventsByDriveAndPath() {
        let pending = [PendingUpload(driveId: "a", path: "/.DS_Store", bytes: 1),
                       PendingUpload(driveId: "b", path: "/.DS_Store", bytes: 2)]
        let failed = TransferInfo(id: "1", driveId: "a", path: "/.DS_Store", direction: .upload, bytesDone: 0, bytesTotal: 1, status: .failed)
        let download = TransferInfo(id: "2", driveId: "b", path: "/.DS_Store", direction: .download, bytesDone: 0, bytesTotal: 2, status: .active)
        let rows = TransferActivity.list(pending: pending, transfers: [download], recentUploads: [failed])
        #expect(rows.count == 3)
        #expect(rows[0].pending == pending[0] && rows[0].transfer == failed)
        #expect(rows[1].pending == pending[1] && rows[1].transfer == nil)
        #expect(rows[2].transfer == download)
    }

    @Test func activityHandlesDriveAggregateEvents() {
        let pending = PendingUpload(driveId: "a", path: "/.DS_Store", bytes: 1)
        let queued = TransferInfo(id: "a:upload", driveId: "a", path: "/", direction: .upload, bytesDone: 0, bytesTotal: 1, status: .queued)
        var done = queued
        done.status = .done
        var failed = queued
        failed.status = .failed
        let fileDone = TransferInfo(id: "file", driveId: "a", path: "/file", direction: .upload, bytesDone: 1, bytesTotal: 1, status: .done)
        #expect(TransferActivity.list(pending: [pending], transfers: [queued], recentUploads: []).count == 1)
        #expect(TransferActivity.list(pending: [pending], transfers: [failed], recentUploads: []).count == 2)
        #expect(TransferActivity.list(pending: [], transfers: [queued], recentUploads: []).first?.transfer == queued)
        let completed = TransferActivity.list(pending: [], transfers: [], recentUploads: [done, fileDone])
        #expect(completed.count == 1 && completed.first?.transfer == fileDone)
    }

    @Test func endpointValidation() {
        #expect(AppSettings.validateEndpoint("https://api.example.com") != nil)
        #expect(AppSettings.validateEndpoint("http://localhost:8787") != nil)
        #expect(AppSettings.validateEndpoint("http://example.com") == nil)
        #expect(AppSettings.validateEndpoint("nonsense") == nil)
    }
}
