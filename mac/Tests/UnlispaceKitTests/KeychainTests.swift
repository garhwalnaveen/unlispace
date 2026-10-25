import Testing
import Foundation
@testable import UnlispaceKit

@Suite(.serialized) struct KeychainTests {
    @Test func roundTrip() throws {
        let kc = Keychain(service: "com.unlispace.app.tests.\(UUID().uuidString)")
        let account = "test-account"
        defer { try? kc.delete(account: account) }

        #expect(try kc.get(account: account) == nil)
        try kc.set("secret-1", account: account)
        #expect(try kc.get(account: account) == "secret-1")
        try kc.set("secret-2", account: account) // update path
        #expect(try kc.get(account: account) == "secret-2")
        try kc.delete(account: account)
        #expect(try kc.get(account: account) == nil)
        try kc.delete(account: account) // idempotent
    }
}
