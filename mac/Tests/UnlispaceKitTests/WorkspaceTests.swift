import Foundation
import Testing
@testable import UnlispaceKit

@Suite struct WorkspaceTests {
    @Test func searchPathsCannotEscapeMountedDrive() throws {
        func entry(_ path: String) throws -> FileSearchEntry {
            try JSONDecoder().decode(FileSearchEntry.self, from: JSONSerialization.data(withJSONObject: ["path":path,"type":"file","size":3]))
        }
        #expect(try entry("folder/notes.txt").localURL(mountPath: "/tmp/drive")?.path == "/tmp/drive/folder/notes.txt")
        for path in ["../secret","/etc/passwd","folder/../secret","folder/./secret","folder//secret"] {
            #expect(try entry(path).localURL(mountPath: "/tmp/drive") == nil)
        }
    }
    @Test func serverLinksRequireValidOriginAndKnownRoutes() {
        for origin in ["https://example.com", "http://localhost:5173"] {
            let config = ClientConfiguration(webOrigin: origin)
            #expect(config.page(orgId: "o_123", section: "billing")?.path == "/orgs/o_123/billing")
            #expect(config.page(orgId: "../bad", section: "team") == nil)
            #expect(config.page(orgId: "o_123", section: "unknown") == nil)
        }
        for origin in ["http://evil.example","https://u:p@example.com","https://example.com/path","https://example.com?bad"] {
            #expect(ClientConfiguration(webOrigin: origin).page(orgId: "o_123", section: "team") == nil)
        }
    }
}
