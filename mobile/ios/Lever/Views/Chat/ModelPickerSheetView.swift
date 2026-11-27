import SwiftUI

/// Desktop-aligned Multi-Provider Model, Starred Favorites, Reasoning Effort, and Speed Picker.
struct ModelPickerSheetView: View {
    @Bindable var store: LeverStore
    let deviceId: String
    let agentId: String
    let defaultProviderId: String?
    let defaultModelId: String?
    let defaultEffort: String?
    let defaultFast: Bool
    let defaultBadgeText: String
    let fallbackAgent: ArchiveRecord?

    @Binding var selectedProviderId: String?
    @Binding var selectedModelId: String?
    @Binding var selectedEffort: String?
    @Binding var selectedFast: Bool?

    @Environment(\.dismiss) private var dismiss
    @State private var activeTab: ProviderRailTab = .provider("")
    @State private var searchText = ""
    @State private var didInitTab = false

    private enum ProviderRailTab: Hashable {
        case favorites
        case provider(String)
    }

    private struct ModelRowEntry: Identifiable {
        let provider: ProviderCatalog
        let model: ModelOption
        let starred: Bool
        var id: String { "\(provider.id):\(model.id)" }
    }

    private var providers: [ProviderCatalog] {
        store.providerCatalogs(deviceId: deviceId, fallbackAgent: fallbackAgent)
    }

    private var effectiveProviderId: String {
        selectedProviderId ?? defaultProviderId ?? providers.first?.id ?? ""
    }

    private var effectiveModelId: String {
        selectedModelId ?? defaultModelId ?? ""
    }

    private var effectiveFast: Bool {
        selectedFast ?? defaultFast
    }

    private var starredMap: [String: Set<String>] {
        store.starredModels(deviceId: deviceId)
    }

    private var totalStarredCount: Int {
        starredMap.values.reduce(0) { $0 + $1.count }
    }

    private var activeProvider: ProviderCatalog? {
        providers.first(where: { $0.id == effectiveProviderId }) ?? providers.first
    }

    private var activeModelOption: ModelOption? {
        guard let prov = activeProvider else { return nil }
        return (prov.models ?? []).first(where: { $0.id == effectiveModelId })
    }

    private var visibleEntries: [ModelRowEntry] {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let sourceProviders: [ProviderCatalog]
        let onlyStarred: Bool
        switch activeTab {
        case .favorites:
            sourceProviders = providers
            onlyStarred = true
        case .provider(let pid):
            if let match = providers.first(where: { $0.id == pid }) {
                sourceProviders = [match]
            } else {
                sourceProviders = activeProvider.map { [$0] } ?? []
            }
            onlyStarred = false
        }

        var entries: [ModelRowEntry] = []
        for prov in sourceProviders {
            let starredSet = starredMap[prov.id] ?? []
            var list = prov.models ?? []
            if !onlyStarred && prov.id == effectiveProviderId && !effectiveModelId.isEmpty && !list.contains(where: { $0.id == effectiveModelId }) {
                list.insert(
                    ModelOption(id: effectiveModelId, name: effectiveModelId, description: nil, resolvedModel: nil, efforts: nil, defaultEffort: nil, fast: nil),
                    at: 0
                )
            }
            for m in list {
                let isStar = starredSet.contains(m.id)
                if onlyStarred && !isStar { continue }
                if !q.isEmpty {
                    let hay = [m.displayName, m.id, m.resolvedModel ?? "", onlyStarred ? prov.name : ""]
                        .joined(separator: " ")
                        .lowercased()
                    if !hay.contains(q) { continue }
                }
                entries.append(ModelRowEntry(provider: prov, model: m, starred: isStar))
            }
        }

        return entries.sorted { lhs, rhs in
            if lhs.starred != rhs.starred { return lhs.starred }
            return false
        }
    }

    private var availableEfforts: [String] {
        activeModelOption?.efforts ?? []
    }

    private var effectiveEffort: String {
        if let e = selectedEffort, !e.isEmpty { return e }
        if selectedModelId == nil && selectedProviderId == nil, let def = defaultEffort, !def.isEmpty {
            return def
        }
        return activeModelOption?.defaultEffort ?? availableEfforts.last ?? ""
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                providerRail
                searchBar
                Rectangle().fill(LeverTheme.hairline).frame(height: 0.5)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if visibleEntries.isEmpty {
                            emptyState
                        } else {
                            ForEach(Array(visibleEntries.enumerated()), id: \.element.id) { idx, entry in
                                modelRow(entry)
                                if idx < visibleEntries.count - 1 {
                                    Rectangle()
                                        .fill(LeverTheme.hairline)
                                        .frame(height: 0.5)
                                        .padding(.leading, 16)
                                }
                            }
                        }
                    }
                    .background(LeverTheme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(LeverTheme.hairline, lineWidth: 0.5)
                    )
                    .padding(.horizontal, 14)
                    .padding(.top, 12)

                    if !availableEfforts.isEmpty {
                        effortSection
                            .padding(.horizontal, 14)
                            .padding(.top, 14)
                    }

                    if activeModelOption?.fast == true {
                        speedSection
                            .padding(.horizontal, 14)
                            .padding(.top, 12)
                    }

                    Color.clear.frame(height: 24)
                }
                .background(LeverTheme.canvas)
            }
            .background(LeverTheme.canvas)
            .navigationTitle("模型与推理强度")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .fontWeight(.semibold)
                        .foregroundStyle(LeverTheme.inkPrimary)
                }
            }
            .task {
                if !didInitTab {
                    didInitTab = true
                    if starredMap[effectiveProviderId]?.contains(effectiveModelId) == true && totalStarredCount > 0 {
                        activeTab = .favorites
                    } else if !effectiveProviderId.isEmpty {
                        activeTab = .provider(effectiveProviderId)
                    } else if let first = providers.first {
                        activeTab = .provider(first.id)
                    }
                }
                await store.loadComposerMeta(deviceId: deviceId, agentId: agentId)
                if case .provider(let pid) = activeTab, pid.isEmpty, let first = providers.first {
                    activeTab = .provider(first.id)
                }
            }
        }
    }

    // MARK: - Provider Rail (Favorites + All Enabled Providers with Authentic Icons)

    private var providerRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                railChip(
                    tab: .favorites,
                    title: totalStarredCount > 0 ? "收藏 \(totalStarredCount)" : "收藏",
                    icon: {
                        Image(systemName: "star.fill")
                            .font(.system(size: 12, weight: .semibold))
                    }
                )

                ForEach(providers) { prov in
                    railChip(
                        tab: .provider(prov.id),
                        title: prov.name,
                        icon: {
                            ProviderIconView(
                                providerId: prov.id,
                                providerType: prov.type,
                                pluginId: prov.pluginId,
                                size: 15
                            )
                        }
                    )
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .background(LeverTheme.surface)
    }

    private func railChip<Icon: View>(
        tab: ProviderRailTab,
        title: String,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        let selected = activeTab == tab
        return Button {
            Haptics.light()
            withAnimation(.easeInOut(duration: 0.16)) {
                activeTab = tab
            }
        } label: {
            HStack(spacing: 6) {
                icon()
                Text(title)
                    .font(.system(size: 13, weight: selected ? .semibold : .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(selected ? LeverTheme.surface : LeverTheme.inkSecondary)
            .padding(.horizontal, 11)
            .frame(height: 34)
            .background(selected ? LeverTheme.inkPrimary : LeverTheme.surfaceInset)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(LeverTheme.inkTertiary)
            TextField("搜索模型或 Provider", text: $searchText)
                .font(.system(size: 14))
                .foregroundStyle(LeverTheme.inkPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(LeverTheme.inkTertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 11)
        .frame(height: 36)
        .background(LeverTheme.surfaceInset)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
        .background(LeverTheme.surface)
    }

    // MARK: - Model Row (With Provider Icon in Favorites + Synced Star Toggle)

    private func modelRow(_ entry: ModelRowEntry) -> some View {
        let isSelected = entry.provider.id == effectiveProviderId && entry.model.id == effectiveModelId
        let isDefault = entry.provider.id == defaultProviderId && entry.model.id == defaultModelId
        let inFavoritesTab = activeTab == .favorites

        return HStack(spacing: 10) {
            Button {
                selectModel(entry)
            } label: {
                HStack(spacing: 10) {
                    if inFavoritesTab {
                        ProviderIconView(
                            providerId: entry.provider.id,
                            providerType: entry.provider.type,
                            pluginId: entry.provider.pluginId,
                            size: 18
                        )
                    }

                    VStack(alignment: .leading, spacing: 2.5) {
                        HStack(spacing: 6) {
                            Text(entry.model.displayName)
                                .font(.system(size: 14.5, weight: isSelected ? .semibold : .regular))
                                .foregroundStyle(LeverTheme.inkPrimary)
                                .lineLimit(1)

                            if isDefault {
                                Text(defaultBadgeText)
                                    .font(.system(size: 10.5, weight: .medium))
                                    .foregroundStyle(LeverTheme.inkTertiary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1.5)
                                    .background(LeverTheme.surfaceInset)
                                    .clipShape(Capsule())
                            }
                        }

                        let sub = [
                            inFavoritesTab ? entry.provider.name : nil,
                            entry.model.subtitleText,
                        ]
                        .compactMap { $0 }
                        .filter { !$0.isEmpty }
                        .joined(separator: " · ")

                        if !sub.isEmpty {
                            Text(sub)
                                .font(.system(size: 11.5))
                                .foregroundStyle(LeverTheme.inkTertiary)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: 6)

                    if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(LeverTheme.inkPrimary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Star / Favorite Toggle (bidirectionally synced with Lever Desktop!)
            Button {
                store.toggleStarredModel(
                    deviceId: deviceId,
                    providerId: entry.provider.id,
                    modelId: entry.model.id
                )
            } label: {
                Image(systemName: entry.starred ? "star.fill" : "star")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(entry.starred ? LeverTheme.approvalAmber : LeverTheme.inkTertiary.opacity(0.65))
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(entry.starred ? "取消收藏" : "收藏模型")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Reasoning Effort Section (With Effort Icons)

    private var effortSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                EffortIconView(effort: effectiveEffort, size: 12)
                    .foregroundStyle(LeverTheme.inkSecondary)
                Text("推理强度")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(LeverTheme.inkTertiary)
            }
            .padding(.horizontal, 4)

            HStack(spacing: 7) {
                ForEach(availableEfforts, id: \.self) { effort in
                    let isSelected = effort.lowercased() == effectiveEffort.lowercased()
                    Button {
                        Haptics.light()
                        selectedEffort = effort
                    } label: {
                        HStack(spacing: 5) {
                            EffortIconView(effort: effort, size: 11)
                            Text(formatEffortLabel(effort))
                                .font(.system(size: 12.5, weight: isSelected ? .semibold : .medium))
                                .lineLimit(1)
                        }
                        .foregroundStyle(isSelected ? LeverTheme.surface : LeverTheme.inkSecondary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                        .background(isSelected ? LeverTheme.inkPrimary : LeverTheme.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(isSelected ? Color.clear : LeverTheme.hairline, lineWidth: 0.5)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - Speed Section (Standard / Fast)

    private var speedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("响应速度")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(LeverTheme.inkTertiary)
                .padding(.horizontal, 4)

            HStack(spacing: 8) {
                speedChip(title: "标准", fast: false, icon: nil)
                speedChip(title: "快速", fast: true, icon: "bolt.fill")
            }
        }
    }

    private func speedChip(title: String, fast: Bool, icon: String?) -> some View {
        let isSelected = effectiveFast == fast
        return Button {
            Haptics.light()
            selectedFast = fast
        } label: {
            HStack(spacing: 5) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 11.5, weight: .semibold))
                }
                Text(title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
            }
            .foregroundStyle(isSelected ? LeverTheme.surface : LeverTheme.inkSecondary)
            .frame(maxWidth: .infinity)
            .frame(height: 36)
            .background(isSelected ? LeverTheme.inkPrimary : LeverTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(isSelected ? Color.clear : LeverTheme.hairline, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: activeTab == .favorites ? "star" : "magnifyingglass")
                .font(.system(size: 24, weight: .light))
                .foregroundStyle(LeverTheme.inkTertiary)
            Text(activeTab == .favorites && searchText.isEmpty ? "暂无收藏模型，点击任意模型右侧星标即可收藏并同步桌面" : "未找到匹配的模型")
                .font(.system(size: 13))
                .foregroundStyle(LeverTheme.inkTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
        .padding(.horizontal, 20)
    }

    private func selectModel(_ entry: ModelRowEntry) {
        Haptics.light()
        selectedProviderId = entry.provider.id
        selectedModelId = entry.model.id

        // Harmonize effort for the newly chosen model
        let efforts = entry.model.efforts ?? []
        if efforts.isEmpty {
            selectedEffort = nil
        } else if let cur = selectedEffort, efforts.contains(where: { $0.lowercased() == cur.lowercased() }) {
            // keep current effort
        } else if let def = entry.model.defaultEffort, !def.isEmpty {
            selectedEffort = def
        } else {
            selectedEffort = efforts.last
        }

        if entry.model.fast != true {
            selectedFast = false
        }

        // Refresh skills for the newly selected provider in background
        Task {
            await store.loadComposerMeta(deviceId: deviceId, agentId: agentId, providerId: entry.provider.id)
        }
        if efforts.isEmpty {
            dismiss()
        }
    }
}
