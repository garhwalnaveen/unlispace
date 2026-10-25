import Foundation
import Darwin

/// Real `DaemonClient`: newline-delimited JSON over an AF_UNIX stream socket.
/// A dedicated thread performs blocking reads; writes are serialized by a lock.
public final class UnixSocketDaemonClient: DaemonClient, @unchecked Sendable {
    private let path: String
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<DaemonResponse, Error>] = [:]
    private var subscribers: [UUID: AsyncStream<DaemonEvent>.Continuation] = [:]

    public init(socketPath: String = AppPaths.socketURL.path) {
        self.path = socketPath
    }

    deinit { closeSocket() }

    public func connect() async throws {
        if lock.withLock({ fd >= 0 }) { return }

        guard FileManager.default.fileExists(atPath: path) else { throw DaemonClientError.socketMissing }

        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { throw DaemonClientError.connectFailed(String(cString: strerror(errno))) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < maxLen else {
            close(s)
            throw DaemonClientError.connectFailed("socket path too long")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            _ = path.withCString { strncpy(raw.baseAddress!.assumingMemoryBound(to: CChar.self), $0, maxLen - 1) }
        }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            let msg = String(cString: strerror(errno))
            close(s)
            throw DaemonClientError.connectFailed(msg)
        }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

        lock.withLock { fd = s }

        let thread = Thread { [weak self] in self?.readLoop(fd: s) }
        thread.name = "com.unlispace.daemon-reader"
        thread.start()
        Log.daemon.info("connected to daemon socket")
    }

    public func disconnect() async {
        closeSocket()
    }

    private func closeSocket() {
        lock.lock()
        let s = fd
        fd = -1
        let waiting = pending
        pending = [:]
        let subs = subscribers
        subscribers = [:]
        lock.unlock()
        if s >= 0 { shutdown(s, SHUT_RDWR); close(s) }
        for (_, c) in waiting { c.resume(throwing: DaemonClientError.disconnected) }
        for (_, c) in subs { c.finish() }
    }

    private func readLoop(fd s: Int32) {
        var lines = LineBuffer()
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let n = read(s, &chunk, chunk.count)
            if n <= 0 { break }
            for line in lines.append(Data(chunk[0..<n])) { handle(line) }
        }
        lock.lock()
        let stillCurrent = (fd == s)
        lock.unlock()
        if stillCurrent {
            Log.daemon.info("daemon connection closed")
            closeSocket()
        }
    }

    private func handle(_ line: Data) {
        guard let msg = try? DaemonCodec.decodeServerLine(line) else {
            Log.daemon.error("dropping malformed daemon line")
            return
        }
        switch msg {
        case .response(let r):
            lock.lock()
            let cont = pending.removeValue(forKey: r.id)
            lock.unlock()
            cont?.resume(returning: r)
        case .event(let e):
            lock.lock()
            let subs = Array(subscribers.values)
            lock.unlock()
            for s in subs { s.yield(e) }
        }
    }

    private func call<P: Encodable>(_ method: String, params: P?) async throws -> JSONValue {
        let response: DaemonResponse = try await withCheckedThrowingContinuation { cont in
            lock.lock()
            guard fd >= 0 else {
                lock.unlock()
                cont.resume(throwing: DaemonClientError.notConnected)
                return
            }
            let id = nextId
            nextId += 1
            let s = fd
            pending[id] = cont
            lock.unlock()

            do {
                var data = try DaemonCodec.encodeRequest(id: id, method: method, params: params)
                data.append(0x0A)
                try writeAll(data, to: s)
            } catch {
                lock.lock()
                let c = pending.removeValue(forKey: id)
                lock.unlock()
                c?.resume(throwing: error)
            }
        }
        if let err = response.error { throw DaemonClientError.remote(err) }
        return response.result ?? .null
    }

    private func writeAll(_ data: Data, to s: Int32) throws {
        try data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var off = 0
            while off < buf.count {
                let n = write(s, buf.baseAddress! + off, buf.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    throw DaemonClientError.disconnected
                }
                off += n
            }
        }
    }

    private struct DriveParams: Encodable { var driveId: String }
    private struct Nothing: Encodable {}
    private struct DrivesResult: Decodable { var drives: [DriveInfo] }
    private struct TransfersResult: Decodable { var transfers: [TransferInfo] }

    public func status() async throws -> DaemonStatus {
        try await call("status", params: Nothing?.none).decode(DaemonStatus.self)
    }
    public func listDrives() async throws -> [DriveInfo] {
        try await call("drives.list", params: Nothing?.none).decode(DrivesResult.self).drives
    }
    public func mount(driveId: String) async throws {
        _ = try await call("drive.mount", params: DriveParams(driveId: driveId))
    }
    public func unmount(driveId: String) async throws {
        _ = try await call("drive.unmount", params: DriveParams(driveId: driveId))
    }
    public func transfers() async throws -> [TransferInfo] {
        try await call("transfers", params: Nothing?.none).decode(TransfersResult.self).transfers
    }
    public func setConfig(_ config: DaemonConfig) async throws {
        _ = try await call("config.set", params: config)
    }

    public func authSet(_ params: AuthSetParams) async throws -> AuthSetResult {
        try await call("auth.set", params: params).decode(AuthSetResult.self)
    }
    public func authStatus() async throws -> AuthStatus {
        try await call("auth.status", params: Nothing?.none).decode(AuthStatus.self)
    }
    public func authSignOut() async throws {
        _ = try await call("auth.signOut", params: Nothing?.none)
    }

    public func events() -> AsyncStream<DaemonEvent> {
        AsyncStream { continuation in
            let key = UUID()
            lock.lock()
            subscribers[key] = continuation
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.subscribers.removeValue(forKey: key)
                self.lock.unlock()
            }
        }
    }
}
