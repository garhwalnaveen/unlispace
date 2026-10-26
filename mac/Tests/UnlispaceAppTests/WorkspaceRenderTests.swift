import AppKit
import SwiftUI
import Testing
import UnlispaceKit
@testable import Unlispace

/// Render real SwiftUI layouts without credentials, mounting drives, or changing preferences.
@Suite @MainActor struct WorkspaceRenderTests {
    @Test func desktopLayoutsRenderInBothAppearances() throws {
        _ = NSApplication.shared
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("unlispace-ui-review")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for dark in [false, true] {
            let model = AppModel()
            let scheme: ColorScheme = dark ? .dark : .light
            let suffix = dark ? "dark" : "light"
            try render(WorkspaceView(model: model).preferredColorScheme(scheme), name: "signed-out-\(suffix)", output: output, scheme: scheme)
            model.engineInstall = .failed("The background service is unavailable. Reopen the installed app to continue setup.")
            try render(WorkspaceView(model: model).preferredColorScheme(scheme), name: "service-unavailable-\(suffix)", output: output, scheme: scheme)
            model.usingMock = false
            model.status = .idle
            model.account = AuthUser(id: "ui-review", email: "review@example.invalid")
            model.drives = [
                DriveInfo(driveId: "design", name: "Design & brand", mountState: .mounted, mountPath: "/Volumes/Design & brand"),
                DriveInfo(driveId: "archive", name: "Archive", mountState: .unmounted),
                DriveInfo(driveId: "work", name: "Work in progress", mountState: .mounting),
            ]
            model.pins = []
            try render(WorkspaceView(model: model).preferredColorScheme(scheme), name: "drives-\(suffix)", output: output, scheme: scheme)
            try render(OfflineFilesView(model: model).preferredColorScheme(scheme), name: "offline-empty-\(suffix)", output: output, scheme: scheme)
            model.pins = [OfflinePin(driveId: "design", path: "/", bytes: 1000, cachedBytes: 500)]
            try render(OfflineFilesView(model: model).preferredColorScheme(scheme), name: "offline-progress-\(suffix)", output: output, scheme: scheme)
            try render(SettingsView(model: model).preferredColorScheme(scheme), name: "settings-\(suffix)", output: output, scheme: scheme)
            model.engineInstall = .enabled
            model.notificationAccess = .denied
            model.loginAccess = .needsApproval
            try render(Form { PermissionsContent(model: model) }.formStyle(.grouped), name: "permissions-\(suffix)", output: output, scheme: scheme)
            let transfer = TransferInfo(id: "upload", driveId: "design", path: "/Brand/Style guide.pdf", direction: .upload,
                                        bytesDone: 50, bytesTotal: 100, status: .active)
            try render(TransfersView(transfers: [transfer], embedded: true).preferredColorScheme(scheme), name: "transfers-\(suffix)", output: output, scheme: scheme)
        }
        for name in ["signed-out", "service-unavailable", "drives", "settings", "permissions", "transfers", "offline-empty", "offline-progress"] {
            let light = try Data(contentsOf: output.appendingPathComponent("\(name)-light.png"))
            let dark = try Data(contentsOf: output.appendingPathComponent("\(name)-dark.png"))
            #expect(light != dark, "Light and dark fixtures must have different appearances")
        }
    }

    private func render(_ view: some View, name: String, output: URL, scheme: ColorScheme) throws {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, scheme))
        host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        host.frame = NSRect(x: 0, y: 0, width: 1000, height: 680)
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        #expect(bitmap.pixelsWide >= 1000)
        #expect(bitmap.pixelsHigh >= 680)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        #expect(png.count > 1000)
        try png.write(to: output.appendingPathComponent("\(name).png"))
    }
}
