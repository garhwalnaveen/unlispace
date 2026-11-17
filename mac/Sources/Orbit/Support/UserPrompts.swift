import AppKit

/// Blocking questions the model needs answered. Views and tests supply the answers; the model never builds UI.
@MainActor protocol UserPrompts {
    func confirm(title: String, message: String, action: String) -> Bool
    func chooseFile(message: String, action: String) -> URL?
}

struct AppKitPrompts: UserPrompts {
    func confirm(title: String, message: String, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    func chooseFile(message: String, action: String) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = action
        panel.message = message
        return panel.runModal() == .OK ? panel.url : nil
    }
}
