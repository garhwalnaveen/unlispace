import SwiftUI
import UnlispaceKit

@main
struct UnlispaceApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
                .task { model.start() }
        } label: {
            Image(systemName: model.symbolName)
        }
        Settings {
            SettingsView(model: model)
        }
    }
}
