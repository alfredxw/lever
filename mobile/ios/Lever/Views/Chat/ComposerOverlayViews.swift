import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - Composer Draft Attachment Model

struct DraftAttachmentItem: Identifiable, Equatable {
    let id: UUID
    var fileName: String
    let isImage: Bool
    var thumbnail: UIImage?
    var uploaded: AttachmentRef?
    var isUploading: Bool
    var error: String?

    static func == (lhs: DraftAttachmentItem, rhs: DraftAttachmentItem) -> Bool {
        lhs.id == rhs.id
            && lhs.fileName == rhs.fileName
            && lhs.uploaded == rhs.uploaded
            && lhs.isUploading == rhs.isUploading
            && lhs.error == rhs.error
    }
}

// MARK: - Live `/` & `@` Input Trigger Detector

enum ComposerTrigger: Equatable {
    case slash(range: Range<String.Index>, query: String)
    case mention(range: Range<String.Index>, query: String)

    static func detect(in text: String) -> ComposerTrigger? {
        guard !text.isEmpty else { return nil }
        // Inspect the trailing token after the last whitespace or newline
        let lastSep = text.lastIndex(where: { $0.isWhitespace || $0.isNewline })
        let tokenStart = lastSep.map { text.index(after: $0) } ?? text.startIndex
        guard tokenStart < text.endIndex else { return nil }
        let token = text[tokenStart..<text.endIndex]
        guard let first = token.first else { return nil }
        let query = String(token.dropFirst())
        // Do not trigger if query looks like a URL or email path segment
        if first == "/" {
            if tokenStart != text.startIndex, let prev = text.index(tokenStart, offsetBy: -1, limitedBy: text.startIndex), !text[prev].isWhitespace && !text[prev].isNewline {
                return nil
            }
            return .slash(range: tokenStart..<text.endIndex, query: query)
        }
        if first == "@" {
            return .mention(range: tokenStart..<text.endIndex, query: query)
        }
        return nil
    }
}

// MARK: - Composer Bottom Model Trigger Pill (Desktop-Aligned: Provider Icon + Name + Effort Icon + Fast)

struct ComposerModelTriggerPill: View {
    let provider: ProviderCatalog?
    let providerId: String?
    let modelName: String
    let effort: String?
    let fast: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                ProviderIconView(
                    providerId: provider?.id ?? providerId,
                    providerType: provider?.type,
                    pluginId: provider?.pluginId,
                    size: 13.5
                )
                .foregroundStyle(LeverTheme.inkSecondary)

                Text(modelName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .lineLimit(1)

                if let effort, !effort.isEmpty {
                    HStack(spacing: 3) {
                        EffortIconView(effort: effort, size: 10.5)
                        Text(formatEffortLabel(effort))
                            .font(.system(size: 11, weight: .regular))
                    }
                    .foregroundStyle(LeverTheme.inkTertiary)
                }

                if fast {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkPrimary)
                }

                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }
            .padding(.horizontal, 9)
            .frame(height: 30)
            .background(LeverTheme.surfaceInset)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Desktop-Aligned `+` Menu (Photos, Files, @ Mentions, / Skills — NO canned prompts)

struct ComposerPlusMenu: View {
    let workingCopies: [DirectoryGroup]
    @Binding var selectedWorkingCopyId: String?
    let onPickPhotos: () -> Void
    let onPickFiles: () -> Void
    let onInsertMention: () -> Void
    let onInsertSlash: () -> Void

    var body: some View {
        Menu {
            Button {
                Haptics.light()
                onPickPhotos()
            } label: {
                Label("添加图片", systemImage: "photo.on.rectangle.angled")
            }

            Button {
                Haptics.light()
                onPickFiles()
            } label: {
                Label("添加文件", systemImage: "doc.badge.plus")
            }

            Divider()

            Button {
                Haptics.light()
                onInsertMention()
            } label: {
                Label("引用话题 / 对话 / Agent (@)", systemImage: "at")
            }

            Button {
                Haptics.light()
                onInsertSlash()
            } label: {
                Label("调用 Skill / 命令 (/)", systemImage: "sparkles")
            }

            if workingCopies.count > 1 {
                Divider()
                Menu {
                    Button {
                        selectedWorkingCopyId = nil
                    } label: {
                        if selectedWorkingCopyId == nil {
                            Label("默认工作副本", systemImage: "checkmark")
                        } else {
                            Text("默认工作副本")
                        }
                    }
                    ForEach(workingCopies) { g in
                        Button {
                            selectedWorkingCopyId = g.id
                        } label: {
                            if selectedWorkingCopyId == g.id {
                                Label(g.name, systemImage: "checkmark")
                            } else {
                                Text(g.name)
                            }
                        }
                    }
                } label: {
                    Label("工作副本", systemImage: "folder")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(LeverTheme.inkSecondary)
                .frame(width: 30, height: 30)
                .background(LeverTheme.surfaceInset)
                .clipShape(Circle())
        }
    }
}

// MARK: - Attached Photos, Files & @/$ Reference Chips Bar

struct ComposerAttachmentsAndRefsBar: View {
    let attachments: [DraftAttachmentItem]
    let references: [MessageReference]
    let onRemoveAttachment: (UUID) -> Void
    let onRemoveReference: (String) -> Void

    var body: some View {
        if !attachments.isEmpty || !references.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 7) {
                    ForEach(attachments) { att in
                        attachmentChip(att)
                    }
                    ForEach(references) { ref in
                        referenceChip(ref)
                    }
                }
                .padding(.horizontal, 2)
                .padding(.bottom, 4)
            }
        }
    }

    private func attachmentChip(_ att: DraftAttachmentItem) -> some View {
        HStack(spacing: 6) {
            if let thumb = att.thumbnail {
                Image(uiImage: thumb)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                Image(systemName: att.isImage ? "photo" : "doc.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(LeverTheme.inkSecondary)
                    .frame(width: 24, height: 24)
                    .background(LeverTheme.surfacePill)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(att.fileName)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(LeverTheme.inkPrimary)
                    .lineLimit(1)
                    .frame(maxWidth: 112, alignment: .leading)
                if att.isUploading {
                    Text("上传中…")
                        .font(.system(size: 10))
                        .foregroundStyle(LeverTheme.inkTertiary)
                } else if let err = att.error {
                    Text(err)
                        .font(.system(size: 10))
                        .foregroundStyle(LeverTheme.unreadRed)
                        .lineLimit(1)
                } else if let size = att.uploaded?.size {
                    Text(formatByteSize(size))
                        .font(.system(size: 10).monospacedDigit())
                        .foregroundStyle(LeverTheme.inkTertiary)
                }
            }

            if att.isUploading {
                ProgressView()
                    .scaleEffect(0.62)
                    .tint(LeverTheme.inkSecondary)
            } else {
                Button {
                    Haptics.light()
                    onRemoveAttachment(att.id)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(LeverTheme.inkTertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(LeverTheme.surfaceInset)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(att.error != nil ? LeverTheme.unreadRed.opacity(0.45) : LeverTheme.hairline, lineWidth: 0.5)
        )
    }

    private func referenceChip(_ ref: MessageReference) -> some View {
        HStack(spacing: 5) {
            Image(systemName: referenceIcon(ref.kind))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(LeverTheme.inkSecondary)
            Text("\(ref.kind == "skill" ? "$" : "@")\(ref.name)")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(LeverTheme.inkPrimary)
                .lineLimit(1)
                .frame(maxWidth: 140, alignment: .leading)
            Button {
                Haptics.light()
                onRemoveReference(ref.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9.5, weight: .bold))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5.5)
        .background(LeverTheme.surfacePill)
        .clipShape(Capsule())
    }

    private func referenceIcon(_ kind: String) -> String {
        switch kind {
        case "skill": return "sparkles"
        case "topic": return "number"
        case "chat": return "bubble.left"
        case "agent": return "cpu"
        default: return "at"
        }
    }
}

// MARK: - Live Floating Suggestion Tray for `/` (Skills + Slash Commands) and `@` (Topics / Chats / Agents)

struct ComposerSuggestionTray: View {
    let trigger: ComposerTrigger
    let skills: [MessageReference]
    let slashCommands: [SlashCommandOption]
    let mentionGroups: [(label: String, items: [MessageReference])]
    let allowModeCommands: Bool
    let onSelectSkill: (MessageReference) -> Void
    let onSelectSlashCommand: (String) -> Void
    let onSelectMention: (MessageReference) -> Void
    let onDismiss: () -> Void

    private var filteredSkills: [MessageReference] {
        guard case .slash(_, let q) = trigger else { return [] }
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let onlySkills = skills.filter { $0.kind == "skill" }
        guard !trimmed.isEmpty else { return Array(onlySkills.prefix(12)) }
        return onlySkills.filter {
            $0.name.lowercased().contains(trimmed)
                || ($0.description ?? "").lowercased().contains(trimmed)
        }
    }

    private var filteredCommands: [SlashCommandOption] {
        guard case .slash(_, let q) = trigger else { return [] }
        let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var merged: [SlashCommandOption] = []
        var seen = Set<String>()
        if allowModeCommands {
            let builtIn = [
                SlashCommandOption(name: "topic", description: "切换为发起独立话题", argumentHint: nil),
                SlashCommandOption(name: "chat", description: "切换为当前主对话发送", argumentHint: nil),
            ]
            for c in builtIn {
                seen.insert(c.name)
                merged.append(c)
            }
        }
        for c in slashCommands where !seen.contains(c.name) {
            seen.insert(c.name)
            merged.append(c)
        }
        // Include non-skill slash items returned by `Suggestions(..., "slash")`
        for ref in skills where ref.kind != "skill" && !seen.contains(ref.name) {
            seen.insert(ref.name)
            merged.append(SlashCommandOption(name: ref.name, description: ref.description, argumentHint: ref.argumentHint))
        }
        guard !trimmed.isEmpty else { return Array(merged.prefix(10)) }
        return merged.filter {
            $0.name.lowercased().contains(trimmed)
                || ($0.description ?? "").lowercased().contains(trimmed)
        }
    }

    private var hasAnyItem: Bool {
        switch trigger {
        case .slash:
            return !filteredSkills.isEmpty || !filteredCommands.isEmpty
        case .mention:
            return mentionGroups.contains { !$0.items.isEmpty }
        }
    }

    var body: some View {
        if hasAnyItem {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(headerTitle)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(LeverTheme.inkTertiary)
                    Spacer()
                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(LeverTheme.inkTertiary)
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(LeverTheme.surfaceElevated)

                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        switch trigger {
                        case .slash:
                            if !filteredSkills.isEmpty {
                                sectionTitle("Skills")
                                ForEach(filteredSkills) { skill in
                                    Button {
                                        Haptics.light()
                                        onSelectSkill(skill)
                                    } label: {
                                        HStack(spacing: 9) {
                                            Image(systemName: "sparkles")
                                                .font(.system(size: 13, weight: .medium))
                                                .foregroundStyle(LeverTheme.inkSecondary)
                                                .frame(width: 22)
                                            VStack(alignment: .leading, spacing: 1.5) {
                                                Text(skill.name)
                                                    .font(.system(size: 13.5, weight: .semibold))
                                                    .foregroundStyle(LeverTheme.inkPrimary)
                                                    .lineLimit(1)
                                                if let desc = skill.description, !desc.isEmpty {
                                                    Text(desc)
                                                        .font(.system(size: 11.5))
                                                        .foregroundStyle(LeverTheme.inkTertiary)
                                                        .lineLimit(1)
                                                }
                                            }
                                            Spacer(minLength: 4)
                                            Text("Skill")
                                                .font(.system(size: 10, weight: .medium))
                                                .foregroundStyle(LeverTheme.inkTertiary)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(LeverTheme.surfaceInset)
                                                .clipShape(Capsule())
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8.5)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            if !filteredCommands.isEmpty {
                                sectionTitle("命令")
                                ForEach(filteredCommands) { cmd in
                                    Button {
                                        Haptics.light()
                                        onSelectSlashCommand(cmd.name)
                                    } label: {
                                        HStack(spacing: 9) {
                                            Image(systemName: "terminal")
                                                .font(.system(size: 12.5, weight: .medium))
                                                .foregroundStyle(LeverTheme.inkSecondary)
                                                .frame(width: 22)
                                            VStack(alignment: .leading, spacing: 1.5) {
                                                Text("/\(cmd.name)")
                                                    .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                                                    .foregroundStyle(LeverTheme.inkPrimary)
                                                    .lineLimit(1)
                                                let desc = [cmd.argumentHint, cmd.description]
                                                    .compactMap { $0 }
                                                    .filter { !$0.isEmpty }
                                                    .joined(separator: " · ")
                                                if !desc.isEmpty {
                                                    Text(desc)
                                                        .font(.system(size: 11.5))
                                                        .foregroundStyle(LeverTheme.inkTertiary)
                                                        .lineLimit(1)
                                                }
                                            }
                                            Spacer()
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8.5)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                        case .mention:
                            ForEach(mentionGroups, id: \.label) { group in
                                sectionTitle(group.label)
                                ForEach(group.items) { ref in
                                    Button {
                                        Haptics.light()
                                        onSelectMention(ref)
                                    } label: {
                                        HStack(spacing: 9) {
                                            Image(systemName: mentionIcon(ref.kind))
                                                .font(.system(size: 13, weight: .medium))
                                                .foregroundStyle(LeverTheme.inkSecondary)
                                                .frame(width: 22)
                                            VStack(alignment: .leading, spacing: 1.5) {
                                                Text(ref.name)
                                                    .font(.system(size: 13.5, weight: .medium))
                                                    .foregroundStyle(LeverTheme.inkPrimary)
                                                    .lineLimit(1)
                                                if let desc = ref.description, !desc.isEmpty {
                                                    Text(desc)
                                                        .font(.system(size: 11.5))
                                                        .foregroundStyle(LeverTheme.inkTertiary)
                                                        .lineLimit(1)
                                                }
                                            }
                                            Spacer()
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 8.5)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                .frame(maxHeight: 224)
            }
            .background(LeverTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .strokeBorder(LeverTheme.hairlineStrong, lineWidth: 0.5)
            )
            .shadow(color: Color.black.opacity(0.12), radius: 16, x: 0, y: -4)
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    private var headerTitle: String {
        switch trigger {
        case .slash: return "Skills 与斜杠命令"
        case .mention: return "引用话题、对话或 Agent"
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(LeverTheme.inkTertiary)
            .padding(.horizontal, 12)
            .padding(.top, 7)
            .padding(.bottom, 3)
    }

    private func mentionIcon(_ kind: String) -> String {
        switch kind {
        case "topic": return "number"
        case "chat": return "bubble.left"
        case "agent": return "cpu"
        default: return "at"
        }
    }
}

// MARK: - Searchable Mention Picker Sheet (Triggered from `+` Menu)

struct MentionPickerSheetView: View {
    let store: LeverStore
    let deviceId: String
    let currentAgentId: String
    let currentSessionId: String?
    let onSelect: (MessageReference) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var groups: [(label: String, items: [MessageReference])] {
        store.mentionCandidates(
            deviceId: deviceId,
            currentAgentId: currentAgentId,
            currentSessionId: currentSessionId,
            query: query
        )
    }

    var body: some View {
        NavigationStack {
            List {
                if groups.isEmpty {
                    Text("未找到可引用的话题、对话或 Agent")
                        .font(.system(size: 14))
                        .foregroundStyle(LeverTheme.inkTertiary)
                } else {
                    ForEach(groups, id: \.label) { group in
                        Section(group.label) {
                            ForEach(group.items) { ref in
                                Button {
                                    Haptics.light()
                                    onSelect(ref)
                                    dismiss()
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: ref.kind == "topic" ? "number" : (ref.kind == "chat" ? "bubble.left" : "cpu"))
                                            .font(.system(size: 14))
                                            .foregroundStyle(LeverTheme.inkSecondary)
                                            .frame(width: 22)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(ref.name)
                                                .font(.system(size: 14.5, weight: .medium))
                                                .foregroundStyle(LeverTheme.inkPrimary)
                                                .lineLimit(1)
                                            if let desc = ref.description, !desc.isEmpty {
                                                Text(desc)
                                                    .font(.system(size: 12))
                                                    .foregroundStyle(LeverTheme.inkTertiary)
                                                    .lineLimit(1)
                                            }
                                        }
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "搜索话题、对话或 Agent")
            .navigationTitle("引用上下文 (@)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(LeverTheme.inkPrimary)
                }
            }
        }
    }
}

// MARK: - Off-Main-Thread Image & File Preparation Helpers

enum ComposerMediaHelper {
    /// Converts a PhotosPickerItem to compressed JPEG data (<= 3.5 MiB) + small thumbnail off the main thread.
    static func preparePhoto(item: PhotosPickerItem, index: Int) async -> (fileName: String, data: Data, thumbnail: UIImage?)? {
        guard let rawData = try? await item.loadTransferable(type: Data.self), !rawData.isEmpty else {
            return nil
        }
        return await Task.detached(priority: .userInitiated) {
            guard let img = UIImage(data: rawData) else {
                return ("photo_\(index).jpg", rawData, nil)
            }
            let maxEdge: CGFloat = 2048
            let resized: UIImage
            let w = img.size.width, h = img.size.height
            if max(w, h) > maxEdge {
                let scale = maxEdge / max(w, h)
                let targetSize = CGSize(width: w * scale, height: h * scale)
                let renderer = UIGraphicsImageRenderer(size: targetSize)
                resized = renderer.image { _ in img.draw(in: CGRect(origin: .zero, size: targetSize)) }
            } else {
                resized = img
            }
            let thumbSize = CGSize(width: 96, height: 96)
            let thumb = UIGraphicsImageRenderer(size: thumbSize).image { _ in
                resized.draw(in: CGRect(origin: .zero, size: thumbSize))
            }
            var quality: CGFloat = 0.82
            var jpeg = resized.jpegData(compressionQuality: quality) ?? rawData
            while jpeg.count > 3_500_000 && quality > 0.35 {
                quality -= 0.15
                if let smaller = resized.jpegData(compressionQuality: quality) {
                    jpeg = smaller
                } else {
                    break
                }
            }
            let stamp = Int(Date().timeIntervalSince1970)
            return ("IMG_\(stamp)_\(index).jpg", jpeg, thumb)
        }.value
    }

    /// Reads a security-scoped file URL from `.fileImporter` (max 8 MiB over LAN JSON).
    static func prepareFile(url: URL) async -> (fileName: String, data: Data, isImage: Bool, thumbnail: UIImage?)? {
        await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= 8_000_000 else {
                return nil
            }
            let name = url.lastPathComponent.isEmpty ? "file.bin" : url.lastPathComponent
            let ext = url.pathExtension.lowercased()
            let isImg = ["png", "jpg", "jpeg", "webp", "gif", "heic"].contains(ext)
            var thumb: UIImage? = nil
            if isImg, let img = UIImage(data: data) {
                let s = CGSize(width: 96, height: 96)
                thumb = UIGraphicsImageRenderer(size: s).image { _ in img.draw(in: CGRect(origin: .zero, size: s)) }
            }
            return (name, data, isImg, thumb)
        }.value
    }

    /// Computes UTF-16 start/end offsets for `@` and `$` references matching Lever Desktop's `prompt.ts`.
    static func resolveReferences(in text: String, references: [MessageReference]) -> [MessageReference] {
        guard !references.isEmpty else { return [] }
        let ns = text as NSString
        var out: [MessageReference] = []
        var searchLocation = 0
        for ref in references {
            let token = "\(ref.kind == "skill" ? "$" : "@")\(ref.name)"
            let remaining = NSRange(location: min(searchLocation, ns.length), length: max(0, ns.length - min(searchLocation, ns.length)))
            var found = ns.range(of: token, options: [], range: remaining)
            if found.location == NSNotFound {
                found = ns.range(of: token)
            }
            if found.location != NSNotFound {
                let start = found.location
                let end = found.location + found.length
                searchLocation = end
                out.append(MessageReference(
                    kind: ref.kind,
                    name: ref.name,
                    refId: ref.refId,
                    path: ref.path,
                    provider: ref.provider,
                    description: ref.description,
                    argumentHint: ref.argumentHint,
                    start: start,
                    end: end
                ))
            } else {
                out.append(ref)
            }
        }
        return out
    }
}
