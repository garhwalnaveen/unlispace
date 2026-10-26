import Foundation
import Testing
@testable import UnlispaceKit

private final class SignInProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.path == "/waiting" { return }
        let status = request.url?.path == "/denied" ? 403 : 200
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("Sign in".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite @MainActor struct SignInServiceTests {
    private func auth() -> DesktopAuth {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SignInProtocol.self]
        return DesktopAuth(session: URLSession(configuration: config))
    }
    @Test func reachableServiceAndHttpFailure() async throws {
        try await auth().checkSignInService(url: URL(string: "http://127.0.0.1/ready")!)
        await #expect(throws: AuthError.startFailed(403)) {
            try await auth().checkSignInService(url: URL(string: "http://127.0.0.1/denied")!)
        }
    }
    @Test func cancellingServiceCheckDoesNotWaitForBrowserOrTimeout() async {
        let auth = auth()
        let task = Task { try await auth.checkSignInService(url: URL(string: "http://127.0.0.1/waiting")!) }
        await Task.yield()
        task.cancel()
        do {
            try await task.value
            Issue.record("Cancelled sign-in preparation must throw")
        } catch {
            #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
    }
}
