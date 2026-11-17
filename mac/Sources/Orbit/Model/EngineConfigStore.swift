import Observation
import OrbitKit

/// Settings the engine enforces: upload speed, cache size, and the developer endpoint.
@MainActor @Observable
final class EngineConfigStore {
    /// Engine-reported upload limit in bytes per second (0 is unlimited). Nil when the engine does not report it.
    var uploadBandwidthBps: Int64?
    /// True once the engine has rejected the setting; the control is then disabled.
    private(set) var uploadLimitUnsupported = false
    private(set) var uploadLimitError: String?

    @ObservationIgnored private let engine: EngineLink
    @ObservationIgnored private let session: SessionStore

    init(engine: EngineLink, session: SessionStore) {
        self.engine = engine
        self.session = session
    }

    func setUploadLimit(_ bps: Int64) {
        guard let client = engine.client, !uploadLimitUnsupported else { return }
        Task {
            do {
                try await client.setConfig(DaemonConfig(uploadBandwidthBps: bps))
                uploadBandwidthBps = bps
                uploadLimitError = nil
            } catch {
                if UploadLimit.isUnsupported(error) { uploadLimitUnsupported = true }
                else { uploadLimitError = "Could not change the upload limit: \(LogFormat.describe(error))" }
            }
            await engine.refresh()
        }
    }

    func setCacheLimit(gigabytes: Int) {
        AppSettings.cacheCapGB = gigabytes
        guard let client = engine.client else { return }
        let config = DaemonConfig(cacheCapBytes: AppSettings.cacheCapBytes)
        Task { try? await client.setConfig(config) }
    }

    /// Developer path: sends the endpoint and static token to the engine. The token is never logged.
    func pushDeveloperConfig() {
        guard let client = engine.client else { return }
        let config = DaemonConfig(endpoint: AppSettings.endpoint, token: session.devToken, cacheCapBytes: AppSettings.cacheCapBytes)
        Task {
            try? await client.setConfig(config)
            await engine.refresh()
        }
    }
}
