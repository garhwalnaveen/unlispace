import SwiftUI
import AppKit
import UnlispaceKit

/// Shared neutral surfaces; system fonts, controls, and semantic status colors stay native.
enum AppDesign {
    static let canvas = neutral(light: 0.98, dark: 0)
    static let surface = neutral(light: 1, dark: 0.04)
    static let subtle = neutral(light: 0.95, dark: 0.09)
    static let border = neutral(light: 0.88, dark: 0.16)
    static let foreground = neutral(light: 0.09, dark: 0.93)
    static let muted = neutral(light: 0.40, dark: 0.63)
    static let title = Font.system(size: 26, weight: .semibold)

    private static func neutral(light: CGFloat, dark: CGFloat) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(white: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light, alpha: 1)
        })
    }
}

private struct AppPanel: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .background(AppDesign.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
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
