import Foundation

// Wire protocol between Unlispace.app and `ulsd`. See mac/DAEMON-PROTOCOL.md.

public enum EngineState: String, Codable, Sendable, Equatable {
    case signedOut = "signed_out"
    case idle
    case syncing
    case offline
    case error
}

public struct DaemonStatus: Codable, Sendable, Equatable {
    public var version: String
    public var state: EngineState
    public var message: String?
    public var pendingOps: Int?

    public init(version: String, state: EngineState, message: String? = nil, pendingOps: Int? = nil) {
        self.version = version
        self.state = state
        self.message = message
        self.pendingOps = pendingOps
    }
}

public enum MountState: String, Codable, Sendable, Equatable {
    case unmounted, mounting, mounted, unmounting, error
}

public struct DriveInfo: Codable, Sendable, Equatable, Identifiable {
    public var driveId: String
    public var name: String
    public var mountState: MountState
    public var mountPath: String?
    public var id: String { driveId }

    public init(driveId: String, name: String, mountState: MountState, mountPath: String? = nil) {
        self.driveId = driveId
        self.name = name
        self.mountState = mountState
        self.mountPath = mountPath
    }
}

public enum TransferDirection: String, Codable, Sendable, Equatable {
    case upload, download
}

public enum TransferStatus: String, Codable, Sendable, Equatable {
    case queued, active, done, failed
}

public struct TransferInfo: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var driveId: String
    public var path: String
    public var direction: TransferDirection
    public var bytesDone: Int64
    public var bytesTotal: Int64
    public var status: TransferStatus

    public init(id: String, driveId: String, path: String, direction: TransferDirection,
                bytesDone: Int64, bytesTotal: Int64, status: TransferStatus) {
        self.id = id; self.driveId = driveId; self.path = path; self.direction = direction
        self.bytesDone = bytesDone; self.bytesTotal = bytesTotal; self.status = status
    }

    public var isFinished: Bool { status == .done || status == .failed }

    public var progress: Double? {
        guard bytesTotal > 0 else { return nil }
        return min(1, max(0, Double(bytesDone) / Double(bytesTotal)))
    }
}

/// Daemon conflict event. `copy` is the preserved local edit.
public struct ConflictEvent: Codable, Sendable, Equatable {
    public var driveId: String
    public var path: String
    public var copy: String
}

public struct ChangeEvent: Codable, Sendable, Equatable {
    public var driveId: String
    public var seq: Int64
    public var paths: [String]
    public init(driveId: String, seq: Int64, paths: [String]) {
        self.driveId = driveId; self.seq = seq; self.paths = paths
    }
}

public struct StateEvent: Codable, Sendable, Equatable {
    public var state: EngineState
    public var message: String?
    public init(state: EngineState, message: String? = nil) {
        self.state = state; self.message = message
    }
}

/// Payload of the `config.set` request (app -> daemon).
public struct DaemonConfig: Codable, Sendable, Equatable {
    public var endpoint: String?
    public var token: String?
    public var cacheCapBytes: Int64?
    public init(endpoint: String? = nil, token: String? = nil, cacheCapBytes: Int64? = nil) {
        self.endpoint = endpoint; self.token = token; self.cacheCapBytes = cacheCapBytes
    }
}

/// Server-push events.
public enum DaemonEvent: Sendable, Equatable {
    case transfer(TransferInfo)
    case change(ChangeEvent)
    case state(StateEvent)
    case conflict(ConflictEvent)
    case pin(OfflinePin)
    case unknown(name: String)
}

public struct DaemonError: Codable, Sendable, Equatable, Error {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

public struct DaemonResponse: Codable, Sendable, Equatable {
    public var id: Int
    public var result: JSONValue?
    public var error: DaemonError?
}

public enum ServerMessage: Sendable, Equatable {
    case response(DaemonResponse)
    case event(DaemonEvent)
}

public enum DaemonCodecError: Error, Equatable {
    case malformed
}

/// Newline-delimited JSON codec.
public enum DaemonCodec {
    private struct Request<P: Encodable>: Encodable {
        var id: Int
        var method: String
        var params: P?
    }
    private struct Empty: Encodable {}
    private struct Envelope: Decodable {
        var id: Int?
        var event: String?
        var data: JSONValue?
        var result: JSONValue?
        var error: DaemonError?
    }

    private static func makeEncoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }

    /// Encodes one request line (without trailing newline).
    public static func encodeRequest<P: Encodable>(id: Int, method: String, params: P?) throws -> Data {
        try makeEncoder().encode(Request(id: id, method: method, params: params))
    }

    public static func encodeRequest(id: Int, method: String) throws -> Data {
        try encodeRequest(id: id, method: method, params: Optional<Empty>.none)
    }

    public static func decodeServerLine(_ line: Data) throws -> ServerMessage {
        let env: Envelope
        do { env = try JSONDecoder().decode(Envelope.self, from: line) }
        catch { throw DaemonCodecError.malformed }

        if let name = env.event {
            let data = env.data ?? .null
            switch name {
            case "transfer": return .event(.transfer(try data.decode(TransferInfo.self)))
            case "change": return .event(.change(try data.decode(ChangeEvent.self)))
            case "state": return .event(.state(try data.decode(StateEvent.self)))
            case "pin": return .event(.pin(try data.decode(OfflinePin.self)))
            case "conflict": return .event(.conflict(try data.decode(ConflictEvent.self)))
            default: return .event(.unknown(name: name))
            }
        }
        guard let id = env.id else { throw DaemonCodecError.malformed }
        return .response(DaemonResponse(id: id, result: env.result, error: env.error))
    }
}

/// Splits a byte stream into newline-delimited lines.
public struct LineBuffer: Sendable {
    private var buffer = Data()
    public init() {}

    public mutating func append(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let idx = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<idx]
            if !line.isEmpty { lines.append(Data(line)) }
            buffer = Data(buffer[buffer.index(after: idx)...])
        }
        return lines
    }
}
