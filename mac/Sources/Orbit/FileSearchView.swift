import SwiftUI
import OrbitKit

struct FileSearchView: View {
    var model: AppModel
    @Binding var searchRequest: Int
    @FocusState private var searchFocused: Bool

    init(model: AppModel, searchRequest: Binding<Int> = .constant(0)) {
        self.model = model
        self._searchRequest = searchRequest
    }
    @State private var driveId = ""
    @State private var query = ""
    @State private var results: [FileSearchEntry] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var searched = false
    @State private var revision = 0
    @State private var moreTask: Task<Void, Never>?
    private var searchKey: String { "\(model.account?.id ?? "")|\(model.usingMock)|\(model.hasDevToken)|\(drive != nil)|\(driveId)|\(query)|\(revision)" }
    private var drive: DriveInfo? { model.drives.first { $0.driveId == driveId } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .bottom, spacing: 12) {
                if model.drives.count > 1 {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Drive").font(.caption).foregroundStyle(AppDesign.muted)
                        Picker("Drive", selection: $driveId) {
                            Text("Choose a drive").tag("")
                            ForEach(model.drives) { Text($0.name).tag($0.driveId) }
                        }.labelsHidden().frame(width: 160)
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Filename").font(.caption).foregroundStyle(AppDesign.muted)
                    TextField("3 or more characters", text: $query).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Search filenames").focused($searchFocused).onSubmit { revision += 1 }
                }
                Button("Search") { revision += 1 }.disabled(!canSearch).buttonStyle(.borderedProminent)
            }.padding(16).appPanel()
            Text("Search file and folder names in a drive. Internet required.")
                .font(.callout).foregroundStyle(AppDesign.muted)
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
            if !model.isSignedIn && !model.hasDevToken {
                Text("Sign in to search your files.").foregroundStyle(AppDesign.muted)
            }
            if loading { ProgressView("Searching…") }
            if results.isEmpty, searched, !loading, error == nil {
                ContentUnavailableView("No matching files", systemImage: "magnifyingglass", description: Text("Try another filename."))
            }
            if !results.isEmpty {
                VStack(spacing: 0) {
                    ForEach(results) { entry in
                        if entry.id != results.first?.id { Divider() }
                        HStack(spacing: 12) {
                            Image(systemName: entry.type == "folder" ? "folder" : "doc")
                            VStack(alignment: .leading) {
                                Text(entry.path).textSelection(.enabled)
                                if entry.type != "folder" { Text(ByteCountFormatter.string(fromByteCount: entry.size, countStyle: .file)).font(.caption).foregroundStyle(AppDesign.muted) }
                            }
                            Spacer()
                            if let drive, drive.mountState == .mounted, let path = drive.mountPath,
                               let url = entry.localURL(mountPath: path) {
                                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                            } else if let drive {
                                Button("Mount drive") { model.mount(drive) }.disabled(model.isDriveBusy(drive))
                            }
                        }.padding(16)
                    }
                }.appPanel()
            }
            if cursor != nil {
                Button("More results") {
                    moreTask?.cancel()
                    moreTask = Task { await search(append: true) }
                }.disabled(loading)
            }
        }
        .task(id: searchRequest) {
            if searchRequest > 0 {
                await Task.yield()
                searchFocused = true
            }
        }
        .onChange(of: model.drives.map(\.driveId), initial: true) { _, ids in
            driveId = Self.selectedDrive(driveId, available: ids)
        }
        .task(id: searchKey) {
            moreTask?.cancel(); results = []; cursor = nil; searched = false; error = nil; loading = false
            guard canSearch else { return }
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await search(append: false)
        }
        .onDisappear { moreTask?.cancel() }
    }
    static func selectedDrive(_ current: String, available: [String]) -> String {
        if available.contains(current) { return current }
        return available.count == 1 ? available[0] : ""
    }
    private var canSearch: Bool { !model.usingMock && (model.isSignedIn || model.hasDevToken) && drive != nil && query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3 }
    private func search(append: Bool) async {
        let key = searchKey
        loading = true; error = nil
        defer { if key == searchKey { loading = false } }
        do {
            let page = try await model.searchFiles(driveId: driveId, query: query.trimmingCharacters(in: .whitespacesAndNewlines), cursor: append ? cursor : nil)
            guard !Task.isCancelled, key == searchKey else { return }
            let existing = Set(results.map(\.path))
            results = append ? results + page.entries.filter { !existing.contains($0.path) } : page.entries
            cursor = page.cursor; searched = true
        } catch {
            guard !Task.isCancelled, key == searchKey else { return }
            self.error = "Search failed: \(LogFormat.describe(error))"
        }
    }
}
