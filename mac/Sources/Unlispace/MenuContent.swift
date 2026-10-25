import SwiftUI
import UnlispaceKit

struct MenuContent: View {
    @Bindable var model: AppModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Text(model.status.title)
        if model.usingMock { Text("Engine not running (mock data)") }
        if model.status == .engineMissing || model.engineInstall == .notInstalled && !model.usingMock {
            Text("Engine not installed")
        }
        if let line = model.transferLine { Text(line) }
        if let err = model.lastError { Text("Error: \(err)").lineLimit(2) }
        Divider()

        if model.drives.isEmpty {
            Text("No drives")
        }
        ForEach(model.drives) { d in
            Menu("\(d.name) — \(d.mountState.rawValue)") {
                if d.mountState == .mounted {
                    Button("Open in Finder") { model.openInFinder(d) }
                    Button("Unmount") { model.unmount(d) }
                } else {
                    Button("Mount") { model.mount(d) }
                        .disabled(d.mountState == .mounting)
                }
            }
        }
        Divider()
        if model.engineInstall == .notRegistered || model.engineInstall == .requiresApproval {
            Button("Enable engine…") { model.installEngine() }
        }
        Button("Settings…") {
            NSApp.activate()
            openSettings()
        }
        .keyboardShortcut(",")
        Button("Quit Unlispace") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
