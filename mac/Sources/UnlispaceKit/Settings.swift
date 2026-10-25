import Foundation

/// Non-secret preferences live in UserDefaults; tokens only in Keychain.
public struct AppSettings: Sendable {
    public static let endpointKey = "endpoint"
    public static let cacheCapKey = "cacheCapGB"
    public static let defaultCacheCapGB = 20

    public static var endpoint: String {
        get { UserDefaults.standard.string(forKey: endpointKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: endpointKey) }
    }

    public static var cacheCapGB: Int {
        get {
            let v = UserDefaults.standard.integer(forKey: cacheCapKey)
            return v > 0 ? v : defaultCacheCapGB
        }
        set { UserDefaults.standard.set(max(1, newValue), forKey: cacheCapKey) }
    }

    public static var cacheCapBytes: Int64 { Int64(cacheCapGB) * 1_000_000_000 }

    /// Validates an endpoint string: https, or http only for loopback dev.
    public static func validateEndpoint(_ s: String) -> URL? {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespaces)),
              let scheme = u.scheme?.lowercased(), let host = u.host, !host.isEmpty else { return nil }
        if scheme == "https" { return u }
        if scheme == "http", ["localhost", "127.0.0.1", "::1"].contains(host) { return u }
        return nil
    }
}
