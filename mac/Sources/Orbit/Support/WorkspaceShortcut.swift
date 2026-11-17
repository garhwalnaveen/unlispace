import Carbon

/// The shortcut is always a modifier plus Space. Command–Space is left out because it belongs to Spotlight.
enum WorkspaceShortcut: String, CaseIterable, Identifiable {
    case option, controlOption, commandOption

    var id: Self { self }
    var label: String {
        switch self {
        case .option: "⌥Space"
        case .controlOption: "⌃⌥Space"
        case .commandOption: "⌥⌘Space"
        }
    }
    var modifiers: UInt32 {
        switch self {
        case .option: UInt32(optionKey)
        case .controlOption: UInt32(controlKey | optionKey)
        case .commandOption: UInt32(cmdKey | optionKey)
        }
    }
}

/// Registers one system-wide hot key with Carbon, the only API that needs no accessibility permission.
@MainActor final class WorkspaceHotKey {
    var onPress: (@MainActor () -> Void)?
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var current: WorkspaceShortcut?

    private static let signature: OSType = 0x554C5350
    private static let spaceKeyCode: UInt32 = 49

    func register(_ shortcut: WorkspaceShortcut) -> Bool {
        if current == shortcut, hotKey != nil { return true }
        if handler == nil {
            var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                var identifier = EventHotKeyID()
                guard let context,
                      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
                      identifier.signature == 0x554C5350, identifier.id == 1 else { return OSStatus(eventNotHandledErr) }
                let owner = Unmanaged<WorkspaceHotKey>.fromOpaque(context).takeUnretainedValue()
                Task { @MainActor in owner.onPress?() }
                return noErr
            }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard status == noErr else { return false }
        }
        var replacement: EventHotKeyRef?
        let status = RegisterEventHotKey(Self.spaceKeyCode, shortcut.modifiers,
                                         EventHotKeyID(signature: Self.signature, id: 1),
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
