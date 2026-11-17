import AppKit
import SwiftUI
import Testing
import OrbitKit
@testable import Orbit

@Suite @MainActor struct DesignSystemTests {
    @Test func driveStatesHaveDistinctAccessibleLabelsAndSymbols() {
        let states: [MountState] = [.unmounted, .mounting, .mounted, .unmounting, .error]
        #expect(Set(states.map(\.label)).count == states.count)
        #expect(Set(states.map(\.symbol)).count == states.count)
        #expect(states.allSatisfy { !$0.symbol.isEmpty && !$0.label.isEmpty })
    }

    @Test func transferTitlesDistinguishFilesFromDriveSummaries() {
        #expect(TransferSummary.fileTitle(path: "/Brand/Style guide.pdf") == "Style guide.pdf")
        #expect(TransferSummary.fileTitle(path: "/") == "Drive changes")
        #expect(TransferSummary.fileTitle(path: "notes.txt") == "notes.txt")
        #expect(TransferSummary.fileTitle(path: "") == "")
    }

    @Test func activityRowsDescribeQueueAndTransferState() {
        func transfer(_ status: TransferStatus, _ direction: TransferDirection = .upload, path: String = "/a.txt",
                      done: Int64 = 50, total: Int64 = 100) -> TransferInfo {
            TransferInfo(id: "t", driveId: "d", path: path, direction: direction, bytesDone: done, bytesTotal: total, status: status)
        }
        let uploading = ActivityRowContent(TransferActivity(pending: nil, transfer: transfer(.active)))
        #expect(uploading.title == "a.txt" && uploading.status.hasPrefix("Uploading · ") && uploading.progress == .fraction(0.5))
        #expect(!uploading.failed && uploading.symbol == "arrow.up")

        let unknownSize = ActivityRowContent(TransferActivity(pending: nil, transfer: transfer(.active, .download, done: 0, total: 0)))
        #expect(unknownSize.status == "Downloading" && unknownSize.progress == .indeterminate && unknownSize.symbol == "arrow.down")

        let failed = ActivityRowContent(TransferActivity(pending: nil, transfer: transfer(.failed)))
        #expect(failed.failed && failed.progress == .none && failed.symbol == "exclamationmark.triangle")

        let waiting = ActivityRowContent(TransferActivity(pending: PendingUpload(driveId: "d", path: "/a.txt", bytes: 100), transfer: nil))
        #expect(waiting.status.hasPrefix("Waiting to upload · ") && waiting.progress == .none)

        let queued = PendingUpload(driveId: "d", path: "/a.txt", bytes: 100, phase: "uploading", bytesSent: 25, bytesTotal: 100)
        #expect(ActivityRowContent(TransferActivity(pending: queued, transfer: nil)).progress == .fraction(0.25))

        let failedRetry = ActivityRowContent(TransferActivity(pending: PendingUpload(driveId: "d", path: "/a.txt", bytes: 100), transfer: transfer(.failed)))
        #expect(failedRetry.failed && failedRetry.status == "Upload failed")

        // The per-drive aggregate has no meaningful byte count of its own.
        let aggregate = ActivityRowContent(TransferActivity(pending: nil, transfer: transfer(.queued, path: "/", done: 0, total: 6000)))
        #expect(aggregate.title == "Drive changes" && aggregate.status == "Waiting to upload")
    }

    @Test func formattingClampsAndPluralizes() {
        #expect(Format.percent(0.999) == "99%")
        #expect(Format.percent(1.4) == "100%")
        #expect(Format.percent(-1) == "0%")
        #expect(Format.count(1, "drive", "drives") == "1 drive")
        #expect(Format.count(0, "drive", "drives") == "0 drives")
        #expect(Format.bytes(-5) == Format.bytes(0))
    }

    @Test func bannerExplainsEachEngineStateInWords() {
        let states: [EngineInstallState] = [.notInstalled, .notRegistered, .requiresApproval, .enabled, .failed("Launch agent rejected")]
        let texts = states.map(StatusBanner.engineText)
        #expect(Set(texts).count == states.count)
        #expect(texts.last == "Launch agent rejected")
    }
}
