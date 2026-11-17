import AppKit
import SwiftUI
import OrbitKit

/// Searches file and folder names in one drive. The server does the search, a page at a time.
struct FileSearchView: View {
    var model: AppModel
    @FocusState private var fieldFocused: Bool
    @State private var driveId = ""
    @State private var query = ""
    @State private var results: [FileSearchEntry] = []
    @State private var seen: Set<String> = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var searched = false
    @State private var submitted = 0

    static let minimumQueryLength = 3

    private var store: DriveStore { model.drives }
    private var drive: DriveInfo? { store.drive(id: driveId) }
    private var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSearch: Bool { model.isLive && drive != nil && term.count >= Self.minimumQueryLength }
    /// Any change to this restarts the search.
    private var searchKey: String {
        "\(model.session.account?.id ?? "")|\(model.isLive)|\(drive != nil)|\(driveId)|\(term)|\(submitted)"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if store.drives.count > 1 {
                    Picker("Drive", selection: $driveId) {
                        Text("Choose a drive").tag("")
                        ForEach(store.drives) { Text($0.name).tag($0.driveId) }
                    }
                    .labelsHidden().frame(maxWidth: 200).accessibilityLabel("Drive to search")
                }
                TextField("Search", text: $query, prompt: Text("File or folder name"))
                    .textFieldStyle(.roundedBorder).focused($fieldFocused)
                    .onSubmit { submitted += 1 }
                    .accessibilityLabel("File or folder name")
                if loading { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            Divider()
            if let error { InlineMessage(kind: .error, text: error) }
            content
        }
        .onAppear { fieldFocused = true }
        .onChange(of: store.drives.map(\.driveId), initial: true) { _, ids in
            driveId = Self.selectedDrive(driveId, available: ids)
        }
        .task(id: searchKey) {
            results = []; seen = []; cursor = nil; searched = false; error = nil; loading = false
            guard canSearch else { return }
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await search(key: searchKey)
        }
    }

    @ViewBuilder private var content: some View {
        if !model.isLive {
            ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass",
                                   description: Text("Search works once you are signed in and connected."))
        } else if !results.isEmpty || cursor != nil {
            // A page can be empty and still have a successor, so keep paging until the cursor ends.
            List {
                ForEach(results) { entry in
                    row(entry)
                }
                if cursor != nil {
                    // Appearing at the end of the list loads the next page.
                    HStack { Spacer(); ProgressView().controlSize(.small); Spacer() }
                        .task(id: cursor) { await search(key: searchKey) }
                }
            }
            .listStyle(.inset).scrollContentBackground(.hidden)
        } else if searched && !loading && error == nil {
            ContentUnavailableView.search(text: term)
        } else {
            ContentUnavailableView("Search file names", systemImage: "magnifyingglass",
                                   description: Text(store.drives.count > 1 && drive == nil
                                                     ? "Choose a drive, then type at least \(Self.minimumQueryLength) characters."
                                                     : "Type at least \(Self.minimumQueryLength) characters. Search needs an internet connection."))
        }
    }

    private func row(_ entry: FileSearchEntry) -> some View {
        HStack(spacing: 10) {
            Image(systemName: entry.type == "folder" ? "folder" : "doc").foregroundStyle(.secondary)
                .frame(width: 18).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.path).lineLimit(1).truncationMode(.middle).help(entry.path)
                if entry.type != "folder" {
                    Text(Format.bytes(entry.size)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if let drive, drive.mountState == .mounted, let path = drive.mountPath, let url = entry.localURL(mountPath: path) {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            } else if let drive {
                Button("Mount") { store.mount(drive) }.disabled(store.isBusy(drive))
                    .help("Mount \(drive.name) to show this in Finder")
            }
        }
        .padding(.vertical, 2)
    }

    /// Keeps a valid selection and picks the drive automatically when there is only one.
    static func selectedDrive(_ current: String, available: [String]) -> String {
        if available.contains(current) { return current }
        return available.count == 1 ? available[0] : ""
    }

    private func search(key: String) async {
        guard canSearch, !loading else { return }
        loading = true
        error = nil
        defer { if key == searchKey { loading = false } }
        do {
            let client = try model.engine.connectedClient()
            let page = try await client.searchFiles(driveId: driveId, query: term, cursor: cursor)
            guard !Task.isCancelled, key == searchKey else { return }
            results += page.entries.filter { seen.insert($0.path).inserted }
            cursor = page.cursor
            searched = true
        } catch {
            guard !Task.isCancelled, key == searchKey else { return }
            cursor = nil
            self.error = "Search failed: \(LogFormat.describe(error))"
        }
    }
}
