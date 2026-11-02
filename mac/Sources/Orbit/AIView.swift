import SwiftUI
import WebKit
import OrbitKit

/// Ask AI is the web app's shadcn chat (managed Kimi models), embedded so both clients share one UI.
/// The app signs the page in as the current user with a one-time handoff and a PKCE verifier that
/// never appears in a URL.
struct AIView: View {
    var model: AppModel
    @State private var page: URL?
    @State private var verifier: String?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        Group {
            if let page, let verifier {
                EmbeddedWebView(url: page, verifier: verifier)
                    .frame(minHeight: 520)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(AppDesign.border))
            } else if let error {
                ContentUnavailableView {
                    Label("Ask AI is unavailable", systemImage: "sparkles")
                } description: { Text(error) } actions: {
                    Button("Try again") { Task { await load() } }
                }
            } else if !model.isSignedIn || model.usingMock {
                ContentUnavailableView("Sign in to use Ask AI", systemImage: "sparkles",
                                       description: Text("Ask AI uses Kimi models managed by Orbit, with a free daily allowance."))
            } else {
                ProgressView("Opening Ask AI…").frame(maxWidth: .infinity, minHeight: 200)
            }
        }
        .task(id: model.account?.id) { await load() }
    }

    private func load() async {
        page = nil; verifier = nil; error = nil
        guard model.isSignedIn, !model.usingMock, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let config = try await model.workspaceRequest("/client-config").decode(ClientConfiguration.self)
            let v = PKCE.makeVerifier()
            let result = try await model.workspaceRequest("/auth/web-handoff", method: "POST",
                                                          body: .object(["webChallenge": .string(PKCE.challenge(forVerifier: v))]))
            struct Handoff: Decodable { let handoff: String }
            guard let url = config.embedPage("ai", handoff: try result.decode(Handoff.self).handoff) else { throw AIError.invalidEndpoint }
            verifier = v; page = url
        } catch {
            self.error = "Could not open Ask AI. Check your connection and update the app and API server, then try again."
        }
    }
}

private struct EmbeddedWebView: NSViewRepresentable {
    let url: URL
    let verifier: String

    func makeCoordinator() -> Coordinator { Coordinator(origin: url) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Ephemeral storage: the web session lives only as long as this view.
        config.websiteDataStore = .nonPersistent()
        let escaped = verifier.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" } ? verifier : ""
        let script = "sessionStorage.setItem('orbit.embedVerifier', '\(escaped)');"
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL
        init(origin: URL) { self.origin = origin }

        /// Keep the embedded page on the web app's origin; anything else (links in answers) opens in the browser.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url else { decisionHandler(.cancel); return }
            if target.scheme == origin.scheme, target.host == origin.host, target.port == origin.port, action.targetFrame?.isMainFrame != false {
                decisionHandler(.allow)
            } else {
                if ["https", "http"].contains(target.scheme ?? "") { NSWorkspace.shared.open(target) }
                decisionHandler(.cancel)
            }
        }
    }
}
