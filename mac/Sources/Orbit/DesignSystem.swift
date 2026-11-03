import SwiftUI
import AppKit
import OrbitKit

/// Shared surfaces and type for the native workspace.
enum AppDesign {
    static let canvas = adaptive(light: 0xf6f6f6, dark: 0x000000)
    static let surface = adaptive(light: 0xfdfdfd, dark: 0x0c0c0c)
    static let subtle = adaptive(light: 0xf2f2f2, dark: 0x191919)
    static let border = adaptive(light: 0xe4e4e4, dark: 0x272727)
    static let foreground = adaptive(light: 0x000000, dark: 0xfdfdfd)
    static let muted = adaptive(light: 0x606060, dark: 0xa0a0a0)
    static let accent = adaptive(light: 0x000000, dark: 0xfdfdfd)
    static let title = Font.system(size: 26, weight: .semibold)
    static let pageInset: CGFloat = 32
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
            .background(AppDesign.surface, in: RoundedRectangle(cornerRadius: 6))
            .overlay {
                RoundedRectangle(cornerRadius: 6)
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
            .tint(AppDesign.accent)
            .background(AppDesign.canvas)
    }
}

extension MountState {
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
