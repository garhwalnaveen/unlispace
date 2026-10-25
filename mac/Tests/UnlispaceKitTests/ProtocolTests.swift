import Testing
import Foundation
@testable import UnlispaceKit

@Suite struct ProtocolTests {
    private func json(_ d: Data) -> String { String(decoding: d, as: UTF8.self) }

    @Test func encodeStatusRequest() throws {
        let d = try DaemonCodec.encodeRequest(id: 1, method: "status")
        #expect(json(d) == #"{"id":1,"method":"status"}"#)
    }

    @Test func encodeMountRequest() throws {
        struct P: Encodable { var driveId: String }
        let d = try DaemonCodec.encodeRequest(id: 7, method: "drive.mount", params: P(driveId: "d1"))
        #expect(json(d) == #"{"id":7,"method":"drive.mount","params":{"driveId":"d1"}}"#)
    }

    @Test func decodeStatusResponse() throws {
        let line = Data(#"{"id":1,"result":{"version":"0.1.0","state":"syncing","pendingOps":3}}"#.utf8)
        guard case .response(let r) = try DaemonCodec.decodeServerLine(line) else { Issue.record("expected response"); return }
        #expect(r.id == 1)
        let st = try #require(r.result).decode(DaemonStatus.self)
        #expect(st == DaemonStatus(version: "0.1.0", state: .syncing, pendingOps: 3))
    }

    @Test func decodeErrorResponse() throws {
        let line = Data(#"{"id":2,"error":{"code":"no_such_drive","message":"nope"}}"#.utf8)
        guard case .response(let r) = try DaemonCodec.decodeServerLine(line) else { Issue.record("expected response"); return }
        #expect(r.error == DaemonError(code: "no_such_drive", message: "nope"))
        #expect(r.result == nil)
    }

    @Test func decodeDrivesList() throws {
        let line = Data(#"{"id":3,"result":{"drives":[{"driveId":"a","name":"A","mountState":"mounted","mountPath":"/Volumes/A"}]}}"#.utf8)
        guard case .response(let r) = try DaemonCodec.decodeServerLine(line) else { Issue.record(); return }
        struct R: Decodable { var drives: [DriveInfo] }
        let drives = try #require(r.result).decode(R.self).drives
        #expect(drives == [DriveInfo(driveId: "a", name: "A", mountState: .mounted, mountPath: "/Volumes/A")])
    }

    @Test func decodeTransferEvent() throws {
        let line = Data(#"{"event":"transfer","data":{"id":"t1","driveId":"a","path":"/x.bin","direction":"upload","bytesDone":10,"bytesTotal":100,"status":"active"}}"#.utf8)
        guard case .event(.transfer(let t)) = try DaemonCodec.decodeServerLine(line) else { Issue.record(); return }
        #expect(t.id == "t1" && t.direction == .upload && t.bytesDone == 10 && t.bytesTotal == 100 && t.status == .active)
    }

    @Test func decodeChangeEvent() throws {
        let line = Data(#"{"event":"change","data":{"driveId":"a","seq":42,"paths":["/a","/b"]}}"#.utf8)
        guard case .event(.change(let c)) = try DaemonCodec.decodeServerLine(line) else { Issue.record(); return }
        #expect(c == ChangeEvent(driveId: "a", seq: 42, paths: ["/a", "/b"]))
    }

    @Test func decodeStateEventAndUnknown() throws {
        let s = Data(#"{"event":"state","data":{"state":"offline","message":"no network"}}"#.utf8)
        guard case .event(.state(let e)) = try DaemonCodec.decodeServerLine(s) else { Issue.record(); return }
        #expect(e == StateEvent(state: .offline, message: "no network"))

        let u = Data(#"{"event":"future","data":{}}"#.utf8)
        #expect(try DaemonCodec.decodeServerLine(u) == .event(.unknown(name: "future")))
    }

    @Test func malformedRejected() {
        #expect(throws: DaemonCodecError.malformed) { try DaemonCodec.decodeServerLine(Data("not json".utf8)) }
        #expect(throws: DaemonCodecError.malformed) { try DaemonCodec.decodeServerLine(Data(#"{"foo":1}"#.utf8)) }
    }

    @Test func lineBufferSplitsAcrossChunks() {
        var lb = LineBuffer()
        #expect(lb.append(Data("{\"a\":1}\n{\"b\"".utf8)).count == 1)
        let rest = lb.append(Data(":2}\n".utf8))
        #expect(rest.count == 1)
        #expect(String(decoding: rest[0], as: UTF8.self) == "{\"b\":2}")
    }

    @Test func mockClientBasics() async throws {
        let m = MockDaemonClient()
        #expect(try await m.listDrives().count == 2)
        try await m.mount(driveId: "demo")
        let d = try await m.listDrives().first { $0.driveId == "demo" }
        #expect(d?.mountState == .mounted)
        await #expect(throws: DaemonClientError.self) { try await m.mount(driveId: "nope") }
    }

    @Test func realClientWithoutSocketReportsMissing() async {
        let c = UnixSocketDaemonClient(socketPath: "/tmp/definitely-not-here-\(UUID().uuidString).sock")
        await #expect(throws: DaemonClientError.socketMissing) { try await c.connect() }
    }
}
