import AppKit
import SwiftUI
import OrbitKit

// Pieces shared between screens. Colors, type, and button styles live in Theme.swift.

struct OrbitMark: View {
    var size: CGFloat = 20

    var body: some View {
        // The landing page's mark: a planet and one tilted ring, drawn on a 28-point grid.
        ZStack {
            Ellipse().strokeBorder(lineWidth: size * 1.7 / 28)
                .frame(width: size * 25.7 / 28, height: size * 11.7 / 28).rotationEffect(.degrees(-28))
            Circle().frame(width: size * 8.8 / 28, height: size * 8.8 / 28)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

extension MountState {
    var symbol: String {
        switch self {
        case .unmounted: "minus.circle"
        case .mounting: "arrow.triangle.2.circlepath"
        case .mounted: "checkmark.circle"
        case .unmounting: "eject.circle"
        case .error: "exclamationmark.circle"
        }
    }

    var label: String {
        switch self {
        case .unmounted: "Not mounted"
        case .mounting: "Mounting…"
        case .mounted: "Mounted"
        case .unmounting: "Ejecting…"
        case .error: "Mount failed"
        }
    }
}

/// Mount state as a symbol and words, so it never depends on color alone.
struct MountStateLabel: View {
    var state: MountState

    var body: some View {
        Label(state.label, systemImage: state.symbol)
            .orbitLabel()
            .foregroundStyle(tint)
            .accessibilityLabel("Status: \(state.label)")
    }

    private var tint: Color {
        switch state {
        case .mounted: Theme.success
        case .error: Theme.danger
        default: Theme.muted
        }
    }
}

/// One line of status at the top of a window: what happened and, where there is one, what to do about it.
struct InlineMessage<Actions: View>: View {
    enum Kind { case info, warning, error }

    var kind: Kind = .info
    var text: String
    var dismiss: (() -> Void)?
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true)
            Text(text).textSelection(.enabled).lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            actions
            if let dismiss {
                Button("Dismiss", systemImage: "xmark", action: dismiss)
                    .labelStyle(.iconOnly).buttonStyle(.borderless)
            }
        }
        .font(.callout)
        .padding(.horizontal, 16).padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(kind == .error ? "Error: \(text)" : text)
    }

    private var symbol: String {
        switch kind {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "exclamationmark.octagon"
        }
    }
    private var tint: Color {
        switch kind {
        case .info: .secondary
        case .warning: Theme.warning
        case .error: Theme.danger
        }
    }
}

extension InlineMessage where Actions == EmptyView {
    init(kind: Kind = .info, text: String, dismiss: (() -> Void)? = nil) {
        self.init(kind: kind, text: text, dismiss: dismiss) { EmptyView() }
    }
}

/// The sign-in button and, while the browser is open, the ways to get back to it or give up.
struct SignInControls: View {
    var session: SessionStore
    var prominent = true

    var body: some View {
        if session.signingIn {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for your browser…").foregroundStyle(.secondary)
            }
            Button("Open Browser Again") { session.openSignInBrowser() }
            Button("Cancel") { session.cancelSignIn() }
        } else if prominent {
            Button("Sign In…") { session.signIn() }.buttonStyle(.orbitProminent)
        } else {
            Button("Sign In…") { session.signIn() }
        }
        if session.canRetrySavedSignIn {
            Button("Restore Saved Sign-In") { session.retrySavedSignIn() }.disabled(session.retryingSavedSignIn)
        }
    }
}

enum Format {
    static func bytes(_ count: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: max(0, count), countStyle: .file)
    }

    static func percent(_ fraction: Double) -> String {
        "\(Int((min(1, max(0, fraction)) * 100).rounded(.down)))%"
    }

    static func count(_ value: Int, _ singular: String, _ plural: String) -> String {
        "\(value) \(value == 1 ? singular : plural)"
    }
}

/// Sets the title of the AppKit window that hosts a view. The app's windows are created with
/// `NSHostingController`, where `navigationTitle` does not reach the window.
private struct WindowTitle: NSViewRepresentable {
    var title: String

    func makeNSView(context: Context) -> TitleView { TitleView() }
    func updateNSView(_ view: TitleView, context: Context) { view.title = title }

    final class TitleView: NSView {
        var title = "" { didSet { apply() } }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
        }
        private func apply() {
            // A window follows its content view controller's title, so set that as well.
            window?.contentViewController?.title = title
            window?.title = title
        }
    }
}

extension View {
    func windowTitle(_ title: String) -> some View { background(WindowTitle(title: title)) }
}
