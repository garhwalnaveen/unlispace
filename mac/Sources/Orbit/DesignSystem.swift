import SwiftUI
import AppKit
import OrbitKit

/// Shared surfaces and type for the native workspace.
enum AppDesign {
    static let canvas = adaptive(light: 0xf5f5f3, dark: 0x17181a)
    static let surface = adaptive(light: 0xffffff, dark: 0x202124)
    static let sidebar = adaptive(light: 0xedeeec, dark: 0x1b1c1e)
    static let subtle = adaptive(light: 0xf0f1ef, dark: 0x2a2c30)
    static let border = adaptive(light: 0xdcdeda, dark: 0x383b40)
    static let foreground = adaptive(light: 0x242629, dark: 0xf1f2f3)
    static let muted = adaptive(light: 0x62666c, dark: 0xadb1ba)
    static let accent = adaptive(light: 0x303b39, dark: 0xd4dfda)
    static let title = Font.system(size: 30, weight: .semibold)
    static let pageInset: CGFloat = 28
    static let panelRadius: CGFloat = 12
    static let sectionSpacing: CGFloat = 24
    static let contentWidth: CGFloat = 1040

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255,
                           green: CGFloat((value >> 8) & 0xff) / 255,
                           blue: CGFloat(value & 0xff) / 255, alpha: 1)
        })
    }
}

struct OrbitMark: View {
    var size: CGFloat = 22

    var body: some View {
        ZStack {
            Ellipse().strokeBorder(lineWidth: size * 1.7 / 24)
                .frame(width: size * 20 / 24, height: size * 10 / 24).rotationEffect(.degrees(-35))
            Circle().frame(width: size * 6.6 / 24, height: size * 6.6 / 24)
            Circle().frame(width: size * 2.8 / 24, height: size * 2.8 / 24)
                .offset(x: size / 3, y: -size / 4)
        }
        .frame(width: size, height: size)
        .foregroundStyle(AppDesign.accent)
        .accessibilityHidden(true)
    }
}

private struct AppPanel: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .background(AppDesign.surface, in: RoundedRectangle(cornerRadius: AppDesign.panelRadius))
            .overlay {
                RoundedRectangle(cornerRadius: AppDesign.panelRadius)
                    .strokeBorder(contrast == .increased ? AppDesign.muted : AppDesign.border)
                    .allowsHitTesting(false)
            }
    }
}

extension View {
    func appPanel() -> some View { modifier(AppPanel()) }

    func appStyle() -> some View {
        font(.system(size: 13))
            .foregroundStyle(AppDesign.foreground)
            .buttonStyle(.bordered)
            .tint(.accentColor)
            .background(AppDesign.canvas)
    }
}

/// State is always conveyed by a symbol and text, never color alone.
struct DriveStatusBadge: View {
    var state: MountState

    var body: some View {
        Label(state.label, systemImage: state.symbol)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(state == .error ? Color.red : AppDesign.muted)
            .padding(.horizontal, 7).padding(.vertical, 4)
            .background(AppDesign.subtle, in: Capsule())
            .accessibilityLabel("Drive status: \(state.label)")
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

    /// User-facing wording, matching the drive filter labels.
    var label: String {
        switch self {
        case .unmounted: "Not mounted"
        case .mounting: "Mounting…"
        case .mounted: "Mounted"
        case .unmounting: "Ejecting…"
        case .error: "Needs attention"
        }
    }
}
