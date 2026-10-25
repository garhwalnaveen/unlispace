import os

/// Central loggers. Never pass tokens, codes or verifiers to these.
public enum Log {
    public static let subsystem = "com.unlispace.app"
    public static let app = Logger(subsystem: subsystem, category: "app")
    public static let daemon = Logger(subsystem: subsystem, category: "daemon")
    public static let auth = Logger(subsystem: subsystem, category: "auth")
    public static let keychain = Logger(subsystem: subsystem, category: "keychain")
}
