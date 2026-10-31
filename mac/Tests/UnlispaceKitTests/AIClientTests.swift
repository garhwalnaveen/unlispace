import Foundation
import Testing
@testable import UnlispaceKit

private final class AIProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        if path == "/waiting" { return }
        let status = path == "/denied" ? 401 : path == "/redirect" ? 307 : 200
        let headers = path == "/oversized" ? ["Content-Length": "3000000"] : [:]
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body = path == "/invalid" ? "{\"error\":\"private provider diagnostic with secret-key\"}" : "{\"choices\":[{\"message\":{\"content\":\"Answer from supplied text.\"}}]}"
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite struct AIClientTests {
    private func config(_ path: String = "/chat/completions") throws -> AIConfiguration {
        try AIConfiguration(endpoint: "https://provider.example\(path)", model: "chosen-model")
    }
    private var client: AIClient { AIClient(protocolClasses: [AIProtocol.self]) }
    private var prompt: [AIMessage] { [AIMessage(role: .user, content: "Summarize my selected text.")] }

    @Test func validatesEndpointModelAndCredentialScope() throws {
        for endpoint in ["http://remote.example/v1", "https://user:password@example.com/v1", "https://example.com/v1?api_key=x", "https://example.com/v1#key", "file:///tmp/a", "https:///path"] {
            #expect(AIConfiguration.validEndpoint(endpoint) == nil)
        }
        #expect(AIConfiguration.validEndpoint("http://127.0.0.1:1234/v1/chat/completions") != nil)
        #expect(AIConfiguration.validEndpoint("http://localhost:11434/v1/chat/completions") != nil)
        #expect(AIConfiguration.validEndpoint("http://api.openai.com/v1/chat/completions") == nil)
        #expect(AIConfiguration.validEndpoint("http://localhost.evil.example/v1") == nil)
        for preset in AIProviderPreset.allCases { if let e = preset.endpoint { #expect(AIConfiguration.validEndpoint(e) != nil) } }
        #expect(AIProviderPreset.matching(endpoint: "https://openrouter.ai/api/v1/chat/completions") == .openRouter)
        #expect(AIProviderPreset.matching(endpoint: "https://x.example/v1") == .custom)
        #expect(AIConfiguration.validEndpoint("http://[::1]:1234/v1/chat/completions") != nil)
        #expect(throws: AIError.missingModel) { try AIConfiguration(endpoint: "https://provider.example/chat", model: " ") }
        #expect(try config().keychainAccount == config().keychainAccount)
        #expect(try config("/other").keychainAccount != config().keychainAccount)
        #expect(try !config().keychainAccount.contains("provider.example"))
    }

    @Test func requestUsesConfiguredProviderAndNoHiddenFileData() throws {
        let request = try client.request(configuration: config(), key: "secret-key", messages: prompt)
        #expect(request.url?.absoluteString == "https://provider.example/chat/completions")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret-key")
        let body = try #require(request.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["model"] as? String == "chosen-model")
        #expect(json["stream"] as? Bool == false)
        let messages = try #require(json["messages"] as? [[String: String]])
        #expect(messages.count == 2)
        #expect(messages[0]["role"] == "system")
        #expect(messages[1] == ["role": "user", "content": "Summarize my selected text."])
        #expect(!String(decoding: body, as: UTF8.self).contains("secret-key"))
        #expect(throws: AIError.missingKey) { try client.request(configuration: config(), key: "\n", messages: prompt) }
        #expect(throws: AIError.requestTooLarge) {
            try client.request(configuration: config(), key: "key", messages: [AIMessage(role: .user, content: String(repeating: "x", count: AIClient.maxRequestBytes))])
        }
        #expect(throws: AIError.requestTooLarge) {
            try client.request(configuration: config(), key: "key", messages: Array(repeating: prompt[0], count: AIClient.maxMessages + 1))
        }
    }

    @Test func parsesTextAndSanitizesFailures() async throws {
        #expect(try await client.complete(configuration: config("/ok"), key: "secret-key", messages: prompt) == "Answer from supplied text.")
        await #expect(throws: AIError.provider(401)) {
            try await client.complete(configuration: config("/denied"), key: "secret-key", messages: prompt)
        }
        await #expect(throws: AIError.provider(307)) {
            try await client.complete(configuration: config("/redirect"), key: "secret-key", messages: prompt)
        }
        await #expect(throws: AIError.responseTooLarge) {
            try await client.complete(configuration: config("/oversized"), key: "secret-key", messages: prompt)
        }
        await #expect(throws: AIError.invalidResponse) {
            try await client.complete(configuration: config("/invalid"), key: "secret-key", messages: prompt)
        }
        #expect(!AIError.invalidResponse.localizedDescription.contains("private provider"))
        #expect(!AIError.provider(401).localizedDescription.contains("secret-key"))
    }

    @Test func refusesCredentialBearingRedirect() async throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let request = URLRequest(url: URL(string: "https://other.example/")!)
        let response = HTTPURLResponse(url: try config().endpoint, statusCode: 307, httpVersion: nil, headerFields: ["Location": request.url!.absoluteString])!
        let refused = await withCheckedContinuation { continuation in
            AIRejectRedirects().urlSession(session, task: session.dataTask(with: request), willPerformHTTPRedirection: response, newRequest: request) { next in
                continuation.resume(returning: next == nil)
            }
        }
        #expect(refused)
    }

    @Test func cancellingRequestReturnsPromptly() async throws {
        let configuration = try config("/waiting")
        let client = client
        let messages = prompt
        let task = Task { try await client.complete(configuration: configuration, key: "secret-key", messages: messages) }
        await Task.yield()
        task.cancel()
        do { _ = try await task.value; Issue.record("Cancelled request must throw") }
        catch { #expect(error is CancellationError) }
    }

    @Test func attachmentsAreExplicitBoundedUTF8() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("notes.txt")
        try Data("The final result is 42.".utf8).write(to: url)
        let attachment = try AITextAttachment.read(url)
        #expect(attachment.name == "notes.txt")
        #expect(attachment.message(for: "What is the result?").contains("The final result is 42."))
        try Data(repeating: 120, count: AITextAttachment.maxBytes + 1).write(to: url)
        #expect(throws: AIError.requestTooLarge) { try AITextAttachment.read(url) }
        try Data([0xff, 0xfe, 0]).write(to: url)
        #expect(throws: AIError.invalidResponse) { try AITextAttachment.read(url) }
    }
}
