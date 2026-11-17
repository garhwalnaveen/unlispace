import SwiftUI
import WebKit
import OrbitKit

/// Ask AI is the web app's chat page, embedded so both clients share one implementation.
/// The page is signed in as the current user with a one-time handoff; its PKCE verifier never appears in a URL.
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
            } else if let error {
                ContentUnavailableView {
                    Label("Ask AI is unavailable", systemImage: "sparkles")
                } description: { Text(error) } actions: {
                    Button("Try Again") { Task { await load() } }
                }
            } else if !model.isAccountLive {
                ContentUnavailableView("Ask AI is unavailable", systemImage: "sparkles",
                                       description: Text("Ask AI works once you are signed in and connected."))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: model.isAccountLive) { await load() }
    }

    private func load() async {
        guard !loading else { return }
        page = nil; verifier = nil; error = nil
        guard model.isAccountLive else { return }
        loading = true
        defer { loading = false }
        do {
            let embedded = try await model.workspaces.embeddedPage("ai")
            verifier = embedded.verifier
            page = embedded.url
        } catch {
            self.error = "Ask AI could not be opened. Check your internet connection and try again."
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
