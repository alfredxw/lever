import Foundation

extension LeverStore {
    // MARK: - Sync Engine (Change-Gated + Backend Progressive Pagination)

    func refreshAll(silent: Bool = false) async {
        guard isPaired, !inFlightRefresh else { return }
        let revision = workspaceRevision
        inFlightRefresh = true
        if !silent { isSyncing = true }
        defer {
            if revision == workspaceRevision { inFlightRefresh = false; isSyncing = false }
        }

        do {
            let me: AccountInfo = try await bridge.request("GET", path: "/api/me")
            guard revision == workspaceRevision else { return }
            if account != me {
                account = me
                db.saveKV(me, forKey: "account")
            }

            guard let sPath = spacePath else { return }

            var projectionsDirty = false

            let fetchedDevices: [DeviceInfo] = try await bridge.request("GET", path: "\(sPath)/devices")
            guard revision == workspaceRevision else { return }
            if devices != fetchedDevices {
                devices = fetchedDevices
                db.saveKV(fetchedDevices, forKey: "devices")
                projectionsDirty = true
            }

            if !isDirectMode {
                if let cursors: [String: [String: Int64]] = try? await bridge.request("GET", path: "\(sPath)/read"),
                   hubReadCursors != cursors {
                    hubReadCursors = cursors
                    db.saveKV(cursors, forKey: "hub_read_cursors")
                    projectionsDirty = true
                }
                if let cleared: [String: [String: Int64]] = try? await bridge.request("GET", path: "\(sPath)/cleared"),
                   hubClearedCursors != cleared {
                    hubClearedCursors = cleared
                    db.saveKV(cleared, forKey: "hub_cleared_cursors")
                    projectionsDirty = true
                }
                if let fetchedTasks: [SharedTask] = try? await bridge.request("GET", path: "\(sPath)/tasks"),
                   tasks != fetchedTasks {
                    tasks = fetchedTasks
                }
            }

            for host in hostDevices where !host.revoked {
                guard revision == workspaceRevision else { return }
                let changed = await syncDeviceIndex(deviceId: host.id, spacePath: sPath)
                if changed { projectionsDirty = true }
            }

            guard revision == workspaceRevision else { return }
            if projectionsDirty {
                invalidateAllProjections()
            }

            if let key = activeChatKey {
                if let tid = activeTopicId,
                   let parsed = parseChatKey(key) {
                    await refreshTopic(
                        deviceId: parsed.deviceId,
                        chatId: parsed.chatId,
                        isPrivate: parsed.isPrivate,
                        topicId: tid,
                        spacePath: sPath,
                        showLoading: false
                    )
                } else {
                    await refreshChatByKey(key, spacePath: sPath, showLoading: false)
                }
            } else if projectionsDirty || prefetchedTopicKeys.isEmpty {
                scheduleHotTopicPrefetch(spacePath: sPath)
            }

            openPendingActivity()
            updateLiveActivity()
            if !silent || projectionsDirty || lastSyncAt == nil {
                lastSyncAt = Date()
            }
            if errorMessage != nil {
                errorMessage = nil
            }
        } catch {
            if !silent && revision == workspaceRevision && !(error is CancellationError) {
                errorMessage = error.localizedDescription
            }
        }
    }

    func hasNativeOwner(_ deviceId: String) -> Bool {
        devices.first { $0.id == deviceId }?.node?.supportsChat == true
    }

    private func ownerHistory(device: String, space: String, chat: String, topic: String? = nil, before: Int64? = nil, after: Int64 = 0, legacy: String) async throws -> [ArchiveRecord] {
        guard hasNativeOwner(device) else { return try await bridge.request("GET", path: legacy) }
        let resource = topic.map { "sessions/\($0)/runs" } ?? "chats/\(chat)"
        var path = "\(space)/nodes/\(device)/\(resource)?limit=\(pageSize)&before=\(before ?? 0)&steps=lazy"
        if after > 0 {
            path += "&after=\(after)"
        }
        do {
            let page: PeerHistory = try await bridge.request("GET", path: path)
            return page.records
        } catch {
            if case LeverCoreError.http(let code, _) = error, [401,403,404].contains(code) {
                forgetHistory(device: device, chat: chat)
            }
            throw error
        }
    }

    func submit(_ intent: CommandIntent, space: String) async throws -> InboxItem {
        guard hasNativeOwner(intent.deviceId) else { return try await bridge.request("POST", path: "\(space)/commands", body: intent) }
        var path: String
        switch intent.kind {
        case "send": path = "messages"
        case "answer": path = "requests/\(intent.requestId ?? "")/answer"
        case "allow_run": path = "runs/\(intent.runId ?? "")/approvals"
        case "stop": path = "runs/\(intent.runId ?? "")/stop"
        case "resume_queue": path = "sessions/\(intent.sessionId ?? "")/queue/resume"
        default: throw LeverCoreError.message("此设备不支持该操作")
        }
        let base = "\(space)/nodes/\(intent.deviceId)"
        do {
            let receipt: CommandReceipt = try await bridge.request("POST", path: "\(base)/\(path)", body: PeerCommandBody(intent: intent))
            return InboxItem(intent: intent, receipt: receipt)
        } catch {
            if let receipt: CommandReceipt = try? await bridge.request("GET", path: "\(base)/commands/\(intent.id)") {
                return InboxItem(intent: intent, receipt: receipt)
            }
            throw error
        }
    }

    private func forgetHistory(device: String, chat: String) {
        for isPrivate in [false, true] {
            let key = chatKey(deviceId: device, chatId: chat, isPrivate: isPrivate)
            chatRecordsByKey.removeValue(forKey: key)
            chatCursorsByKey.removeValue(forKey: key)
            loadedTailKeys.remove(key)
            db.deleteScope("chat:\(key)")
            db.deleteKV("chat_cursor:\(key)")
            invalidateChatCache(forKey: key)
        }
    }

    private func syncDeviceIndex(deviceId: String, spacePath: String) async -> Bool {
        if hasNativeOwner(deviceId) {
            do {
                let progress = lockScreenProgress ? "?progress=1" : ""
                let index: PeerIndex = try await bridge.request("GET", path: "\(spacePath)/nodes/\(deviceId)/overview\(progress)")
                liveRunsByDevice[deviceId] = index.activeRuns
                if var active = index.activeRuns, let tracked = activities.current, tracked.node == deviceId,
                   !active.contains(where: { $0.id == tracked.run }), index.chats?.contains(where: { $0.id == tracked.chat }) == true,
                   let detail: PeerHistory.RunEnvelope = try? await bridge.request("GET", path: "\(spacePath)/nodes/\(deviceId)/runs/\(urlEncode(tracked.run))") {
                    active.append(detail.run.record)
                    liveRunsByDevice[deviceId] = active
                }
                let rows = sortRecords(index.records)
                let changed = indexByDevice[deviceId] != rows || !(privateIndexByDevice[deviceId] ?? []).isEmpty
                if changed {
                    let visible = Set(rows.filter { $0.kind == "chat" }.map(\.id))
                    for old in indexByDevice[deviceId] ?? [] where old.kind == "chat" && !visible.contains(old.id) {
                        forgetHistory(device: deviceId, chat: old.id)
                    }
                    indexByDevice[deviceId] = rows
                    privateIndexByDevice[deviceId] = []
                    db.replaceScopeRecords(scope: "index:\(deviceId)", records: rows)
                    db.replaceScopeRecords(scope: "priv:\(deviceId)", records: [])
                    db.deleteKV("index_cursor:\(deviceId)")
                }
                return changed
            } catch {
                if case LeverCoreError.http(let code, _) = error, [401,403,404].contains(code) {
                    liveRunsByDevice[deviceId] = nil
                    for old in indexByDevice[deviceId] ?? [] where old.kind == "chat" { forgetHistory(device: deviceId, chat: old.id) }
                    let changed = !(indexByDevice[deviceId] ?? []).isEmpty || !(privateIndexByDevice[deviceId] ?? []).isEmpty
                    indexByDevice[deviceId] = []; privateIndexByDevice[deviceId] = []
                    db.deleteScope("index:\(deviceId)"); db.deleteScope("priv:\(deviceId)")
                    db.deleteKV("index_cursor:\(deviceId)")
                    return changed
                }
                return false
            }
        }
        var didChange = false
        let prev = indexCursors[deviceId]
        var path = "\(spacePath)/archive/\(deviceId)?sync=1"
        if let prev, !prev.epoch.isEmpty {
            path += "&epoch=\(urlEncode(prev.epoch))&version=\(prev.version)&stream=\(urlEncode(prev.stream))"
        }
        if let page: ArchivePage = try? await bridge.request("GET", path: path) {
            if page.full || !page.changes.isEmpty {
                let merged = applyArchivePage(existing: indexByDevice[deviceId] ?? [], page: page)
                if indexByDevice[deviceId] != merged {
                    indexByDevice[deviceId] = merged
                    if page.full {
                        db.replaceScopeRecords(scope: "index:\(deviceId)", records: merged)
                    } else {
                        let upserts = page.changes.filter { !$0.deleted }.map(\.record)
                        let deletes = page.changes.filter(\.deleted).map { (kind: $0.record.kind, id: $0.record.id) }
                        if !upserts.isEmpty {
                            db.upsertRecords(scope: "index:\(deviceId)", records: upserts)
                        }
                        if !deletes.isEmpty {
                            db.deleteRecords(scope: "index:\(deviceId)", keys: deletes)
                        }
                    }
                    didChange = true
                }
            }
            if indexCursors[deviceId] != page.cursor {
                indexCursors[deviceId] = page.cursor
                db.saveKV(page.cursor, forKey: "index_cursor:\(deviceId)")
            }
        }

        if let priv: [ArchiveRecord] = try? await bridge.request("GET", path: "\(spacePath)/private-archive/\(deviceId)") {
            let sortedPriv = sortRecords(priv)
            if privateIndexByDevice[deviceId] != sortedPriv {
                privateIndexByDevice[deviceId] = sortedPriv
                db.replaceScopeRecords(scope: "priv:\(deviceId)", records: sortedPriv)
                didChange = true
            }
        }
        return didChange
    }

    // MARK: - Paginated Chat & Topic Loading

    func chatKey(deviceId: String, chatId: String, isPrivate: Bool) -> String {
        "\(deviceId)|\(chatId)|\(isPrivate ? "1" : "0")"
    }

    func topicPageKey(chatKey: String, topicId: String) -> String {
        "\(chatKey)|\(topicId)"
    }

    func parseChatKey(_ key: String) -> (deviceId: String, chatId: String, isPrivate: Bool)? {
        let parts = key.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count == 3 else { return nil }
        return (parts[0], parts[1], parts[2] == "1")
    }

    func isLoadingChat(deviceId: String, chatId: String, isPrivate: Bool) -> Bool {
        loadingChatKeys.contains(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    func isLoadingTopic(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> Bool {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return loadingTopicKeys.contains(topicPageKey(chatKey: key, topicId: topicId))
    }

    func isLoadingOlderChat(deviceId: String, chatId: String, isPrivate: Bool) -> Bool {
        loadingOlderKeys.contains(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }

    func isLoadingOlderTopic(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> Bool {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return loadingOlderKeys.contains(topicPageKey(chatKey: key, topicId: topicId))
    }

    func chatLoadError(deviceId: String, chatId: String, isPrivate: Bool) -> String? {
        chatLoadErrorByKey[chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)]
    }

    func topicLoadError(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> String? {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return chatLoadErrorByKey[topicPageKey(chatKey: key, topicId: topicId)]
    }

    func hasMoreMainRuns(deviceId: String, chatId: String, isPrivate: Bool) -> Bool {
        hasMoreMainByKey[chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)] ?? false
    }

    func hasMoreTopicRuns(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) -> Bool {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        return hasMoreTopicByKey[topicPageKey(chatKey: key, topicId: topicId)] ?? false
    }

    func loadChat(deviceId: String, chatId: String, isPrivate: Bool) async {
        let revision = workspaceRevision
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        activeChatKey = key
        chatLoadErrorByKey.removeValue(forKey: key)

        // Read the indexed tail before requesting the next Owner page.
        if chatRecordsByKey[key] == nil {
            let scope = "chat:\(key)"
            let cachedRecords = await db.loadChatTailRecordsAsync(scope: scope, topicId: nil, runLimit: pageSize * 2)
            guard revision == workspaceRevision else { return }
            if chatRecordsByKey[key] == nil && !cachedRecords.isEmpty {
                chatRecordsByKey[key] = sortRecords(cachedRecords)
                invalidateChatCache(forKey: key)
                prewarmMarkdown(from: cachedRecords)
            }
        }

        guard let sPath = spacePath else { return }
        await refreshChatByKey(key, spacePath: sPath, showLoading: true)
    }

    private func deltaAfterSequence(for runs: [ArchiveRecord]) -> Int64 {
        guard !runs.isEmpty else { return 0 }
        let activeSeqs = runs
            .filter { isActiveRunStatus($0.status) || $0.status == "queued" }
            .compactMap(\.sequence)
        if let oldestActive = activeSeqs.min() {
            return max(0, oldestActive - 1)
        }
        return runs.compactMap(\.sequence).max() ?? 0
    }

    private func prewarmMarkdown(from records: [ArchiveRecord]) {
        var texts: [String] = []
        texts.reserveCapacity(records.count * 2)
        for r in records where r.kind == "run" && !isActiveRunStatus(r.status) {
            if let t = r.text, !t.isEmpty { texts.append(t) }
            for item in r.items ?? [] where item.kind == "text" {
                if let t = item.text, !t.isEmpty { texts.append(t) }
            }
        }
        CachedMarkdownParser.shared.prewarm(texts)
    }

    func refreshChatByKey(_ key: String, spacePath overridePath: String? = nil, showLoading: Bool = false) async {
        guard let sPath = overridePath ?? spacePath,
              let parsed = parseChatKey(key) else { return }

        if showLoading {
            loadingChatKeys.insert(key)
        }
        defer {
            if showLoading {
                loadingChatKeys.remove(key)
            }
        }

        var afterSeq: Int64 = 0
        if loadedTailKeys.contains(key), let existing = chatRecordsByKey[key] {
            let mainSessId = existing.first(where: { $0.kind == "session" && $0.type == "main" })?.id
            let mainRuns = existing.filter { $0.kind == "run" && $0.sessionId == mainSessId && $0.superseded != true }
            afterSeq = deltaAfterSequence(for: mainRuns)
        }

        let endpoint = parsed.isPrivate ? "private-archive" : "archive"
        var path = "\(sPath)/\(endpoint)/\(parsed.deviceId)?chat=\(urlEncode(parsed.chatId))&limit=\(pageSize)&steps=lazy"
        if afterSeq > 0 {
            path += "&after=\(afterSeq)"
        }

        do {
            let incoming = try await ownerHistory(device: parsed.deviceId, space: sPath, chat: parsed.chatId, after: afterSeq, legacy: path)
            prewarmMarkdown(from: incoming)
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                db.upsertRecords(scope: "chat:\(key)", records: incoming)
            }
            if chatLoadErrorByKey[key] != nil {
                chatLoadErrorByKey.removeValue(forKey: key)
            }
            let nextStream = parsed.isPrivate ? "lan" : (indexCursors[parsed.deviceId]?.stream ?? "hub")
            if chatRouteStreamByKey[key] != nextStream {
                chatRouteStreamByKey[key] = nextStream
            }
            let wasInitialTail = !loadedTailKeys.contains(key)
            loadedTailKeys.insert(key)

            if wasInitialTail || hasMoreMainByKey[key] == nil {
                let mainSessId = incoming.first(where: { $0.kind == "session" && $0.type == "main" })?.id
                    ?? merged.first(where: { $0.kind == "session" && $0.type == "main" })?.id
                if let mainSessId {
                    let mainRuns = incoming.filter { $0.kind == "run" && $0.sessionId == mainSessId && $0.superseded != true }
                    let minSeq = mainRuns.compactMap(\.sequence).min() ?? 0
                    hasMoreMainByKey[key] = mainRuns.count >= pageSize && minSeq > 1
                } else {
                    hasMoreMainByKey[key] = false
                }
            }
        } catch {
            if showLoading {
                chatLoadErrorByKey[key] = error.localizedDescription
            }
        }
    }

    func loadOlderChatRuns(deviceId: String, chatId: String, isPrivate: Bool) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        guard !loadingOlderKeys.contains(key) else { return }

        let snapshot = timelineSnapshot(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        guard let oldestSeq = snapshot.oldestMainSequence, oldestSeq > 1 else {
            hasMoreMainByKey[key] = false
            return
        }

        loadingOlderKeys.insert(key)
        defer { loadingOlderKeys.remove(key) }

        let endpoint = isPrivate ? "private-archive" : "archive"
        let path = "\(sPath)/\(endpoint)/\(deviceId)?chat=\(urlEncode(chatId))&before=\(oldestSeq)&limit=\(pageSize)&steps=lazy"
        do {
            let incoming = try await ownerHistory(device: deviceId, space: sPath, chat: chatId, before: oldestSeq, legacy: path)
            prewarmMarkdown(from: incoming)
            let mainId = snapshot.mainSession?.id
            let olderMainRuns = incoming.filter {
                $0.kind == "run" && $0.sessionId == mainId && $0.superseded != true && ($0.sequence ?? Int64.max) < oldestSeq
            }
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                db.upsertRecords(scope: "chat:\(key)", records: incoming)
            }
            let minReturned = olderMainRuns.compactMap(\.sequence).min() ?? 0
            if olderMainRuns.count < pageSize || minReturned <= 1 {
                hasMoreMainByKey[key] = false
            }
        } catch {
            chatLoadErrorByKey[key] = error.localizedDescription
        }
    }

    func loadTopic(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) async {
        let revision = workspaceRevision
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let tKey = topicPageKey(chatKey: key, topicId: topicId)
        activeChatKey = key
        activeTopicId = topicId
        chatLoadErrorByKey.removeValue(forKey: tKey)

        // Hydrate focused topic tail from SQLite WAL even if main chat already hydrated a preview slice
        if !loadedTailKeys.contains(tKey) {
            let scope = "chat:\(key)"
            let cachedRecords = await db.loadChatTailRecordsAsync(scope: scope, topicId: topicId, runLimit: pageSize * 2)
            guard revision == workspaceRevision else { return }
            if !cachedRecords.isEmpty {
                let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: cachedRecords)
                if chatRecordsByKey[key] != merged {
                    chatRecordsByKey[key] = merged
                    invalidateChatCache(forKey: key)
                    prewarmMarkdown(from: cachedRecords)
                }
            }
        }

        guard let sPath = spacePath else { return }
        await refreshTopic(
            deviceId: deviceId,
            chatId: chatId,
            isPrivate: isPrivate,
            topicId: topicId,
            spacePath: sPath,
            showLoading: true
        )
    }

    func refreshTopic(
        deviceId: String,
        chatId: String,
        isPrivate: Bool,
        topicId: String,
        spacePath overridePath: String? = nil,
        showLoading: Bool = false
    ) async {
        guard let sPath = overridePath ?? spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let tKey = topicPageKey(chatKey: key, topicId: topicId)

        if showLoading {
            loadingTopicKeys.insert(tKey)
        }
        defer {
            if showLoading {
                loadingTopicKeys.remove(tKey)
            }
        }

        var afterSeq: Int64 = 0
        if loadedTailKeys.contains(tKey), let existing = chatRecordsByKey[key] {
            let topicRuns = existing.filter { $0.kind == "run" && $0.sessionId == topicId && $0.superseded != true }
            afterSeq = deltaAfterSequence(for: topicRuns)
        }

        let endpoint = isPrivate ? "private-archive" : "archive"
        var path = "\(sPath)/\(endpoint)/\(deviceId)?chat=\(urlEncode(chatId))&session=\(urlEncode(topicId))&limit=\(pageSize)&steps=lazy"
        if afterSeq > 0 {
            path += "&after=\(afterSeq)"
        }

        do {
            let incoming = try await ownerHistory(device: deviceId, space: sPath, chat: chatId, topic: topicId, after: afterSeq, legacy: path)
            prewarmMarkdown(from: incoming)
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                db.upsertRecords(scope: "chat:\(key)", records: incoming)
            }
            if chatLoadErrorByKey[tKey] != nil {
                chatLoadErrorByKey.removeValue(forKey: tKey)
            }
            let wasInitialTail = !loadedTailKeys.contains(tKey)
            loadedTailKeys.insert(tKey)

            if wasInitialTail || hasMoreTopicByKey[tKey] == nil {
                let topicRuns = incoming.filter { $0.kind == "run" && $0.sessionId == topicId && $0.superseded != true }
                let minSeq = topicRuns.compactMap(\.sequence).min() ?? 0
                hasMoreTopicByKey[tKey] = topicRuns.count >= pageSize && minSeq > 1
            }
        } catch {
            if showLoading {
                chatLoadErrorByKey[tKey] = error.localizedDescription
            }
        }
    }

    // MARK: - Two-Stage Lazy Tool Steps Hydration

    func runStepsKey(deviceId: String, runId: String) -> String {
        "\(deviceId):\(runId)"
    }

    func runSteps(deviceId: String, runId: String) -> [RunItem]? {
        runStepsByKey[runStepsKey(deviceId: deviceId, runId: runId)]
    }

    func isLoadingRunSteps(deviceId: String, runId: String) -> Bool {
        loadingRunStepsKeys.contains(runStepsKey(deviceId: deviceId, runId: runId))
    }

    /// Lazily fetches intermediate tool/reasoning steps for a single run when the user taps
    /// `> N 个执行步骤`, caching the result in memory and SQLite WAL for 0ms re-expansion.
    func loadRunSteps(deviceId: String, runId: String, expectedCount: Int = 0) async {
        let revision = workspaceRevision
        let key = runStepsKey(deviceId: deviceId, runId: runId)
        let target = max(1, expectedCount)
        if let existing = runStepsByKey[key], existing.count >= target {
            return
        }
        if let cached = await db.steps(device: deviceId, run: runId), !cached.isEmpty {
            guard revision == workspaceRevision else { return }
            runStepsByKey[key] = cached
            if cached.count >= target {
                return
            }
        }
        guard !loadingRunStepsKeys.contains(key), let sPath = spacePath else { return }
        loadingRunStepsKeys.insert(key)
        defer { loadingRunStepsKeys.remove(key) }

        var fetched: [RunItem]?
        if hasNativeOwner(deviceId) {
            if let envelope: PeerHistory.RunEnvelope = try? await bridge.request(
                "GET",
                path: "\(sPath)/nodes/\(deviceId)/runs/\(urlEncode(runId))"
            ) {
                fetched = (envelope.run.items ?? []).filter { $0.kind != "text" && $0.kind != "user" }
            }
        }
        if fetched == nil {
            fetched = try? await bridge.request(
                "GET",
                path: "\(sPath)/runs/\(deviceId)/\(urlEncode(runId))/steps"
            )
        }
        guard revision == workspaceRevision else { return }
        if let steps = fetched {
            runStepsByKey[key] = steps
            if !steps.isEmpty {
                db.saveSteps(steps, device: deviceId, run: runId)
            }
        }
    }

    /// Quietly prefetches the top 3 unread/most-recent topics' latest tail page while on Home Feed
    /// so tapping into hot topics opens instantaneously (0ms wait) with pre-parsed Markdown.
    private func scheduleHotTopicPrefetch(spacePath: String) {
        var candidates: [(deviceId: String, chatId: String, isPrivate: Bool, topicId: String, tKey: String)] = []
        for row in cachedFeedRows {
            for cue in row.activeTopics {
                let cKey = chatKey(deviceId: row.device.id, chatId: cue.chatId, isPrivate: row.isPrivate)
                let tKey = topicPageKey(chatKey: cKey, topicId: cue.id)
                guard !prefetchedTopicKeys.contains(tKey), !loadedTailKeys.contains(tKey) else { continue }
                candidates.append((row.device.id, cue.chatId, row.isPrivate, cue.id, tKey))
                if candidates.count >= 3 { break }
            }
            if candidates.count >= 3 { break }
        }
        guard !candidates.isEmpty else { return }
        for item in candidates {
            prefetchedTopicKeys.insert(item.tKey)
        }
        Task(priority: .utility) { [weak self] in
            for item in candidates {
                guard let self, self.isPaired, self.activeChatKey == nil else { break }
                await self.refreshTopic(
                    deviceId: item.deviceId,
                    chatId: item.chatId,
                    isPrivate: item.isPrivate,
                    topicId: item.topicId,
                    spacePath: spacePath,
                    showLoading: false
                )
            }
        }
    }

    func loadOlderTopicRuns(deviceId: String, chatId: String, isPrivate: Bool, topicId: String) async {
        guard let sPath = spacePath else { return }
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let tKey = topicPageKey(chatKey: key, topicId: topicId)
        guard !loadingOlderKeys.contains(tKey) else { return }

        let snapshot = timelineSnapshot(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        guard let topic = snapshot.topics.first(where: { $0.id == topicId }),
              let oldestSeq = topic.oldestRunSequence,
              oldestSeq > 1 else {
            hasMoreTopicByKey[tKey] = false
            return
        }

        loadingOlderKeys.insert(tKey)
        defer { loadingOlderKeys.remove(tKey) }

        let endpoint = isPrivate ? "private-archive" : "archive"
        let path = "\(sPath)/\(endpoint)/\(deviceId)?chat=\(urlEncode(chatId))&session=\(urlEncode(topicId))&before=\(oldestSeq)&limit=\(pageSize)&steps=lazy"
        do {
            let incoming = try await ownerHistory(device: deviceId, space: sPath, chat: chatId, topic: topicId, before: oldestSeq, legacy: path)
            prewarmMarkdown(from: incoming)
            let olderTopicRuns = incoming.filter {
                $0.kind == "run" && $0.sessionId == topicId && $0.superseded != true && ($0.sequence ?? Int64.max) < oldestSeq
            }
            let merged = mergeRecords(existing: chatRecordsByKey[key] ?? [], incoming: incoming)
            if chatRecordsByKey[key] != merged {
                chatRecordsByKey[key] = merged
                invalidateChatCache(forKey: key)
                db.upsertRecords(scope: "chat:\(key)", records: incoming)
            }
            let minReturned = olderTopicRuns.compactMap(\.sequence).min() ?? 0
            if olderTopicRuns.count < pageSize || minReturned <= 1 {
                hasMoreTopicByKey[tKey] = false
            }
        } catch {
            chatLoadErrorByKey[tKey] = error.localizedDescription
        }
    }

    private func sortRecords(_ records: [ArchiveRecord]) -> [ArchiveRecord] {
        records.sorted { lhs, rhs in
            if lhs.kind != rhs.kind { return lhs.kind < rhs.kind }
            return lhs.id < rhs.id
        }
    }

    private func mergeRecords(existing: [ArchiveRecord], incoming: [ArchiveRecord]) -> [ArchiveRecord] {
        var map: [String: ArchiveRecord] = Dictionary(minimumCapacity: existing.count + incoming.count)
        for r in existing {
            map["\(r.kind):\(r.id)"] = r
        }
        for r in incoming {
            map["\(r.kind):\(r.id)"] = r
        }
        return sortRecords(Array(map.values))
    }

    private func applyArchivePage(existing: [ArchiveRecord], page: ArchivePage) -> [ArchiveRecord] {
        var map: [String: ArchiveRecord] = [:]
        if !page.full {
            for r in existing {
                map["\(r.kind):\(r.id)"] = r
            }
        }
        for change in page.changes {
            let k = "\(change.record.kind):\(change.record.id)"
            if change.deleted {
                map.removeValue(forKey: k)
            } else {
                map[k] = change.record
            }
        }
        return sortRecords(Array(map.values))
    }

    func restoreCachedWorkspace() async {
        localReadCursors = await db.loadKVAsync("read_cursors", as: [String: Int64].self) ?? [:]
        localClearedCursors = await db.loadKVAsync("cleared_cursors", as: [String: Int64].self) ?? [:]
        starredModelsByDevice = await db.loadKVAsync("starred_models", as: [String: [String: [String]]].self) ?? [:]
        providersByDevice = await db.loadKVAsync("providers_by_device", as: [String: [ProviderCatalog]].self) ?? [:]
        account = await db.loadKVAsync("account", as: AccountInfo.self)
        devices = await db.loadKVAsync("devices", as: [DeviceInfo].self) ?? []
        hubReadCursors = await db.loadKVAsync("hub_read_cursors", as: [String: [String: Int64]].self) ?? [:]
        hubClearedCursors = await db.loadKVAsync("hub_cleared_cursors", as: [String: [String: Int64]].self) ?? [:]
        for dev in hostDevices {
            let idxRecords = await db.loadAllRecordsAsync(scope: "index:\(dev.id)")
            let idxCursor = await db.loadKVAsync("index_cursor:\(dev.id)", as: ArchiveCursor.self)
            if !idxRecords.isEmpty {
                indexByDevice[dev.id] = idxRecords
            }
            if let c = idxCursor {
                indexCursors[dev.id] = c
            }

            let privRecords = await db.loadAllRecordsAsync(scope: "priv:\(dev.id)")
            if !privRecords.isEmpty {
                privateIndexByDevice[dev.id] = privRecords
            }
        }
        invalidateAllProjections()
    }

    func startEventListener() {
        guard eventTask == nil else { return }
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await ev in self.bridge.events() {
                if Task.isCancelled { break }
                switch ev.kind {
                case "refresh":
                    self.scheduleCoalescedRefresh()
                case "unpaired":
                    await self.reloadAfterUnpair()
                default:
                    break
                }
            }
        }
    }

    /// Coalesces rapid SSE refresh signals (e.g. token bursts during live streaming) into smooth ~4Hz updates.
    private func scheduleCoalescedRefresh() {
        refreshDebounceTask?.cancel()
        refreshDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 220_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.refreshAll(silent: true)
        }
    }

    func startPollingLoop() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.isPaired else { break }
                let intervalNs: UInt64
                if self.cachedTotalRunning > 0 || self.cachedTotalPending > 0 {
                    intervalNs = 2_000_000_000
                } else if self.activeChatKey != nil {
                    intervalNs = 5_000_000_000
                } else {
                    intervalNs = self.isDirectMode ? 8_000_000_000 : 12_000_000_000
                }
                try? await Task.sleep(nanoseconds: intervalNs)
                if Task.isCancelled { break }
                await self.refreshAll(silent: true)
            }
        }
    }
}
