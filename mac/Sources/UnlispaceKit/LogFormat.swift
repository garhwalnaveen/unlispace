import Foundation

/// Helpers every log line / user-visible error string goes through, so tokens, codes and
/// verifiers cannot leak even if an error value happens to carry them.
public enum LogFormat {
    public static let redacted = "<redacted>"

    private static let rules: [(pattern: String, template: String)] = [
        // JWT (access / drive tokens)
        (#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"#, "<jwt>"),
        // opaque refresh token: rt_ + base64url
        (#"rt_[A-Za-z0-9_-]{16,}"#, "rt_<redacted>"),
        (#"(?i)bearer\s+[^\s"']+"#, "Bearer <redacted>"),
        // key=value pairs (URL query / fragment)
        (#"(?i)\b(code|code_verifier|codeVerifier|code_challenge|token|access_token|refresh_token|state)=([^&\s"']+)"#, "$1=<redacted>"),
        // JSON members
        (#"(?i)"(code|codeVerifier|accessToken|refreshToken|token|handoff)"\s*:\s*"[^"]*""#, #""$1":"<redacted>""#),
    ]

    /// Removes anything that looks like a credential from free text.
    public static func scrub(_ text: String) -> String {
        var out = text
        for rule in rules {
            guard let re = try? NSRegularExpression(pattern: rule.pattern) else { continue }
            out = re.stringByReplacingMatches(
                in: out, range: NSRange(out.startIndex..., in: out), withTemplate: rule.template)
        }
        return out
    }

    /// Scrubbed one-line description of an error.
    public static func describe(_ error: Error) -> String {
        switch error {
        case let e as DaemonClientError:
            if case .remote(let d) = e { return "daemon error \(d.code): \(scrub(d.message))" }
            return scrub(String(describing: e))
        default:
            return scrub(String(describing: error))
        }
    }

    /// `scheme://host/path` only: no userinfo, query or fragment (callback URLs carry the code).
    public static func url(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "<url>" }
        c.user = nil; c.password = nil; c.query = nil; c.fragment = nil
        return c.string ?? "<url>"
    }
}
