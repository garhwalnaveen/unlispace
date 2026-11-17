import AppKit
import SwiftUI
import Testing
import OrbitKit
@testable import Orbit

/// Renders every screen in both appearances from fixed engine snapshots. No credentials, mounts, or saved preferences.
/// The images land in `$TMPDIR/orbit-ui-review` for visual review.
@Suite @MainActor struct WorkspaceRenderTests {
    private static let drives = [
        DriveInfo(driveId: "design", name: "Design & brand", mountState: .mounted, mountPath: "/Volumes/Design & brand"),
        DriveInfo(driveId: "archive", name: "Archive", mountState: .unmounted),
        DriveInfo(driveId: "work", name: "Work in progress", mountState: .mounting),
        DriveInfo(driveId: "legal", name: "Legal", mountState: .error),
    ]
    private static let transfers = [
        TransferInfo(id: "upload", driveId: "design", path: "/Brand/Style guide.pdf", direction: .upload,
                     bytesDone: 5_200_000, bytesTotal: 10_400_000, status: .active),
        TransferInfo(id: "download", driveId: "design", path: "/Reference/Reference images.zip", direction: .download,
                     bytesDone: 1_000_000, bytesTotal: 0, status: .active),
    ]
    private static let queue = UploadsSnapshot(pending: [PendingUpload(driveId: "design", path: "/Brand/Logo.svg", bytes: 48_000)],
                                               journalBytes: 10_448_000, journalCapBytes: 10_000_000_000)
    private static let pins = [
        OfflinePin(driveId: "design", path: "/", bytes: 2_400_000_000, cachedBytes: 1_200_000_000),
        OfflinePin(driveId: "archive", path: "/2023", bytes: 800_000_000, cachedBytes: 800_000_000),
    ]

    @Test func everyScreenRendersInBothAppearances() async throws {
        _ = NSApplication.shared
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbit-ui-review")
        try? FileManager.default.removeItem(at: output)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var names: Set<String> = []

        for scheme in [ColorScheme.light, .dark] {
            func shot(_ name: String, size: NSSize = NSSize(width: 900, height: 600), settings: SettingsPage? = nil,
                      _ view: some View) throws {
                names.insert(name)
                try render(view, to: output.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png"),
                           scheme: scheme, size: size, settings: settings)
            }
            func workspace(_ model: AppModel, _ page: WorkspacePage) -> some View {
                let navigation = WorkspaceNavigation()
                navigation.page = page
                return WorkspaceView(model: model, navigation: navigation)
            }
            let compact = NSSize(width: 680, height: 440)
            let setup = NSSize(width: 560, height: 520)
            let menu = NSSize(width: 320, height: 400)
            let settings = NSSize(width: 560, height: 460)

            let signedOut = Fixtures.offline()
            signedOut.engine.install = .enabled
            signedOut.engineIsUnavailable(error: nil)
            try shot("signed-out", workspace(signedOut, .drives))
            try shot("menu-signed-out", size: menu, MenuContent(model: signedOut))
            try shot("setup-sign-in", size: setup, SetupView(model: signedOut, finish: {}))

            let stopped = Fixtures.offline()
            stopped.session.setAccount(Fixtures.account)
            stopped.engine.install = .requiresApproval
            stopped.engineIsUnavailable(error: nil)
            try shot("service-stopped", workspace(stopped, .drives))
            try shot("activity-unavailable", workspace(stopped, .activity))

            let empty = try await Fixtures.showing(SnapshotClient())
            try shot("drives-empty", workspace(empty, .drives))
            try shot("activity-empty", workspace(empty, .activity))
            try shot("offline-empty", workspace(empty, .offline))

            let model = try await Fixtures.showing(SnapshotClient(drives: Self.drives, transfers: Self.transfers, queue: Self.queue,
                                                                  pins: Self.pins, state: .syncing))
            model.engine.install = .enabled
            model.permissions.notificationAccess = .notRequested
            model.permissions.loginAccess = .notEnabled
            try shot("drives", workspace(model, .drives))
            try shot("drives-compact", size: compact, workspace(model, .drives))
            try shot("activity", workspace(model, .activity))
            try shot("activity-compact", size: compact, workspace(model, .activity))
            try shot("offline", workspace(model, .offline))
            try shot("search", workspace(model, .search))
            try shot("menu", size: menu, MenuContent(model: model))
            for step in SetupStep.allCases.dropFirst() {
                try shot("setup-\(step.title.lowercased())", size: setup, SetupView(model: model, finish: {}, step: step))
            }
            for page in SettingsPage.allCases {
                try shot("settings-\(page.rawValue.lowercased())", size: settings, settings: page, SettingsView(model: model))
            }

            let failing = try await Fixtures.showing(SnapshotClient(drives: Self.drives))
            failing.apply(.transfer(TransferInfo(id: "failed", driveId: "design", path: "/Brand/Interrupted upload.pdf",
                                                 direction: .upload, bytesDone: 20, bytesTotal: 100, status: .failed)))
            failing.messages.notice = "Signed in. Your drives appear when the background service starts."
            failing.messages.conflict = try JSONDecoder().decode(ConflictEvent.self, from: Data(#"{"driveId":"design","path":"/Brand/Plan.md","copy":"Plan (conflicted copy).md"}"#.utf8))
            try shot("messages", workspace(failing, .activity))

            let many = (1...60).map { DriveInfo(driveId: "d\($0)", name: "Project \($0)", mountState: $0 % 7 == 0 ? .mounted : .unmounted,
                                                mountPath: $0 % 7 == 0 ? "/Volumes/Project \($0)" : nil) }
            try shot("drives-many", workspace(try await Fixtures.showing(SnapshotClient(drives: many)), .drives))
        }

        for name in names {
            let light = try Data(contentsOf: output.appendingPathComponent("\(name)-light.png"))
            let dark = try Data(contentsOf: output.appendingPathComponent("\(name)-dark.png"))
            #expect(light != dark, "\(name) must differ between light and dark")
        }
    }

    /// Hosts the view in a real titled window so the toolbar and tab bar are part of the image.
    /// By default the window is drawn off screen, which works headless but cannot draw the translucent sidebar.
    /// With `ORBIT_UI_CAPTURE=screen` the window is shown and captured as the user sees it.
    private func render(_ view: some View, to file: URL, scheme: ColorScheme, size: NSSize, settings: SettingsPage?) throws {
        let onScreen = ProcessInfo.processInfo.environment["ORBIT_UI_CAPTURE"] == "screen"
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let previous = NSApplication.shared.appearance
        NSApplication.shared.appearance = appearance
        defer { NSApplication.shared.appearance = previous }
        let (defaults, cleanup) = Fixtures.defaults()
        defer { cleanup() }
        if let settings { defaults.set(settings.rawValue, forKey: Preference.settingsPage) }

        let controller = NSHostingController(rootView: view.defaultAppStorage(defaults))
        controller.sizingOptions = []
        let window = NSWindow(contentViewController: controller)
        // The Settings scene supplies its own window; a plain titled window is the closest stand-in.
        window.styleMask = settings == nil ? [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView] : [.titled, .closable]
        window.toolbarStyle = .unified
        window.title = settings?.rawValue ?? ""
        window.isReleasedWhenClosed = false
        window.appearance = appearance
        window.setContentSize(size)
        if onScreen {
            NSApplication.shared.setActivationPolicy(.accessory)
            window.setFrameTopLeftPoint(NSPoint(x: 60, y: (NSScreen.main?.visibleFrame.maxY ?? 800) - 20))
            window.orderFrontRegardless()
            window.makeKey()
        } else {
            window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
            window.orderFront(nil)
        }
        defer { window.close() }
        // Let `.task` loads, list layout, and the toolbar settle.
        for _ in 0..<(onScreen ? 12 : 3) {
            window.layoutIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        // Content taller than its window is centered and clipped, which shows as a blank or shifted page.
        func overflows(_ view: NSView) -> Bool {
            // A scroll view's document is meant to be taller, so stop there.
            view.frame.height > size.height + 60 || (!(view is NSScrollView) && view.subviews.contains(where: overflows))
        }
        #expect(!overflows(controller.view), "\(file.lastPathComponent): content is laid out taller than its window")
        if onScreen {
            let capture = Process()
            capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-o", "-l\(window.windowNumber)", file.path]
            try capture.run()
            capture.waitUntilExit()
            #expect(capture.terminationStatus == 0)
            #expect(((try? Data(contentsOf: file))?.count ?? 0) > 1000)
            return
        }
        let frame = try #require(window.contentView?.superview)
        let bitmap = try #require(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
        frame.cacheDisplay(in: frame.bounds, to: bitmap)
        #expect(bitmap.pixelsWide >= Int(size.width))
        #expect(bitmap.pixelsHigh >= Int(size.height))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        #expect(png.count > 1000)
        try png.write(to: file)
    }
}
