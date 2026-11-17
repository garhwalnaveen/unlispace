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
        #expect(AppStatus.engineStopped.symbolName == "exclamationmark.icloud")
        #expect(AppStatus.engineStopped.title != AppStatus.engineMissing.title)
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
        #expect(TransferSummary.uploadTitle(uploads: snapshot, transfers: [], state: .idle, available: true, recentUploads: [failure]) == "An upload failed")
        #expect(TransferSummary.uploadTitle(uploads: snapshot, transfers: [], state: .offline, available: true, recentUploads: [failure]) == "Offline")
        #expect(TransferSummary.uploadTitle(uploads: snapshot, transfers: [], state: .idle, available: false) == "Not connected")
        #expect(TransferSummary.uploadTitle(uploads: nil, transfers: [], state: .idle, available: true) == "Upload status unavailable")
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

    @Test func activityStaysLinearAndOrderedForLargeQueues() {
        let count = 20_000
        let pending = (0..<count).map { PendingUpload(driveId: "d", path: "/file-\($0)", bytes: 1) }
        let transfers = (0..<count).map {
            TransferInfo(id: "t\($0)", driveId: "d", path: "/file-\($0)", direction: .upload, bytesDone: 0, bytesTotal: 1, status: .active)
        }
        let clock = ContinuousClock()
        var rows: [TransferActivity] = []
        let elapsed = clock.measure { rows = TransferActivity.list(pending: pending, transfers: transfers, recentUploads: []) }
        #expect(rows.count == count)
        #expect(rows.first?.transfer?.id == "t0" && rows.last?.transfer?.id == "t\(count - 1)")
        #expect(Set(rows.map(\.id)).count == count)
        // A quadratic pass over 20,000 items takes far longer than this.
        #expect(elapsed < .seconds(2))
    }

    @Test func repeatedPathsMatchQueueEntriesInOrder() {
        let pending = [PendingUpload(driveId: "d", path: "/a", bytes: 1), PendingUpload(driveId: "d", path: "/a", bytes: 2)]
        let first = TransferInfo(id: "1", driveId: "d", path: "/a", direction: .upload, bytesDone: 0, bytesTotal: 1, status: .active)
        let second = TransferInfo(id: "2", driveId: "d", path: "/a", direction: .upload, bytesDone: 0, bytesTotal: 2, status: .queued)
        let rows = TransferActivity.list(pending: pending, transfers: [first, second], recentUploads: [])
        #expect(rows.map(\.transfer) == [first, second])
    }

    @Test func indexedListReplacesInPlaceAndKeepsOrder() {
        func item(_ id: String, _ done: Int64) -> TransferInfo {
            TransferInfo(id: id, driveId: "d", path: "/\(id)", direction: .upload, bytesDone: done, bytesTotal: 10, status: .active)
        }
        var list = IndexedList([item("a", 0), item("b", 0), item("c", 0)])
        list.upsert(item("b", 5))
        #expect(list.elements.map(\.id) == ["a", "b", "c"])
        #expect(list["b"]?.bytesDone == 5)
        list.remove(id: "a")
        #expect(list.elements.map(\.id) == ["b", "c"])
        #expect(list["c"]?.id == "c" && list["a"] == nil)
        list.upsert(item("d", 1))
        list.remove(id: "missing")
        #expect(list.elements.map(\.id) == ["b", "c", "d"] && list.count == 3)
        list.replaceAll([item("x", 1), item("x", 2)])
        #expect(list.elements.map(\.bytesDone) == [2])
    }

    @Test func pollingSlowsWhenIdleAndBacksOffWhenUnreachable() {
        #expect(PollSchedule.delay(connected: true, busy: true, failures: 0) == PollSchedule.active)
        #expect(PollSchedule.delay(connected: true, busy: false, failures: 0) == PollSchedule.idle)
        #expect(PollSchedule.idle > PollSchedule.active)
        let retries = (0...8).map { PollSchedule.delay(connected: false, busy: false, failures: $0) }
        #expect(retries == retries.sorted())
        #expect(retries.first == .seconds(2))
        #expect(retries.last == PollSchedule.longestRetry)
    }

    @Test func endpointValidation() {
        #expect(AppSettings.validateEndpoint("https://api.example.com") != nil)
        #expect(AppSettings.validateEndpoint("http://localhost:8787") != nil)
        #expect(AppSettings.validateEndpoint("http://example.com") == nil)
        #expect(AppSettings.validateEndpoint("nonsense") == nil)
    }
}
