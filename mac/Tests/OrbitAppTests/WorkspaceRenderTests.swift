import AppKit
import SwiftUI
import Testing
import OrbitKit
@testable import Orbit

/// Render real SwiftUI layouts without credentials, mounting drives, or changing preferences.
@Suite @MainActor struct WorkspaceRenderTests {
    @Test func desktopLayoutsRenderInBothAppearances() throws {
        _ = NSApplication.shared
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbit-ui-review")
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
                DriveInfo(driveId: "attention", name: "Needs attention", mountState: .error),
            ]
            model.pins = []
            try render(WorkspaceView(model: model).preferredColorScheme(scheme), name: "drives-\(suffix)", output: output, scheme: scheme)
            try render(WorkspaceView(model: model).preferredColorScheme(scheme), name: "drives-compact-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 800, height: 580))
            try render(OnboardingView(model: AppModel(), finish: {}).preferredColorScheme(scheme), name: "setup-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 1100, height: 760))
            model.engineInstall = .enabled
            model.notificationAccess = .notRequested
            model.loginAccess = .notEnabled
            for step in OnboardingStep.allCases {
                try render(OnboardingView(model: model, finish: {}, step: step).preferredColorScheme(scheme), name: "onboarding-\(step.label)-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 1100, height: 760))
                try render(OnboardingView(model: model, finish: {}, step: step).preferredColorScheme(scheme), name: "onboarding-\(step.label)-compact-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 800, height: 640))
            }
            try render(MenuContent(model: model).preferredColorScheme(scheme), name: "menu-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 360, height: 680))
            try render(OfflineFilesView(model: model).preferredColorScheme(scheme), name: "offline-empty-\(suffix)", output: output, scheme: scheme)
            model.pins = [OfflinePin(driveId: "design", path: "/", bytes: 1000, cachedBytes: 500)]
            try render(OfflineFilesView(model: model).preferredColorScheme(scheme), name: "offline-progress-\(suffix)", output: output, scheme: scheme)
            try render(OfflineFilesView(model: model).preferredColorScheme(scheme), name: "offline-compact-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 520, height: 580))
            try render(FileSearchView(model: model).preferredColorScheme(scheme), name: "search-\(suffix)", output: output, scheme: scheme)
            try render(FileSearchView(model: model).preferredColorScheme(scheme), name: "search-compact-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 516, height: 580))
            try render(WorkspaceAccountView(model: AppModel()).preferredColorScheme(scheme), name: "workspace-\(suffix)", output: output, scheme: scheme)
            try render(AIView(model: AppModel()).preferredColorScheme(scheme), name: "ai-\(suffix)", output: output, scheme: scheme)
            try render(SettingsView(model: model).preferredColorScheme(scheme), name: "settings-\(suffix)", output: output, scheme: scheme)
            model.engineInstall = .enabled
            model.notificationAccess = .denied
            model.loginAccess = .needsApproval
            try render(Form { PermissionsContent(model: model) }.formStyle(.grouped), name: "permissions-\(suffix)", output: output, scheme: scheme)
            let transfer = TransferInfo(id: "upload", driveId: "design", path: "/Brand/Style guide.pdf", direction: .upload,
                                        bytesDone: 50, bytesTotal: 100, status: .active)
            try render(TransfersView(transfers: [transfer], embedded: true).preferredColorScheme(scheme), name: "transfers-\(suffix)", output: output, scheme: scheme)
            try render(TransfersView(transfers: [transfer], embedded: true).preferredColorScheme(scheme), name: "transfers-compact-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 516, height: 580))
            let failedTransfer = TransferInfo(id: "failed", driveId: "design", path: "/Brand/A long filename for an interrupted file upload.pdf", direction: .upload,
                                              bytesDone: 20, bytesTotal: 100, status: .failed)
            let download = TransferInfo(id: "download", driveId: "design", path: "/Reference/Reference images.zip", direction: .download,
                                        bytesDone: 10, bytesTotal: 0, status: .active)
            try render(TransfersView(transfers: [transfer, failedTransfer, download], embedded: true).preferredColorScheme(scheme), name: "activity-mixed-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 516, height: 760))
            try render(HStack(spacing: 10) {
                ForEach([MountState.unmounted, .mounting, .mounted, .unmounting, .error], id: \.rawValue) { state in
                    DriveStatusBadge(state: state)
                }
            }.padding(20).preferredColorScheme(scheme), name: "drive-states-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 800, height: 120))
            let pending = PendingUpload(driveId: "design", path: "/.DS_Store", bytes: 6000)
            let summary = TransferInfo(id: "design:upload", driveId: "design", path: "/", direction: .upload,
                                       bytesDone: 0, bytesTotal: 6000, status: .queued)
            try render(TransfersView(transfers: [summary], uploads: UploadsSnapshot(pending: [pending], journalBytes: 7000, journalCapBytes: 10_000_000_000), state: .syncing, embedded: true).preferredColorScheme(scheme), name: "activity-pending-\(suffix)", output: output, scheme: scheme, size: NSSize(width: 516, height: 580))
        }
        for name in ["signed-out", "service-unavailable", "drives", "settings", "permissions", "transfers", "offline-empty", "offline-progress", "search", "workspace", "ai", "setup", "menu", "drives-compact", "offline-compact", "activity-mixed", "drive-states"] {
            let light = try Data(contentsOf: output.appendingPathComponent("\(name)-light.png"))
            let dark = try Data(contentsOf: output.appendingPathComponent("\(name)-dark.png"))
            #expect(light != dark, "Light and dark fixtures must have different appearances")
        }
    }

    private func render(_ view: some View, name: String, output: URL, scheme: ColorScheme, size: NSSize = NSSize(width: 1000, height: 680)) throws {
        let previousAppearance = NSApplication.shared.appearance
        NSApplication.shared.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        defer { NSApplication.shared.appearance = previousAppearance }
        let defaults = try #require(UserDefaults(suiteName: "workspace-render-tests"))
        defaults.set("system", forKey: "appearance")
        defer { defaults.removePersistentDomain(forName: "workspace-render-tests") }
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading).appStyle().environment(\.colorScheme, scheme).defaultAppStorage(defaults))
        host.sizingOptions = []
        host.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = host.appearance
        window.contentView = host
        window.setContentSize(size)
        window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        window.orderFront(nil)
        defer { window.close() }
        window.layoutIfNeeded()
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        #expect(host.bounds.size == size, "The fixture must retain its requested window size")
        #expect(bitmap.pixelsWide >= Int(size.width))
        #expect(bitmap.pixelsHigh >= Int(size.height))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        #expect(png.count > 1000)
        try png.write(to: output.appendingPathComponent("\(name).png"))
    }
}
