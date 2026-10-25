import Testing
import Foundation
@testable import UnlispaceKit

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

    @Test func endpointValidation() {
        #expect(AppSettings.validateEndpoint("https://api.example.com") != nil)
        #expect(AppSettings.validateEndpoint("http://localhost:8787") != nil)
        #expect(AppSettings.validateEndpoint("http://example.com") == nil)
        #expect(AppSettings.validateEndpoint("nonsense") == nil)
    }
}
