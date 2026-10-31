import AppKit
import Carbon
import SwiftUI

extension Notification.Name {
    static let workspaceShortcutPressed = Notification.Name("Unlispace.workspaceShortcutPressed")
}

// Space stays fixed so the recorder never captures typing shortcuts or replaces Spotlight.
enum WorkspaceShortcut: String, CaseIterable {
    case option, controlOption, commandOption

    var modifierLabel: String {
        switch self {
        case .option: "⌥"
        case .controlOption: "⌃ ⌥"
        case .commandOption: "⌥ ⌘"
        }
    }
    var label: String { "\(modifierLabel) Space" }
    var modifiers: UInt32 {
        switch self {
        case .option: UInt32(optionKey)
        case .controlOption: UInt32(controlKey | optionKey)
        case .commandOption: UInt32(cmdKey | optionKey)
        }
    }
    static func from(keyCode: UInt16, flags: NSEvent.ModifierFlags) -> Self? {
        guard keyCode == 49 else { return nil }
        switch flags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function]) {
        case [.option]: return .option
        case [.control, .option]: return .controlOption
        case [.command, .option]: return .commandOption
        default: return nil
        }
    }
}

@MainActor final class WorkspaceHotKey {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var current: WorkspaceShortcut?

    func register(_ shortcut: WorkspaceShortcut) -> Bool {
        if current == shortcut, hotKey != nil { return true }
        if handler == nil {
            var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var identifier = EventHotKeyID()
                guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
                      identifier.signature == 0x554C5350, identifier.id == 1 else { return OSStatus(eventNotHandledErr) }
                Task { @MainActor in AppDelegate.openFromShortcut() }
                return noErr
            }, 1, &event, nil, &handler)
            guard status == noErr else { return false }
        }
        var replacement: EventHotKeyRef?
        let status = RegisterEventHotKey(49, shortcut.modifiers,
                                        EventHotKeyID(signature: 0x554C5350, id: 1),
                                        GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &replacement)
        guard status == noErr else { return false }
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = replacement
        current = shortcut
        return true
    }

    func stop() {
        current = nil
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        if let handler { RemoveEventHandler(handler); self.handler = nil }
    }
}

struct ShortcutRecorder: NSViewRepresentable {
    var onRecord: (WorkspaceShortcut?) -> Void
    func makeNSView(context: Context) -> RecorderView { RecorderView(onRecord: onRecord) }
    func updateNSView(_ nsView: RecorderView, context: Context) { nsView.onRecord = onRecord }

    final class RecorderView: NSView {
        var onRecord: (WorkspaceShortcut?) -> Void
        init(onRecord: @escaping (WorkspaceShortcut?) -> Void) {
            self.onRecord = onRecord
            super.init(frame: .zero)
        }
        required init?(coder: NSCoder) { nil }
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); window?.makeFirstResponder(self) }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 53 { onRecord(nil) }
            else if let shortcut = WorkspaceShortcut.from(keyCode: event.keyCode, flags: event.modifierFlags) { onRecord(shortcut) }
            else { NSSound.beep() }
        }
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            if let shortcut = WorkspaceShortcut.from(keyCode: event.keyCode, flags: event.modifierFlags) {
                onRecord(shortcut); return true
            }
            return false
        }
    }
}
