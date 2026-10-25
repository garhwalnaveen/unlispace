import Testing
import Foundation
@testable import UnlispaceKit

@Suite struct PKCETests {
    @Test func rfc7636Vector() {
        // RFC 7636 appendix B
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        #expect(PKCE.challenge(forVerifier: verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func verifierShapeAndUniqueness() {
        let a = PKCE.makeVerifier(), b = PKCE.makeVerifier()
        #expect(a.count == 43)
        #expect(a != b)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        #expect(a.unicodeScalars.allSatisfy { allowed.contains($0) })
    }

    @Test func callbackParsing() throws {
        let url = URL(string: "uls://auth/callback#code=abc123&state=xyz")!
        let cb = try CallbackParser.parse(url, expectedState: "xyz")
        #expect(cb.code == "abc123")
        #expect(cb.state == "xyz")
    }

    @Test func stateMismatchRejected() {
        let url = URL(string: "uls://auth/callback#code=abc123&state=evil")!
        #expect(throws: AuthError.stateMismatch) { try CallbackParser.parse(url, expectedState: "xyz") }
    }

    @Test func missingStateRejected() {
        let url = URL(string: "uls://auth/callback#code=abc123")!
        #expect(throws: AuthError.stateMismatch) { try CallbackParser.parse(url, expectedState: "xyz") }
    }

    @Test func wrongHostOrNoFragmentRejected() {
        #expect(throws: AuthError.invalidCallback) {
            try CallbackParser.parse(URL(string: "uls://other/callback#code=a&state=s")!, expectedState: "s")
        }
        #expect(throws: AuthError.invalidCallback) {
            try CallbackParser.parse(URL(string: "uls://auth/callback?code=a&state=s")!, expectedState: "s")
        }
    }

    @Test func missingCodeAndProviderError() {
        #expect(throws: AuthError.missingCode) {
            try CallbackParser.parse(URL(string: "uls://auth/callback#state=s")!, expectedState: "s")
        }
        #expect(throws: AuthError.providerError("access_denied")) {
            try CallbackParser.parse(URL(string: "uls://auth/callback#error=access_denied&state=s")!, expectedState: "s")
        }
    }
}
