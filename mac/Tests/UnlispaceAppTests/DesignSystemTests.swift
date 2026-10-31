import AppKit
import SwiftUI
import Testing
@testable import Unlispace

@Suite @MainActor struct DesignSystemTests {
    @Test func textHasAccessibleContrastInBothAppearances() throws {
        for name in [NSAppearance.Name.aqua, .darkAqua] {
            let appearance = try #require(NSAppearance(named: name))
            var values: [CGFloat] = []
            appearance.performAsCurrentDrawingAppearance {
                values = [AppDesign.foreground, AppDesign.muted, AppDesign.canvas, AppDesign.surface].map { color in
                    let rgb = NSColor(color).usingColorSpace(.sRGB)!
                    let channels = [rgb.redComponent, rgb.greenComponent, rgb.blueComponent].map {
                        $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4)
                    }
                    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
                }
            }
            for text in values.prefix(2) {
                for background in values.suffix(2) {
                    let contrast = (max(text, background) + 0.05) / (min(text, background) + 0.05)
                    #expect(contrast >= 4.5, "Text must meet AA contrast in \(name.rawValue)")
                }
            }
        }
    }
}
