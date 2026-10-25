import Foundation
import ServiceManagement

public enum EngineInstallState: Sendable, Equatable {
    case notInstalled          // ulsd binary missing from the bundle
    case notRegistered
    case requiresApproval
    case enabled
    case failed(String)
}

public enum DaemonLifecycle {
    public static let plistName = "com.unlispace.ulsd.plist"

    /// Path of the bundled engine binary (`Contents/MacOS/ulsd`).
    public static func engineBinaryURL(bundle: Bundle = .main) -> URL {
        bundle.bundleURL.appendingPathComponent("Contents/MacOS/ulsd")
    }

    public static func engineBinaryExists(bundle: Bundle = .main) -> Bool {
        FileManager.default.isExecutableFile(atPath: engineBinaryURL(bundle: bundle).path)
    }

    /// Only meaningful when running from a bundled .app (not `swift run`).
    public static var isBundled: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    public static func state(bundle: Bundle = .main) -> EngineInstallState {
        guard isBundled, engineBinaryExists(bundle: bundle) else { return .notInstalled }
        switch SMAppService.agent(plistName: plistName).status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .notRegistered
        case .notFound: return .notInstalled
        @unknown default: return .failed("unknown status")
        }
    }

    /// Registers the LaunchAgent. Called only on explicit user action.
    public static func register() -> EngineInstallState {
        guard isBundled, engineBinaryExists() else { return .notInstalled }
        do {
            try SMAppService.agent(plistName: plistName).register()
        } catch {
            Log.daemon.error("agent register failed: \(error.localizedDescription)")
            return .failed(error.localizedDescription)
        }
        return state()
    }

    public static func unregister() async {
        do { try await SMAppService.agent(plistName: plistName).unregister() }
        catch { Log.daemon.error("agent unregister failed: \(error.localizedDescription)") }
    }

    public static func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

public enum LaunchAtLogin {
    public static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    public static func set(_ enabled: Bool) throws {
        let svc = SMAppService.mainApp
        if enabled { if svc.status != .enabled { try svc.register() } }
        else { try svc.unregister() }
    }
}
