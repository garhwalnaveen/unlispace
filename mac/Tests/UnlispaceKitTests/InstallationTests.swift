import Foundation
import ServiceManagement
import Testing
@testable import UnlispaceKit

@Suite struct InstallationTests {
    @Test func freshBundleCanEnableEngineAndMissingFilesAreDistinct() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Unlispace-install-\(UUID().uuidString).app")
        defer { try? FileManager.default.removeItem(at: root) }
        let macOS = root.appendingPathComponent("Contents/MacOS")
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
        let info = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "com.unlispace.install-tests", "CFBundleName": "Installation test", "CFBundleVersion": "1"], format: .xml, options: 0)
        try info.write(to: root.appendingPathComponent("Contents/Info.plist"))
        let bundle = try #require(Bundle(url: root))
        #expect(DaemonLifecycle.state(bundle: bundle, serviceStatus: .notFound) == .notInstalled)
        let binary = macOS.appendingPathComponent("ulsd")
        #expect(FileManager.default.createFile(atPath: binary.path, contents: Data(), attributes: [.posixPermissions: 0o700]))
        if case .failed = DaemonLifecycle.state(bundle: bundle, serviceStatus: .notFound) {} else {
            Issue.record("Missing service declaration must be distinct from missing engine")
        }
        let directory = root.appendingPathComponent("Contents/Library/LaunchAgents")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data().write(to: directory.appendingPathComponent(DaemonLifecycle.plistName))
        #expect(DaemonLifecycle.state(bundle: bundle, serviceStatus: .notFound) == .notRegistered)
        #expect(DaemonLifecycle.state(bundle: bundle, serviceStatus: .notRegistered) == .notRegistered)
        #expect(DaemonLifecycle.state(bundle: bundle, serviceStatus: .requiresApproval) == .requiresApproval)
        #expect(DaemonLifecycle.state(bundle: bundle, serviceStatus: .enabled) == .enabled)
    }
}
