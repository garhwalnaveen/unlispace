import Foundation
import Security

public enum KeychainError: Error, Equatable, Sendable {
    case unexpectedStatus(OSStatus)
    case invalidData
}

/// Thin wrapper over SecItem* for generic passwords. Values are never logged.
public struct Keychain: Sendable {
    public static let defaultService = "com.unlispace.app"

    public enum Account {
        public static let devToken = "dev-token"
        public static let refreshToken = "refresh-token"
    }

    public let service: String
    public init(service: String = Keychain.defaultService) { self.service = service }

    private func baseQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func set(_ value: String, account: String) throws {
        let data = Data(value.utf8)
        var query = baseQuery(account)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let add = SecItemAdd(query as CFDictionary, nil)
            guard add == errSecSuccess else {
                Log.keychain.error("keychain add failed: \(add)")
                throw KeychainError.unexpectedStatus(add)
            }
        default:
            Log.keychain.error("keychain update failed: \(status)")
            throw KeychainError.unexpectedStatus(status)
        }
    }

    public func get(account: String) throws -> String? {
        var query = baseQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else {
            throw KeychainError.invalidData
        }
        return s
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
