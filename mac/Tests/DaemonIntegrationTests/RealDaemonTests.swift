import Darwin
import Foundation
import Testing
import UnlispaceKit

@Suite struct RealDaemonTests {
    @Test func isolatedDaemonRoundTrip() async throws {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let binary = repo.appendingPathComponent("engine/target/debug/ulsd")
        try #require(FileManager.default.isExecutableFile(atPath: binary.path),
                     "Build engine/target/debug/ulsd before running the mac gates.")
        let home = URL(fileURLWithPath: "/tmp/uls-mac-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let support = home.appendingPathComponent("Library/Application Support/Unlispace")
        let socket = support.appendingPathComponent("ulsd.sock")
        let daemon = Process()
        daemon.executableURL = binary
        daemon.arguments = ["daemon"]
        // Do not inherit dev tokens, endpoints or a user's persisted session.
        daemon.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin", "RUST_LOG": "error"]
        daemon.standardOutput = FileHandle.nullDevice
        daemon.standardError = FileHandle.nullDevice
        try daemon.run()
        let watchdog = DispatchWorkItem {
            if daemon.isRunning { kill(daemon.processIdentifier, SIGKILL) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 15, execute: watchdog)
        defer {
            watchdog.cancel()
            if daemon.isRunning { daemon.terminate() }
            daemon.waitUntilExit()
        }

        let client = UnixSocketDaemonClient(socketPath: socket.path)
        var events = client.events().makeAsyncIterator()
        do {
            var connected = false
            for _ in 0..<100 {
                try #require(daemon.isRunning, "ulsd exited before the isolated socket became ready")
                if (try? await client.connect()) != nil { connected = true; break }
                try await Task.sleep(for: .milliseconds(50))
            }
            try #require(connected, "ulsd did not bind the temporary HOME socket")
            #expect(await events.next() == .state(StateEvent(state: .signedOut)))
            let initial = try await client.status()
            #expect(initial.state == .signedOut)
            #expect(!initial.version.isEmpty)
            await #expect(throws: DaemonClientError.remote(DaemonError(code: "unauthorized", message: "not signed in"))) {
                _ = try await client.listDrives()
            }
            await #expect(throws: DaemonClientError.remote(DaemonError(code: "bad_request", message: "cacheCapBytes must not be negative"))) {
                try await client.setConfig(DaemonConfig(cacheCapBytes: -1))
            }
            try await client.setConfig(DaemonConfig(endpoint: "http://127.0.0.1:1", token: "local-test-only", cacheCapBytes: 4_194_304))
            let persisted = try Data(contentsOf: support.appendingPathComponent("state.json"))
            let state = try #require(JSONSerialization.jsonObject(with: persisted) as? [String: Any])
            #expect(state["cacheCapBytes"] as? Int == 4_194_304)
            #expect(!String(decoding: persisted, as: UTF8.self).contains("local-test-only"))
            // Dev mode lists remembered mounts locally; an empty HOME means no network calls.
            #expect(try await client.listDrives().isEmpty)
            #expect(try await client.status().state == .idle)
            #expect(try await client.transfers().isEmpty)
            #expect(try await client.authStatus().signedIn == false)
            await client.disconnect()
            #expect(daemon.isRunning)
        } catch {
            await client.disconnect()
            throw error
        }
    }
}
