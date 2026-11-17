import AppKit
import SwiftUI
import OrbitKit

// The app uses system text styles, semantic colors, and standard controls throughout.
// This file holds the few pieces that are shared between screens.

struct OrbitMark: View {
    var size: CGFloat = 20

    var body: some View {
        ZStack {
            Ellipse().strokeBorder(lineWidth: size * 1.7 / 24)
                .frame(width: size * 20 / 24, height: size * 10 / 24).rotationEffect(.degrees(-35))
            Circle().frame(width: size * 6.6 / 24, height: size * 6.6 / 24)
            Circle().frame(width: size * 2.8 / 24, height: size * 2.8 / 24)
                .offset(x: size / 3, y: -size / 4)
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
        case .unmounted: "Not in Finder"
        case .mounting: "Connecting to Finder…"
        case .mounted: "In Finder"
        case .unmounting: "Ejecting…"
        case .error: "Couldn't connect to Finder"
        }
    }
}

/// The few shared measurements: one corner radius and one neutral surface, as in the web app.
enum OrbitStyle {
    static let radius: CGFloat = 8
    static let border = Color.primary.opacity(0.1)
}

extension View {
    /// A neutral rounded surface with a hairline border.
    func orbitCard(padding: CGFloat = 12) -> some View {
        self.padding(padding)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: OrbitStyle.radius))
            .overlay(RoundedRectangle(cornerRadius: OrbitStyle.radius).strokeBorder(OrbitStyle.border))
    }
}

extension MenuHeadline.Tone {
    var color: Color {
        switch self {
        case .good: .green
        case .busy: .accentColor
        case .attention: .orange
        case .neutral: .secondary
        }
    }
}

/// A status headline as a symbol and words, so it never depends on color alone.
struct HeadlineLabel: View {
    var headline: MenuHeadline
    var font = Font.caption
    var lines = 1

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: headline.symbol).foregroundStyle(headline.tone.color).accessibilityHidden(true)
            Text(headline.title).foregroundStyle(.secondary).lineLimit(lines).fixedSize(horizontal: false, vertical: true)
        }
        .font(font)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Status: \(headline.title)")
    }
}

/// Mount state as a symbol and words, so it never depends on color alone.
struct MountStateLabel: View {
    var state: MountState

    var body: some View {
        Label(state.label, systemImage: state.symbol)
            .font(.caption)
            .foregroundStyle(state == .error ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .accessibilityLabel("Status: \(state.label)")
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
        case .warning: .orange
        case .error: .red
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
            Button("Sign In…") { session.signIn() }.buttonStyle(.borderedProminent)
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

    /// An error in words for the user. The background service's own message is used as it is;
    /// its error code and the word for the service itself stay in the logs.
    static func problem(_ error: Error) -> String {
        if case DaemonClientError.remote(let remote) = error {
            let message = LogFormat.scrub(remote.message)
            return message.isEmpty ? remote.code.replacingOccurrences(of: "_", with: " ") : message
        }
        if case DaemonClientError.notConnected = error { return "Orbit isn't connected to your drives." }
        return LogFormat.describe(error)
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
