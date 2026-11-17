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
                      _ view: some View, afterLoading: (() -> Void)? = nil) throws {
                names.insert(name)
                try render(view, to: output.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png"),
                           scheme: scheme, size: size, settings: settings, afterLoading: afterLoading)
            }
            func workspace(_ model: AppModel, _ page: WorkspacePage) -> some View {
                let navigation = WorkspaceNavigation()
                navigation.page = page
                return WorkspaceView(model: model, navigation: navigation)
            }
            /// The menu-bar panel sizes itself, so its window is made exactly as tall as its content.
            func menuShot(_ name: String, _ model: AppModel) throws {
                // The real panel has no title bar; leave room for the stand-in window's.
                let panel = MenuContent(model: model).padding(.top, 24)
                let height = NSHostingController(rootView: panel).sizeThatFits(in: NSSize(width: 340, height: 10_000)).height
                try shot(name, size: NSSize(width: 340, height: height.rounded(.up) + 12), panel)
            }
            let compact = NSSize(width: 680, height: 440)
            let setup = NSSize(width: 560, height: 520)
            let settings = NSSize(width: 560, height: 460)

            // First run: nobody is signed in and setup has not been finished.
            let firstRun = Fixtures.offline()
            firstRun.setupCompleted = false
            firstRun.engine.install = .notRegistered
            firstRun.engineIsUnavailable(error: nil)
            try shot("setup-welcome", size: setup, SetupView(model: firstRun, finish: { _ in }))
            try shot("setup-benefits", size: setup, SetupView(model: firstRun, finish: { _ in }, step: .benefits))
            try shot("setup-sign-in", size: setup, SetupView(model: firstRun, finish: { _ in }, step: .signIn))
            try shot("setup-waiting", size: setup,
                     SetupView(model: firstRun, finish: { _ in }, step: .signIn, showing: .waitingForBrowser))
            try menuShot("menu-setup-not-finished", firstRun)

            let signedOut = Fixtures.offline()
            signedOut.engine.install = .enabled
            signedOut.engineIsUnavailable(error: nil)
            try shot("signed-out", workspace(signedOut, .drives))
            try menuShot("menu-signed-out", signedOut)

            let stopped = Fixtures.offline()
            stopped.session.setAccount(Fixtures.account)
            stopped.engine.install = .requiresApproval
            stopped.engineIsUnavailable(error: nil)
            try shot("service-stopped", workspace(stopped, .drives))
            try shot("activity-unavailable", workspace(stopped, .activity))
            try menuShot("menu-needs-approval", stopped)
            try shot("setup-done-needs-permission", size: setup, SetupView(model: stopped, finish: { _ in }, step: .done))

            let empty = try await Fixtures.showing(SnapshotClient())
            try shot("drives-empty", workspace(empty, .drives))
            try shot("activity-empty", workspace(empty, .activity))
            try shot("offline-empty", workspace(empty, .offline))
            try shot("setup-done-no-drive", size: setup,
                     SetupView(model: empty, finish: { _ in }, step: .done, preparedFor: Fixtures.account.id))

            let client = SnapshotClient(drives: Self.drives, transfers: Self.transfers, queue: Self.queue, pins: Self.pins, state: .syncing)
            try await Fixtures.workspace(client, drives: Self.drives.map(\.driveId))
            let model = try await Fixtures.showing(client)
            await model.workspaces.load()
            model.engine.install = .enabled
            model.permissions.notificationAccess = .notRequested
            model.permissions.loginAccess = .notEnabled
            try shot("drives", workspace(model, .drives))
            try shot("drives-compact", size: compact, workspace(model, .drives))
            try shot("activity", workspace(model, .activity))
            try shot("activity-compact", size: compact, workspace(model, .activity))
            try shot("offline", workspace(model, .offline))
            try shot("search", workspace(model, .search))
            try menuShot("menu", model)
            try shot("setup-setting-up", size: setup, SetupView(model: model, finish: { _ in }, step: .signIn))
            // The permission pages read macOS when they appear. A test process has no grants to read,
            // so the states a new user sees are put back once that read has finished.
            let newUser = {
                model.engine.install = .notRegistered
                model.permissions.notificationAccess = .notRequested
                model.permissions.loginAccess = .notEnabled
            }
            let granted = {
                model.engine.install = .enabled
                model.permissions.notificationAccess = .enabled
                model.permissions.loginAccess = .notEnabled
            }
            try shot("setup-permissions", size: setup, SetupView(model: model, finish: { _ in }, step: .permissions),
                     afterLoading: newUser)
            try shot("setup-permissions-allowed", size: setup, SetupView(model: model, finish: { _ in }, step: .permissions),
                     afterLoading: granted)
            try shot("setup-done", size: setup,
                     SetupView(model: model, finish: { _ in }, step: .done, preparedFor: Fixtures.account.id))
            for page in SettingsPage.allCases {
                try shot("settings-\(page.rawValue.lowercased())", size: settings, settings: page, SettingsView(model: model),
                         afterLoading: page == .permissions ? granted : nil)
            }
            try shot("drive-rename", size: NSSize(width: 400, height: 220),
                     DriveNameSheet(model: model, edit: DriveEdit(kind: .rename, drive: Self.drives[0])))
            try shot("drive-copy", size: NSSize(width: 400, height: 220),
                     DriveNameSheet(model: model, edit: DriveEdit(kind: .copy, drive: Self.drives[0])))

            // Set up and quiet: every step done, nothing in flight.
            let quiet = try await Fixtures.showing(SnapshotClient(drives: Array(Self.drives.prefix(2))))
            quiet.activation.record { $0.finderOpened = true; $0.fileAdded = true; $0.cloudSaveConfirmed = true }
            try menuShot("menu-up-to-date", quiet)

            // A plan that has lapsed: the files are safe, and the one action is the plan page.
            let lapsed = SnapshotClient(drives: Array(Self.drives.prefix(2)))
            try await Fixtures.workspace(lapsed, drives: ["design", "archive"], state: "expired", writable: false)
            let paused = try await Fixtures.showing(lapsed)
            await paused.workspaces.load()
            try menuShot("menu-plan-inactive", paused)
            try shot("drives-plan-inactive", workspace(paused, .drives))

            let failing = try await Fixtures.showing(SnapshotClient(drives: Self.drives))
            failing.apply(.transfer(TransferInfo(id: "failed", driveId: "design", path: "/Brand/Interrupted upload.pdf",
                                                 direction: .upload, bytesDone: 20, bytesTotal: 100, status: .failed)))
            failing.messages.notice = "Signed in. Your drives appear once Orbit can run in the background."
            failing.messages.conflict = try JSONDecoder().decode(ConflictEvent.self, from: Data(#"{"driveId":"design","path":"/Brand/Plan.md","copy":"Plan (conflicted copy).md"}"#.utf8))
            try shot("messages", workspace(failing, .activity))
            failing.activation.record { $0.dismissed = true }
            try menuShot("menu-upload-failed", failing)

            let many = (1...60).map { DriveInfo(driveId: "d\($0)", name: "Project \($0)", mountState: $0 % 7 == 0 ? .mounted : .unmounted,
                                                mountPath: $0 % 7 == 0 ? "/Volumes/Project \($0)" : nil) }
            let crowded = try await Fixtures.showing(SnapshotClient(drives: many))
            crowded.activation.record { $0.dismissed = true }
            try shot("drives-many", workspace(crowded, .drives))
        }

        for name in names {
            let light = try Data(contentsOf: output.appendingPathComponent("\(name)-light.png"))
            let dark = try Data(contentsOf: output.appendingPathComponent("\(name)-dark.png"))
            #expect(light != dark, "\(name) must differ between light and dark")
        }
    }

    /// Lets `.task` loads and layout run. On screen it also handles window-server events, which is what
    /// makes the app active and its window key, so default buttons draw in the accent color.
    private func settle(_ seconds: TimeInterval, _ onScreen: Bool) {
        let end = Date().addingTimeInterval(seconds)
        guard onScreen else { RunLoop.current.run(until: end); return }
        while let event = NSApplication.shared.nextEvent(matching: .any, until: end, inMode: .default, dequeue: true) {
            NSApplication.shared.sendEvent(event)
        }
    }

    /// Hosts the view in a real titled window so the toolbar and tab bar are part of the image.
    /// By default the window is drawn off screen, which works headless but cannot draw the translucent sidebar.
    /// With `ORBIT_UI_CAPTURE=screen` the window is shown and captured as the user sees it.
    private func render(_ view: some View, to file: URL, scheme: ColorScheme, size: NSSize, settings: SettingsPage?,
                        afterLoading: (() -> Void)? = nil) throws {
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
        window.title = settings?.title ?? ""
        window.isReleasedWhenClosed = false
        window.appearance = appearance
        window.setContentSize(size)
        if onScreen {
            NSApplication.shared.setActivationPolicy(.regular)
            window.setFrameTopLeftPoint(NSPoint(x: 60, y: (NSScreen.main?.visibleFrame.maxY ?? 800) - 20))
            // An active app draws its key window's default button in the accent color, as users see it.
            NSApplication.shared.setActivationPolicy(.regular)
            NSApplication.shared.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        } else {
            window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
            window.orderFront(nil)
        }
        defer { window.close() }
        // Let `.task` loads, list layout, and the toolbar settle.
        for _ in 0..<(onScreen ? 12 : 3) {
            window.layoutIfNeeded()
            settle(0.1, onScreen)
        }
        if let afterLoading {
            // Twice, because a read started by the window appearing can still land after the first.
            for pause in [0.3, 0.05] {
                afterLoading()
                window.layoutIfNeeded()
                settle(pause, onScreen)
            }
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
