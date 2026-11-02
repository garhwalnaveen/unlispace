import SwiftUI

/// Illustrations, deliberately separate from live account, file, and upload state.
struct OnboardingPreview: View {
    enum Kind { case storage, search, ai }
    var kind: Kind

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                ForEach([Color.red, .yellow, .green], id: \.self) { color in
                    Circle().fill(color.opacity(0.75)).frame(width: 10, height: 10)
                }
                Spacer()
                Text(kind == .storage ? "Orbit in Finder" : kind == .search ? "Search files" : "Ask AI")
                    .font(.system(size: 12, weight: .medium))
                Spacer()
                Text("Preview").font(.system(size: 10)).foregroundStyle(AppDesign.muted)
            }.padding(16).background(AppDesign.subtle)
            switch kind {
            case .storage: finder
            case .search: search
            case .ai: assistant
            }
        }
        .frame(maxWidth: 780)
        .background(AppDesign.surface, in: RoundedRectangle(cornerRadius: 14))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(AppDesign.border))
        .shadow(color: .black.opacity(0.06), radius: 24, y: 12)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(kind == .storage ? "Example: cloud folders and files in Finder" : kind == .search ? "Example: matching filenames in a selected cloud drive" : "Example: a selected text excerpt sent to your chosen AI provider")
    }

    private var finder: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 18) {
                Text("Favorites").font(.system(size: 11, weight: .medium)).foregroundStyle(AppDesign.muted)
                Label("Recents", systemImage: "clock")
                Label("Desktop", systemImage: "menubar.dock.rectangle")
                Label("Documents", systemImage: "doc")
                Text("Locations").font(.system(size: 11, weight: .medium)).foregroundStyle(AppDesign.muted).padding(.top, 10)
                Label("Orbit", systemImage: "externaldrive.fill")
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppDesign.border.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
                Spacer(minLength: 0)
            }.font(.system(size: 12)).padding(18).frame(width: 180).background(AppDesign.subtle.opacity(0.5))
            VStack(spacing: 0) {
                HStack {
                    Text("Your files").font(.system(size: 14, weight: .semibold))
                    Spacer()
                    Image(systemName: "square.grid.2x2")
                    Image(systemName: "magnifyingglass").padding(.leading, 12)
                }.padding(20)
                Divider()
                HStack(alignment: .top, spacing: 30) {
                    file("Projects", symbol: "folder.fill", color: .blue)
                    file("Brand assets", symbol: "folder.fill", color: .blue)
                    file("Proposal.pdf", symbol: "doc.richtext", color: AppDesign.muted)
                }.padding(.top, 42).padding(.horizontal, 24)
                Spacer()
                HStack {
                    Image(systemName: "icloud")
                    Text("Cloud files, available when you need them")
                }.font(.system(size: 11)).foregroundStyle(AppDesign.muted).padding(18)
            }.frame(maxWidth: .infinity)
        }.frame(height: 290)
    }

    private var search: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(AppDesign.muted)
                Text("proposal").font(.system(size: 20))
                Spacer()
                Text("Personal drive").font(.system(size: 12)).foregroundStyle(AppDesign.muted)
            }.padding(22)
            Divider()
            VStack(spacing: 0) {
                result("Project proposal.pdf", path: "Work / Client projects", symbol: "doc.richtext", selected: true)
                result("Proposal notes.txt", path: "Work / Notes", symbol: "doc.text", selected: false)
                result("Proposal assets", path: "Work / Client projects", symbol: "folder", selected: false)
            }.padding(12)
            HStack {
                Text("Search filenames in this drive")
                Spacer()
                Text("Open in Finder  ↵")
            }.font(.system(size: 11)).foregroundStyle(AppDesign.muted).padding(18)
        }.frame(height: 290)
    }

    private var assistant: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Spacer(minLength: 60)
                Text("Summarize the next steps in these project notes.")
                    .padding(14).background(AppDesign.subtle, in: RoundedRectangle(cornerRadius: 12))
            }
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "sparkles").font(.system(size: 22))
                VStack(alignment: .leading, spacing: 10) {
                    Text("Start with a clear plan.").fontWeight(.medium)
                    Text("Review the draft, collect feedback, and share the final files with your team.")
                        .foregroundStyle(AppDesign.muted).lineSpacing(4)
                }
                Spacer()
            }
            Spacer(minLength: 0)
            HStack {
                Label("Selected text only", systemImage: "doc.text")
                Spacer()
                Text("Your chosen provider")
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 24))
            }.font(.system(size: 11)).foregroundStyle(AppDesign.muted)
                .padding(14).overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(AppDesign.border))
        }.font(.system(size: 14)).padding(26).frame(height: 290)
    }

    private func file(_ name: String, symbol: String, color: Color) -> some View {
        VStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 48, weight: .light)).foregroundStyle(color)
            Text(name).font(.system(size: 12)).lineLimit(1)
            Image(systemName: "icloud").font(.system(size: 11)).foregroundStyle(AppDesign.muted)
        }.frame(maxWidth: .infinity)
    }

    private func result(_ title: String, path: String, symbol: String, selected: Bool) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol).font(.system(size: 22)).frame(width: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 14, weight: .medium))
                Text(path).font(.system(size: 11)).foregroundStyle(AppDesign.muted)
            }
            Spacer()
        }.padding(12).background(selected ? AppDesign.subtle : .clear, in: RoundedRectangle(cornerRadius: 8))
    }
}
