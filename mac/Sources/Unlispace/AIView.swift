import SwiftUI
import AppKit
import UnlispaceKit

struct AIView: View {
    @State private var endpoint = UserDefaults.standard.string(forKey: "ai.endpoint") ?? ""
    @State private var model = UserDefaults.standard.string(forKey: "ai.model") ?? ""
    @State private var preset = AIProviderPreset.matching(endpoint: UserDefaults.standard.string(forKey: "ai.endpoint") ?? "")
    @State private var newKey = ""
    @State private var hasKey = false
    @State private var configuring = true
    @State private var prompt = ""
    @State private var attachment: AITextAttachment?
    @State private var messages: [AIMessage] = []
    @State private var error: String?
    @State private var feedback: String?
    @State private var task: Task<Void, Never>?
    @State private var readingAttachment = false
    private let keychain = Keychain()

    private var configuration: AIConfiguration? { try? AIConfiguration(endpoint: endpoint, model: model) }
    private var credentialAccount: String? { AIConfiguration.validEndpoint(endpoint).map { AIConfiguration.keychainAccount(for: $0) } }
    private var busy: Bool { task != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            DisclosureGroup("AI provider", isExpanded: $configuring) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Choose your AI provider, then enter a model ID and API key from that provider. Provider charges may apply.")
                        .font(.callout).foregroundStyle(AppDesign.muted)
                    Picker("Provider", selection: $preset) {
                        ForEach(AIProviderPreset.allCases) { Text($0.title).tag($0) }
                    }
                    .onChange(of: preset) { _, new in if let url = new.endpoint { endpoint = url } }
                    TextField("Chat completions URL", text: $endpoint)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("AI chat completions endpoint")
                    if preset == .custom {
                        Text("Enter the full URL for an OpenAI-compatible chat completions API.")
                            .font(.caption).foregroundStyle(AppDesign.muted)
                    }
                    TextField("Model ID", text: $model, prompt: Text("Model ID from your provider"))
                        .textFieldStyle(.roundedBorder)
                    if AIConfiguration.validEndpoint(endpoint) == nil && !endpoint.isEmpty {
                        Text("Use an HTTPS URL. Plain HTTP works only for localhost.").font(.caption).foregroundStyle(.red)
                    }
                    SecureField(hasKey ? "Replace saved API key (optional)" : "API key", text: $newKey)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("AI provider API key")
                    HStack {
                        Button("Save provider") { saveProvider() }.buttonStyle(.borderedProminent)
                        if hasKey {
                            Label("Key saved in Keychain", systemImage: "key")
                                .font(.caption).foregroundStyle(AppDesign.muted)
                            Button("Remove key") { removeKey() }
                        }
                    }
                    Text("Keys are saved for this exact endpoint. Changing the endpoint requires its own key. Credentials stay on this Mac and are sent only to that endpoint; redirects are refused.")
                        .font(.caption).foregroundStyle(AppDesign.muted)
                }.padding(.top, 12)
            }
            .padding(20).appPanel()
            .disabled(busy)
            if let feedback { Text(feedback).font(.callout).foregroundStyle(AppDesign.muted) }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
            ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
                VStack(alignment: .leading, spacing: 6) {
                    Label(message.role == .user ? "You" : "AI", systemImage: message.role == .user ? "person.crop.circle" : "sparkles")
                        .font(.headline)
                    Text(message.content).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.padding(16).appPanel()
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("Ask about a text file or paste the information you want to discuss.").font(.headline)
                TextEditor(text: $prompt).font(.body).frame(minHeight: 100, maxHeight: 180)
                    .scrollContentBackground(.hidden).padding(8).appPanel().accessibilityLabel("Question for AI")
                    .disabled(busy)
                if let attachment {
                    HStack {
                        Label("\(attachment.name) · \(attachment.text.utf8.count) bytes", systemImage: "doc.text")
                        Button("Remove attachment") { self.attachment = nil }.disabled(busy)
                    }
                    DisclosureGroup("Preview attached text") {
                        ScrollView { Text(attachment.text).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            .frame(maxHeight: 180)
                    }
                }
                Text("Send shares your prompt, the conversation above, and any attached text with \(configuration?.endpoint.host ?? "your configured provider"). No other files are accessed. Provider charges may apply.")
                    .font(.caption).foregroundStyle(AppDesign.muted)
                HStack {
                    Button(readingAttachment ? "Reading text…" : "Attach text file…") { attachText() }
                        .disabled(busy || readingAttachment)
                    Spacer()
                    Button("New conversation") { messages = []; error = nil; feedback = nil; attachment = nil }
                        .disabled(busy || messages.isEmpty)
                    if busy {
                        ProgressView().controlSize(.small)
                        Button("Cancel") { task?.cancel() }
                    } else {
                        Button("Send") { send() }.buttonStyle(.borderedProminent)
                            .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || configuration == nil || !hasKey || readingAttachment)
                    }
                }
                Text("Text attachments are limited to 64 KB. This conversation stays in memory until the window closes or you change accounts. Answers are generated; verify important details against your files.")
                    .font(.caption).foregroundStyle(AppDesign.muted)
            }
        }
        .onAppear { refreshKeyStatus(); configuring = !hasKey }
        .onChange(of: endpoint) { _, new in
            refreshKeyStatus(); messages = []; feedback = nil
            let match = AIProviderPreset.matching(endpoint: new)
            if match != preset { preset = match }
        }
        .onChange(of: model) { _, _ in messages = []; feedback = nil }
        .onDisappear { task?.cancel() }
    }

    private func refreshKeyStatus() {
        guard let account = credentialAccount else { hasKey = false; return }
        hasKey = ((try? keychain.get(account: account)) ?? nil) != nil
    }

    private func saveProvider() {
        do {
            let config = try AIConfiguration(endpoint: endpoint, model: model)
            let key = newKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if !key.isEmpty {
                guard !key.contains(where: \.isNewline) else { throw AIError.missingKey }
                try keychain.set(key, account: config.keychainAccount)
                newKey = ""
            }
            guard try keychain.get(account: config.keychainAccount) != nil else { throw AIError.missingKey }
            UserDefaults.standard.set(config.endpoint.absoluteString, forKey: "ai.endpoint")
            UserDefaults.standard.set(config.model, forKey: "ai.model")
            hasKey = true
            configuring = false
            error = nil
            feedback = "Provider saved. Send a question when you are ready."
        } catch { self.error = error is AIError ? error.localizedDescription : "Could not save your API key in Keychain." }
    }

    private func removeKey() {
        guard let account = credentialAccount else { return }
        do {
            try keychain.delete(account: account)
            hasKey = false; newKey = ""; messages = []; feedback = "API key removed."; error = nil
        } catch { self.error = "Could not remove the API key from Keychain." }
    }

    private func attachText() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose a UTF-8 text file, up to 64 KB. It will be sent to your provider only when you press Send."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        readingAttachment = true
        Task {
            defer { readingAttachment = false }
            do {
                let value = try await Task.detached { try AITextAttachment.read(url) }.value
                attachment = value; error = nil
            } catch { self.error = "Could not read this file. Choose a readable UTF-8 text file no larger than 64 KB." }
        }
    }

    private func send() {
        guard !busy, let config = configuration else { return }
        let question = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }
        let content = attachment?.message(for: question) ?? question
        let next = messages + [AIMessage(role: .user, content: content)]
        do {
            guard let key = try keychain.get(account: config.keychainAccount) else { throw AIError.missingKey }
            // Validate size before the network task so the user's draft is kept on rejection.
            guard next.count <= AIClient.maxMessages, next.reduce(0, { $0 + $1.content.utf8.count }) < AIClient.maxRequestBytes - 4096 else { throw AIError.requestTooLarge }
            error = nil; feedback = nil
            task = Task {
                defer { task = nil }
                do {
                    let answer = try await AIClient().complete(configuration: config, key: key, messages: next)
                    try Task.checkCancellation()
                    messages = next + [AIMessage(role: .assistant, content: answer)]
                    prompt = ""; attachment = nil
                } catch is CancellationError { feedback = "Request cancelled. Your draft is still here." }
                catch { self.error = error.localizedDescription }
            }
        } catch { self.error = error is AIError ? error.localizedDescription : "Could not read the saved API key from Keychain." }
    }
}
