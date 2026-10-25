import Foundation
import CryptoKit
import Security

public enum PKCE {
    /// Base64url without padding (RFC 7636 appendix A).
    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func randomString(byteCount: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let rc = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(rc == errSecSuccess, "SecRandomCopyBytes failed")
        return base64URL(Data(bytes))
    }

    public static func makeVerifier() -> String { randomString(byteCount: 32) } // 43 chars

    public static func challenge(forVerifier verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    public static func makeState() -> String { randomString(byteCount: 16) }
}
