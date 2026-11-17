import AppKit
import SwiftUI

/// Colors, type, and control styles shared with the Orbit landing page and web app.
/// Each color has a light value and the value used by the landing page's dark sections.
enum Theme {
    static var ink: Color { dynamic(light: 0x0E0B0A, dark: 0xFFFFFF) }
    static var canvas: Color { dynamic(light: 0xFAFAFA, dark: 0x0E0B0A) }
    static var paper: Color { dynamic(light: 0xFFFFFF, dark: 0x171414) }
    static var line: Color { dynamic(light: 0xE6E5E5, dark: 0x2B2928) }
    static var muted: Color { dynamic(light: 0x605E5D, dark: 0xB7B6B6) }
    static var success: Color { dynamic(light: 0x059669, dark: 0x34D399) }
    static var warning: Color { dynamic(light: 0xD9632B, dark: 0xF0925F) }
    static var danger: Color { dynamic(light: 0xB91C1C, dark: 0xF87171) }

    /// Large headings. Helvetica Neue ships with macOS and is the landing page's display face.
    static func display(_ size: CGFloat) -> Font { .custom("Helvetica Neue", size: size) }

    /// Small monospaced text for labels, counts, and button titles. Pair with `orbitLabel()`.
    static var label: Font { .system(size: 11, weight: .medium, design: .monospaced) }

    /// `canvas` as a window background color.
    static let windowBackground = nsColor(light: 0xFAFAFA, dark: 0x0E0B0A)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color { Color(nsColor: nsColor(light: light, dark: dark)) }

    private static func nsColor(light: UInt32, dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
    }
}

/// A pill button with an uppercase monospaced title: filled for the main action, outlined otherwise.
struct OrbitButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .orbitLabel()
            .lineLimit(1)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .foregroundStyle(prominent ? Theme.canvas : Theme.ink)
            .background(prominent ? Theme.ink : Theme.paper, in: Capsule())
            .overlay { Capsule().strokeBorder(prominent ? Theme.ink : Theme.line) }
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .contentShape(Capsule())
    }
}

extension ButtonStyle where Self == OrbitButtonStyle {
    static var orbit: OrbitButtonStyle { OrbitButtonStyle() }
    static var orbitProminent: OrbitButtonStyle { OrbitButtonStyle(prominent: true) }
}

extension View {
    /// Uppercase monospaced text, as used for labels on the landing page.
    func orbitLabel() -> some View { font(Theme.label).textCase(.uppercase).tracking(0.6) }

    /// Orbit's button style and tint for every control inside a window or sheet.
    func orbitControls() -> some View { buttonStyle(.orbit).tint(Theme.ink) }

    /// Fills a view with the canvas color and styles the window SwiftUI made for it, as the Settings scene does.
    func orbitWindow() -> some View { background(Theme.canvas).background(WindowChrome()) }
}

extension NSWindow {
    /// Paints the title bar and toolbar with the canvas color instead of the system material.
    /// Call it after setting the style mask: a title bar made transparent before `.fullSizeContentView` loses its buttons.
    func applyOrbitChrome() {
        backgroundColor = Theme.windowBackground
        titlebarAppearsTransparent = true
    }
}

private struct WindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> ChromeView { ChromeView() }
    func updateNSView(_ view: ChromeView, context: Context) {}

    final class ChromeView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.applyOrbitChrome()
        }
    }
}
