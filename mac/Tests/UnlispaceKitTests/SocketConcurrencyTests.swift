import Darwin
import Foundation
import Testing
@testable import UnlispaceKit

private enum SocketPeerError: Error { case system, closed, malformed }

/// One isolated local peer; receive deadlines bound failures without using the user's daemon.
private final class SocketPeer: @unchecked Sendable {
    let path = "/tmp/uls-socket-\(UUID().uuidString.prefix(12)).sock"
    private let listener: Int32
    private let lock = NSLock()
    private var connection: Int32 = -1
    private var stopped = false
    let finished: AsyncStream<Result<Void, SocketPeerError>>
    private let completion: AsyncStream<Result<Void, SocketPeerError>>.Continuation

    init(handler: @escaping @Sendable (Int32) throws -> Void) throws {
        let stream = AsyncStream<Result<Void, SocketPeerError>>.makeStream()
        finished = stream.stream; completion = stream.continuation
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw SocketPeerError.system }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            _ = path.withCString { strncpy(buffer.baseAddress!.assumingMemoryBound(to: CChar.self), $0, buffer.count - 1) }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(listener, 1) == 0 else { close(listener); throw SocketPeerError.system }
        Thread { [self] in
            let fd = accept(listener, nil, nil)
            guard fd >= 0 else { completion.yield(.failure(.system)); completion.finish(); return }
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            var deadline = timeval(tv_sec: 5, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size))
            let active = lock.withLock { connection = fd; return !stopped }
            defer {
                lock.withLock { connection = -1 }
                shutdown(fd, SHUT_RDWR); close(fd)
                completion.finish()
            }
            guard active else { completion.yield(.failure(.closed)); return }
            do { try handler(fd); completion.yield(.success(())) }
            catch { completion.yield(.failure((error as? SocketPeerError) ?? .malformed)) }
        }.start()
    }

    func stop() {
        let fd: Int32? = lock.withLock {
            guard !stopped else { return nil }
            stopped = true
            return connection
        }
        guard let fd else { return }
        shutdown(listener, SHUT_RDWR); close(listener)
        if fd >= 0 { shutdown(fd, SHUT_RDWR) }
        try? FileManager.default.removeItem(atPath: path)
    }

    static func receive(_ fd: Int32, pending: inout Data) throws -> [String: Any] {
        while true {
            if let end = pending.firstIndex(of: 0x0a) {
                let line = pending[..<end]
                pending.removeSubrange(...end)
                guard let json = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw SocketPeerError.malformed }
                return json
            }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = read(fd, &bytes, bytes.count)
            guard count > 0 else { throw SocketPeerError.closed }
            pending.append(contentsOf: bytes.prefix(count))
            guard pending.count < 1024 * 1024 else { throw SocketPeerError.malformed }
        }
    }

    static func reply(_ fd: Int32, id: Int, result: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: ["id": id, "result": result])
        data.append(0x0a)
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                guard count > 0 else { throw SocketPeerError.closed }
                offset += count
            }
        }
    }
}

@Suite struct SocketConcurrencyTests {
    @Test func cancellingPendingRequestDoesNotWaitForOrConsumeLateReply() async throws {
        let received = AsyncStream<Void>.makeStream()
        let peer = try SocketPeer { fd in
            defer { received.continuation.finish() }
            var buffer = Data()
            let first = try SocketPeer.receive(fd, pending: &buffer)
            guard let oldId = first["id"] as? Int else { throw SocketPeerError.malformed }
            received.continuation.yield(()); received.continuation.finish()
            Thread.sleep(forTimeInterval: 1)
            try SocketPeer.reply(fd, id: oldId, result: ["ignored": true])
            let next = try SocketPeer.receive(fd, pending: &buffer)
            guard let id = next["id"] as? Int, next["method"] as? String == "status" else { throw SocketPeerError.malformed }
            try SocketPeer.reply(fd, id: id, result: ["version": "socket-test", "state": "idle"])
        }
        defer { peer.stop() }
        let client = UnixSocketDaemonClient(socketPath: peer.path)
        try await client.connect()
        let pending = Task { try await client.apiRequest(method: "GET", path: "/orgs", body: nil) }
        var ready = received.stream.makeAsyncIterator()
        _ = await ready.next()
        let started = ContinuousClock.now
        pending.cancel()
        do { _ = try await pending.value; Issue.record("Cancellation must throw before the peer responds") }
        catch { #expect(error is CancellationError) }
        #expect(started.duration(to: .now) < .milliseconds(500))
        #expect(try await client.status() == DaemonStatus(version: "socket-test", state: .idle))
        await client.disconnect()
        var completion = peer.finished.makeAsyncIterator()
        try #require(await completion.next()).get()
    }

    @Test func concurrentLargeRequestsKeepFramesAndResponseIdsSeparate() async throws {
        let count = 12
        let length = 192 * 1024
        let peer = try SocketPeer { fd in
            var buffer = Data()
            var ids = Set<Int>()
            var requests: [(Int, Int)] = []
            for _ in 0..<count {
                let request = try SocketPeer.receive(fd, pending: &buffer)
                guard let id = request["id"] as? Int, ids.insert(id).inserted,
                      request["method"] as? String == "api.request",
                      let params = request["params"] as? [String: Any],
                      let body = params["body"] as? [String: Any],
                      let index = body["index"] as? Int, (0..<count).contains(index),
                      body["blob"] as? String == String(repeating: String(UnicodeScalar(65 + index)!), count: length)
                else { throw SocketPeerError.malformed }
                requests.append((id, index))
            }
            // Responses deliberately arrive in reverse request order.
            for (id, index) in requests.reversed() { try SocketPeer.reply(fd, id: id, result: ["index": index]) }
        }
        defer { peer.stop() }
        let client = UnixSocketDaemonClient(socketPath: peer.path)
        try await client.connect()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 0..<count {
                group.addTask {
                    let blob = String(repeating: String(UnicodeScalar(65 + index)!), count: length)
                    let result = try await client.apiRequest(method: "POST", path: "/keys", body: .object(["index": .int(index), "blob": .string(blob)]))
                    #expect(result == .object(["index": .int(index)]))
                }
            }
            try await group.waitForAll()
        }
        await client.disconnect()
        var completion = peer.finished.makeAsyncIterator()
        try #require(await completion.next()).get()
    }
}
