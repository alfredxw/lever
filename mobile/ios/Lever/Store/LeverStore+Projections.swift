import Foundation

extension LeverStore {
    // MARK: - Projection Cache Management

    func invalidateAllProjections() {
        mergedIndexCache.removeAll(keepingCapacity: true)
        agentRecordCache.removeAll(keepingCapacity: true)
        timelineSnapshotCache.removeAll(keepingCapacity: true)
        drawerDataCache.removeAll(keepingCapacity: true)
        rebuildFeedProjection()
        dataVersion &+= 1
    }

    func invalidateChatCache(forKey key: String) {
        timelineSnapshotCache.removeValue(forKey: key)
        chatVersionByKey[key, default: 0] &+= 1
    }

    // MARK: - Memoized Feed, Search, Drawer & Timeline Projections

    func mergedIndex(for deviceId: String) -> [ArchiveRecord] {
        let _ = dataVersion
        if let hit = mergedIndexCache[deviceId] {
            return hit
        }
        var combined: [String: ArchiveRecord] = [:]
        for r in privateIndexByDevice[deviceId] ?? [] {
            combined["\(r.kind):\(r.id)"] = r
        }
        for r in indexByDevice[deviceId] ?? [] {
            combined["\(r.kind):\(r.id)"] = r
        }
        let values = Array(combined.values)
        mergedIndexCache[deviceId] = values
        return values
    }

    private func rebuildFeedProjection() {
        var rows: [AgentFeedRow] = []

        for device in hostDevices where !device.revoked {
            let records = mergedIndex(for: device.id)
            var agentsMap: [String: ArchiveRecord] = [:]
            var chatsByAgent: [String: [ArchiveRecord]] = [:]
            var sessionsByChat: [String: [ArchiveRecord]] = [:]

            for r in records {
                switch r.kind {
                case "agent":
                    agentsMap[r.id] = r
                    agentRecordCache["\(device.id):\(r.id)"] = r
                case "chat":
                    let aid = (r.agentId?.isEmpty == false) ? r.agentId! : "__chat:\(r.id)"
                    chatsByAgent[aid, default: []].append(r)
                case "session":
                    if let cid = r.chatId {
                        sessionsByChat[cid, default: []].append(r)
                    }
                default:
                    break
                }
            }

            let allAgentIds = Set(agentsMap.keys).union(chatsByAgent.keys)
            for aid in allAgentIds {
                let agent = agentsMap[aid]
                let chats = (chatsByAgent[aid] ?? []).sorted { lhs, rhs in
                    let lTime = max(LeverDate.timestamp(lhs.updatedAt), LeverDate.timestamp(lhs.createdAt))
                    let rTime = max(LeverDate.timestamp(rhs.updatedAt), LeverDate.timestamp(rhs.createdAt))
                    return lTime > rTime
                }

                var unreadSessions = 0
                var pendingApprovals = 0
                var isRunning = false
                var unreadMarks: [ReadMark] = []
                var bestSessionTime: TimeInterval = 0
                var bestSessionPreview: String = ""
                var bestTimeRaw: String?
                var topicCandidates: [(priority: Int, time: TimeInterval, cue: ActiveTopicCue)] = []

                for chat in chats {
                    let chatSessions = sessionsByChat[chat.id] ?? []
                    for sess in chatSessions {
                        let unread = isSessionUnread(deviceId: device.id, session: sess)
                        if unread {
                            unreadSessions += 1
                            if let uSeq = sess.unreadSequence, uSeq > 0 {
                                unreadMarks.append(ReadMark(sessionId: sess.id, sequence: uSeq))
                            }
                        }
                        let pending = sess.pendingCount ?? 0
                        pendingApprovals += pending
                        let status = sess.activeStatus ?? ""
                        if status == "running" || status == "starting" || status == "cancelling" {
                            isRunning = true
                        }

                        let sessTimeRaw = (sess.messageAt?.isEmpty == false) ? sess.messageAt : sess.createdAt
                        let sessTime = LeverDate.timestamp(sessTimeRaw)
                        if sessTime >= bestSessionTime {
                            bestSessionTime = sessTime
                            bestTimeRaw = sessTimeRaw
                            if let p = sess.preview, !p.isEmpty {
                                bestSessionPreview = p
                            }
                        }

                        if sess.type == "topic" && !isSessionCleared(deviceId: device.id, session: sess) {
                            let priority: Int
                            let cueStatus: String
                            if pending > 0 || status == "waiting_user" {
                                priority = 4
                                cueStatus = "approval"
                            } else if status == "running" || status == "starting" {
                                priority = 3
                                cueStatus = "running"
                            } else if unread {
                                priority = 2
                                cueStatus = "unread"
                            } else {
                                priority = 1
                                cueStatus = "idle"
                            }
                            let cueCanClear = pending == 0 && !isActiveRunStatus(status)
                            let cue = ActiveTopicCue(
                                id: sess.id,
                                chatId: chat.id,
                                isPrivate: chat.isPrivate,
                                title: (sess.title?.isEmpty == false) ? sess.title! : "独立话题",
                                status: cueStatus,
                                pendingCount: pending,
                                isUnread: unread,
                                unreadSequence: sess.unreadSequence ?? 0,
                                canClear: cueCanClear,
                                replyCount: sess.replyCount ?? 0,
                                preview: sess.preview ?? "",
                                updatedText: LeverDate.compact(sessTimeRaw)
                            )
                            topicCandidates.append((priority, sessTime, cue))
                        }
                    }
                }

                // Prefer the most recent chat that actually has sessions over empty "New chat" stubs
                let latestChat = chats.first { !(sessionsByChat[$0.id] ?? []).isEmpty } ?? chats.first
                let chatSortTime = latestChat.map { max(LeverDate.timestamp($0.updatedAt), LeverDate.timestamp($0.createdAt)) } ?? 0
                let sortTime = max(bestSessionTime, chatSortTime)
                let displayTimeRaw = bestTimeRaw ?? latestChat?.updatedAt ?? latestChat?.createdAt

                let name = (agent?.title?.isEmpty == false) ? agent!.title! : (latestChat?.title ?? "本地对话")
                let preview: String
                if !bestSessionPreview.isEmpty {
                    preview = bestSessionPreview
                } else if let title = latestChat?.title, !title.isEmpty {
                    preview = title
                } else {
                    preview = [agent?.model ?? agent?.provider, "点击开始新对话"]
                        .compactMap { $0 }
                        .filter { !$0.isEmpty }
                        .joined(separator: " · ")
                }

                let sortedTopics = topicCandidates.sorted { lhs, rhs in
                    if lhs.priority != rhs.priority { return lhs.priority > rhs.priority }
                    return lhs.time > rhs.time
                }.prefix(4).map(\.cue)

                rows.append(AgentFeedRow(
                    id: "\(device.id):\(aid)",
                    device: device,
                    agentId: aid,
                    name: name,
                    avatar: agent?.avatar,
                    avatarSpec: agent?.avatarSpec,
                    model: agent?.model,
                    provider: agent?.provider,
                    models: agent?.models ?? [],
                    latestChat: latestChat,
                    chatCount: chats.count,
                    unreadSessionCount: unreadSessions,
                    pendingApprovalCount: pendingApprovals,
                    isRunning: isRunning,
                    sortTimestamp: sortTime,
                    timeText: LeverDate.compact(displayTimeRaw),
                    preview: preview,
                    isPrivate: latestChat?.isPrivate ?? false,
                    activeTopics: Array(sortedTopics),
                    unreadSessionMarks: unreadMarks
                ))
            }
        }

        let sorted = rows.sorted { lhs, rhs in
            let lPin = isPinned(lhs.id)
            let rPin = isPinned(rhs.id)
            if lPin != rPin { return lPin }
            if lhs.pendingApprovalCount != rhs.pendingApprovalCount {
                return lhs.pendingApprovalCount > rhs.pendingApprovalCount
            }
            if lhs.sortTimestamp != rhs.sortTimestamp {
                return lhs.sortTimestamp > rhs.sortTimestamp
            }
            if lhs.unreadSessionCount != rhs.unreadSessionCount {
                return lhs.unreadSessionCount > rhs.unreadSessionCount
            }
            if lhs.device.online != rhs.device.online {
                return lhs.device.online
            }
            return lhs.name.localizedCompare(rhs.name) == .orderedAscending
        }

        if cachedFeedRows != sorted {
            cachedFeedRows = sorted
        }
        let unreadSum = sorted.reduce(0) { $0 + $1.unreadSessionCount }
        let pendingSum = sorted.reduce(0) { $0 + $1.pendingApprovalCount }
        let runningSum = sorted.filter(\.isRunning).count
        if cachedTotalUnread != unreadSum { cachedTotalUnread = unreadSum }
        if cachedTotalPending != pendingSum { cachedTotalPending = pendingSum }
        if cachedTotalRunning != runningSum { cachedTotalRunning = runningSum }
    }

    func globalSearch(query: String) async -> [GlobalSearchHit] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let matches = await db.search(query)
        guard !Task.isCancelled else { return [] }
        var results: [GlobalSearchHit] = []
        var seen = Set<String>()
        var indexes: [String: [String: ArchiveRecord]] = [:]
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        for match in matches {
            let record = match.record
            guard let colon = match.scope.firstIndex(of: ":") else { continue }
            let owner = String(match.scope[match.scope.index(after: colon)...].prefix { $0 != "|" })
            guard hostDevices.contains(where: { $0.id == owner && !$0.revoked }) else { continue }
            if indexes[owner] == nil {
                indexes[owner] = Dictionary(mergedIndex(for: owner).map { ("\($0.kind):\($0.id)", $0) }, uniquingKeysWith: { _, new in new })
            }
            let chatID = record.kind == "chat" ? record.id : record.chatId
            let chat = chatID.flatMap { indexes[owner]?["chat:\($0)"] }
            guard record.kind == "agent" || chat != nil else { continue }
            let session = record.sessionId.flatMap { indexes[owner]?["session:\($0)"] }
            let agentID = record.kind == "agent" ? record.id : (record.agentId ?? chat?.agentId ?? session?.agentId)
            guard let agentID, let row = cachedFeedRows.first(where: { $0.agentId == agentID && $0.device.id == owner }) else { continue }
            let kind: GlobalSearchHit.Kind
            switch record.kind {
            case "agent": kind = .agent
            case "chat": kind = .chat
            case "session" where record.type == "topic": kind = .topic
            case "run": kind = .message
            default: continue
            }
            let id = "\(owner):\(record.kind):\(record.id)"
            guard seen.insert(id).inserted else { continue }
            let candidates = ([record.text, record.preview] + (record.items ?? []).filter { $0.kind == "text" || $0.kind == "user" }.map(\.text)).compactMap { $0 }
            let excerpt = candidates.lazy.compactMap { value -> String? in
                guard let match = terms.compactMap({ value.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) }).min(by: { $0.lowerBound < $1.lowerBound }) else { return nil }
                let start = value.index(match.lowerBound, offsetBy: -18, limitedBy: value.startIndex) ?? value.startIndex
                return (start == value.startIndex ? "" : "…") + value[start...].prefix(160)
            }.first
            let topic = kind == .topic ? record.id : (session?.type == "topic" ? session?.id : nil)
            results.append(GlobalSearchHit(id: id, kind: kind, deviceId: owner, agentId: agentID,
                agentName: row.name, avatar: row.avatar, avatarSpec: row.avatarSpec, chatId: chatID ?? row.latestChat?.id,
                topicId: topic, isPrivate: chat?.isPrivate ?? row.isPrivate,
                title: record.title ?? session?.title ?? chat?.title ?? row.name,
                subtitle: excerpt ?? String((record.preview ?? record.text ?? row.preview).prefix(160)),
                timeText: LeverDate.compact(record.messageAt ?? record.updatedAt ?? record.createdAt)))
        }
        return results
    }

    /// Memoized O(1) drawer projection for right-edge swipe drawer (zero stutter while dragging!).
    func agentDrawerData(deviceId: String, agentId: String) -> AgentDrawerData {
        let _ = dataVersion
        let cacheKey = "\(deviceId):\(agentId)"
        if let hit = drawerDataCache[cacheKey] {
            return hit
        }

        let records = mergedIndex(for: deviceId)
        let chats = chatsForAgent(deviceId: deviceId, agentId: agentId)
        var sessionsByChat: [String: [ArchiveRecord]] = [:]
        for r in records where r.kind == "session" {
            if let cid = r.chatId {
                sessionsByChat[cid, default: []].append(r)
            }
        }

        var activeTopics: [AgentDrawerTopicItem] = []
        var clearedTopics: [AgentDrawerTopicItem] = []
        var activeChats: [AgentDrawerChatItem] = []
        var clearedChats: [AgentDrawerChatItem] = []

        for chat in chats {
            let chatTitle = (chat.title?.isEmpty == false) ? chat.title! : "未命名对话"
            let sessions = sessionsByChat[chat.id] ?? []
            let mainSess = sessions.first { $0.type == "main" }
            let topicSessions = sessions.filter { $0.type == "topic" }

            // Match Desktop AgentSidebar: skip completely empty 0-session "New chat" stubs
            if mainSess == nil && topicSessions.isEmpty {
                continue
            }

            var chatActiveTopicCount = 0
            var chatUnreadCount = 0
            var chatPendingCount = 0
            var chatRunning = false
            var bestPreview = ""
            var bestTime = max(LeverDate.timestamp(chat.updatedAt), LeverDate.timestamp(chat.createdAt))
            var bestTimeRaw = chat.updatedAt ?? chat.createdAt

            var activeTopicClearMarks: [ClearMark] = []
            var activeTopicReadMarks: [ReadMark] = []
            var latestClearedTopicId: String?
            var latestClearedTopicTime: TimeInterval = -1

            var mainUnread = false
            var mainPending = 0
            var mainRunning = false
            var mainCleared = false

            if let mainSess {
                mainUnread = isSessionUnread(deviceId: deviceId, session: mainSess)
                mainPending = mainSess.pendingCount ?? 0
                mainRunning = isActiveRunStatus(mainSess.activeStatus)
                mainCleared = isSessionCleared(deviceId: deviceId, session: mainSess)
                if mainUnread { chatUnreadCount += 1 }
                chatPendingCount += mainPending
                if mainRunning { chatRunning = true }
                if let p = mainSess.preview, !p.isEmpty { bestPreview = p }
                let mt = LeverDate.timestamp(mainSess.messageAt ?? mainSess.createdAt)
                if mt > bestTime {
                    bestTime = mt
                    bestTimeRaw = mainSess.messageAt ?? mainSess.createdAt
                }
            }

            for sess in topicSessions {
                let unread = isSessionUnread(deviceId: deviceId, session: sess)
                let pending = sess.pendingCount ?? 0
                let running = isActiveRunStatus(sess.activeStatus)
                if unread { chatUnreadCount += 1 }
                chatPendingCount += pending
                if running { chatRunning = true }

                let cleared = isSessionCleared(deviceId: deviceId, session: sess)
                let tRaw = (sess.messageAt?.isEmpty == false) ? sess.messageAt : sess.createdAt
                let tSort = LeverDate.timestamp(tRaw)
                if tSort > bestTime {
                    bestTime = tSort
                    bestTimeRaw = tRaw
                }

                if cleared {
                    if tSort > latestClearedTopicTime {
                        latestClearedTopicTime = tSort
                        latestClearedTopicId = sess.id
                    }
                } else {
                    chatActiveTopicCount += 1
                    if !running && pending == 0 {
                        let uSeq = sess.unreadSequence ?? 0
                        activeTopicClearMarks.append(ClearMark(sessionId: sess.id, sequence: max(uSeq, 1)))
                        if unread && uSeq > 0 {
                            activeTopicReadMarks.append(ReadMark(sessionId: sess.id, sequence: uSeq))
                        }
                    }
                }

                let status: String
                if pending > 0 || sess.activeStatus == "waiting_user" {
                    status = "approval"
                } else if running {
                    status = "running"
                } else if unread {
                    status = "unread"
                } else {
                    status = "idle"
                }

                // Allow clearing any idle (non-running, non-pending) topic even if unread (auto-marks read)
                let canClear = !running && pending == 0 && !cleared

                let item = AgentDrawerTopicItem(
                    id: sess.id,
                    chatId: chat.id,
                    chatTitle: chatTitle,
                    isPrivate: chat.isPrivate,
                    title: (sess.title?.isEmpty == false) ? sess.title! : "独立话题",
                    preview: sess.preview ?? "",
                    status: status,
                    isUnread: unread,
                    isCleared: cleared,
                    canClear: canClear,
                    unreadSequence: sess.unreadSequence ?? 0,
                    replyCount: sess.replyCount ?? 0,
                    sortTimestamp: tSort,
                    timeText: LeverDate.compact(tRaw)
                )
                if cleared {
                    clearedTopics.append(item)
                } else {
                    activeTopics.append(item)
                }
            }

            // Evaluate Chat cleared status 1:1 with Lever Desktop:
            // - Normal Chat (has mainSess): reflects mainSess's own cleared state independently of Topics!
            // - Topic-only Chat (mainSess == nil): cleared once all its Topics are cleared!
            let chatIsCleared: Bool
            let chatCanClear: Bool
            let clearMarksForChat: [ClearMark]
            let clearReadMarksForChat: [ReadMark]
            let restoreSessionIds: [String]

            if let mainSess {
                chatIsCleared = mainCleared
                chatCanClear = !mainCleared && !mainRunning && mainPending == 0
                let uSeq = mainSess.unreadSequence ?? 0
                clearMarksForChat = [ClearMark(sessionId: mainSess.id, sequence: max(uSeq, 1))]
                clearReadMarksForChat = (mainUnread && uSeq > 0) ? [ReadMark(sessionId: mainSess.id, sequence: uSeq)] : []
                restoreSessionIds = [mainSess.id]
            } else {
                chatIsCleared = chatActiveTopicCount == 0 && !chatRunning && chatPendingCount == 0
                chatCanClear = !chatIsCleared && !chatRunning && chatPendingCount == 0 && !activeTopicClearMarks.isEmpty
                clearMarksForChat = activeTopicClearMarks
                clearReadMarksForChat = activeTopicReadMarks
                restoreSessionIds = latestClearedTopicId.map { [$0] } ?? []
            }

            let chatItem = AgentDrawerChatItem(
                id: chat.id,
                restoreSessionIds: restoreSessionIds,
                isPrivate: chat.isPrivate,
                title: chatTitle,
                preview: bestPreview.isEmpty ? (topicSessions.isEmpty ? "暂无消息" : "\(topicSessions.count) 个话题") : bestPreview,
                topicCount: topicSessions.count,
                unreadCount: chatUnreadCount,
                isRunning: chatRunning,
                pendingCount: chatPendingCount,
                isCleared: chatIsCleared,
                canClear: chatCanClear,
                clearMarks: clearMarksForChat,
                clearReadMarks: clearReadMarksForChat,
                sortTimestamp: bestTime,
                timeText: LeverDate.compact(bestTimeRaw)
            )
            if chatIsCleared {
                clearedChats.append(chatItem)
            } else {
                activeChats.append(chatItem)
            }
        }

        let topicSort: (AgentDrawerTopicItem, AgentDrawerTopicItem) -> Bool = { lhs, rhs in
            func prio(_ s: String) -> Int {
                switch s {
                case "approval": return 4
                case "running": return 3
                case "unread": return 2
                default: return 1
                }
            }
            let lp = prio(lhs.status), rp = prio(rhs.status)
            if lp != rp { return lp > rp }
            return lhs.sortTimestamp > rhs.sortTimestamp
        }

        let result = AgentDrawerData(
            activeTopics: activeTopics.sorted(by: topicSort),
            activeChats: activeChats.sorted { $0.sortTimestamp > $1.sortTimestamp },
            clearedTopics: clearedTopics.sorted { $0.sortTimestamp > $1.sortTimestamp },
            clearedChats: clearedChats.sorted { $0.sortTimestamp > $1.sortTimestamp }
        )
        drawerDataCache[cacheKey] = result
        return result
    }

    func agentRecord(deviceId: String, agentId: String) -> ArchiveRecord? {
        let _ = dataVersion
        let key = "\(deviceId):\(agentId)"
        if let hit = agentRecordCache[key] {
            return hit
        }
        if let found = mergedIndex(for: deviceId).first(where: { $0.kind == "agent" && $0.id == agentId }) {
            agentRecordCache[key] = found
            return found
        }
        return nil
    }

    func chatsForAgent(deviceId: String, agentId: String) -> [ArchiveRecord] {
        mergedIndex(for: deviceId)
            .filter { $0.kind == "chat" && (($0.agentId == agentId) || ("__chat:\($0.id)" == agentId)) }
            .sorted {
                max(LeverDate.timestamp($0.updatedAt), LeverDate.timestamp($0.createdAt)) >
                max(LeverDate.timestamp($1.updatedAt), LeverDate.timestamp($1.createdAt))
            }
    }

    /// Memoized O(1) Desktop-aligned timeline snapshot:
    /// - Unions index sessions with detailed chat sessions so Topics always render immediately
    /// - Tracks real `mainHasQueuedRuns` (prevents false "主会话排队已暂停" banner when 0 runs queued)
    /// - Projects authentic session/run `model` & `effort` for both main Chat and every Topic
    func timelineSnapshot(deviceId: String, chatId: String, isPrivate: Bool) -> TimelineSnapshot {
        let key = chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate)
        let _ = dataVersion
        let _ = chatVersionByKey[key]
        if let hit = timelineSnapshotCache[key] {
            return hit
        }
        let snapshot = computeTimelineSnapshot(deviceId: deviceId, chatId: chatId, key: key)
        timelineSnapshotCache[key] = snapshot
        return snapshot
    }

    private func computeTimelineSnapshot(deviceId: String, chatId: String, key: String) -> TimelineSnapshot {
        let detailRecords = chatRecordsByKey[key] ?? []
        let indexRecords = mergedIndex(for: deviceId)

        // Union sessions from index and detail (detail takes precedence when loaded)
        var sessionMap: [String: ArchiveRecord] = [:]
        for r in indexRecords where r.kind == "session" && r.chatId == chatId {
            sessionMap[r.id] = r
        }
        for r in detailRecords where r.kind == "session" && r.chatId == chatId {
            sessionMap[r.id] = r
        }
        let sessions = Array(sessionMap.values)
        let mainSess = sessions.first { $0.type == "main" }
        let topicSessions = sessions.filter { $0.type == "topic" }

        let allRuns = detailRecords
            .filter { $0.kind == "run" && $0.chatId == chatId && $0.superseded != true }
            .sorted { ($0.sequence ?? 0) < ($1.sequence ?? 0) }

        var requestsByRun: [String: [ArchiveRecord]] = [:]
        for req in detailRecords where req.kind == "request" && req.chatId == chatId {
            if let rid = req.runId {
                requestsByRun[rid, default: []].append(req)
            }
        }

        var runsBySession: [String: [ArchiveRecord]] = [:]
        var runCreatedById: [String: TimeInterval] = [:]
        for run in allRuns {
            if let sid = run.sessionId {
                runsBySession[sid, default: []].append(run)
            }
            runCreatedById[run.id] = LeverDate.timestamp(run.createdAt)
        }

        var entries: [TimelineEntry] = []
        let mainRuns = mainSess.flatMap { runsBySession[$0.id] } ?? []
        for run in mainRuns {
            entries.append(.mainRun(run, requests: requestsByRun[run.id] ?? []))
        }

        let mainHasQueuedRuns = mainRuns.contains { $0.status == "queued" }
        let latestMainModelRun = mainRuns.last { $0.model?.isEmpty == false }
        let mainProvider = latestMainModelRun?.provider ?? ((mainSess?.provider?.isEmpty == false) ? mainSess?.provider : nil)
        let mainModel = latestMainModelRun?.model ?? ((mainSess?.model?.isEmpty == false) ? mainSess?.model : nil)
        let mainEffort = latestMainModelRun?.effort ?? ((mainSess?.effort?.isEmpty == false) ? mainSess?.effort : nil)
        let mainFast = latestMainModelRun?.fast ?? (mainSess?.fast ?? false)
        let oldestMainSeq = mainRuns.compactMap(\.sequence).min()

        var topics: [TopicSummary] = []
        topics.reserveCapacity(topicSessions.count)

        for sess in topicSessions {
            let tRuns = runsBySession[sess.id] ?? []
            var tReqsByRun: [String: [ArchiveRecord]] = [:]
            var pendingReq: ArchiveRecord?
            var previewLines: [TopicPreviewLine] = []

            for (idx, run) in tRuns.enumerated() {
                let reqs = requestsByRun[run.id] ?? []
                tReqsByRun[run.id] = reqs
                if pendingReq == nil, let p = reqs.first(where: { $0.status == "pending" }) {
                    pendingReq = p
                }
                if idx > 0, let inp = run.text?.trimmingCharacters(in: .whitespacesAndNewlines), !inp.isEmpty {
                    previewLines.append(TopicPreviewLine(id: "u:\(run.id)", isUser: true, text: inp))
                }
                if let lastText = (run.items ?? []).last(where: { $0.kind == "text" && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?.text {
                    previewLines.append(TopicPreviewLine(id: "a:\(run.id)", isUser: false, text: lastText))
                } else if let err = run.error, !err.isEmpty {
                    previewLines.append(TopicPreviewLine(id: "e:\(run.id)", isUser: false, text: err))
                }
            }

            let rootPrompt = tRuns.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let title: String
            if let t = sess.title, !t.isEmpty {
                title = t
            } else if !rootPrompt.isEmpty {
                title = String(rootPrompt.prefix(48))
            } else {
                title = "独立话题"
            }

            let lastRun = tRuns.last
            var latestReplyText = ""
            var latestIsUser = false
            if let lastRun {
                if let lastTextItem = (lastRun.items ?? []).last(where: { $0.kind == "text" && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                    latestReplyText = lastTextItem.text ?? ""
                } else if let err = lastRun.error, !err.isEmpty {
                    latestReplyText = err
                } else if let inp = lastRun.text, !inp.isEmpty {
                    latestReplyText = inp
                    latestIsUser = true
                }
            } else if let p = sess.preview, !p.isEmpty {
                latestReplyText = p
            }

            let status: String
            if pendingReq != nil || lastRun?.status == "waiting_user" || (sess.pendingCount ?? 0) > 0 {
                status = "approval"
            } else if isActiveRunStatus(lastRun?.status) || isActiveRunStatus(sess.activeStatus) {
                status = "running"
            } else if lastRun?.status == "failed" {
                status = "failed"
            } else {
                status = "done"
            }

            let latestModelRun = tRuns.last { $0.model?.isEmpty == false }
            let topicModel = latestModelRun?.model ?? ((sess.model?.isEmpty == false) ? sess.model : nil)
            let topicEffort = latestModelRun?.effort ?? ((sess.effort?.isEmpty == false) ? sess.effort : nil)
            let topicFast = latestModelRun?.fast ?? (sess.fast ?? false)
            let topicProvider = latestModelRun?.provider ?? ((sess.provider?.isEmpty == false) ? sess.provider : nil)
            let oldestTopicSeq = tRuns.compactMap(\.sequence).min()

            let anchorTime: TimeInterval
            if let srcId = sess.sourceRunId, let srcTime = runCreatedById[srcId] {
                anchorTime = srcTime + 0.001
            } else if let firstRunTime = tRuns.first.map({ LeverDate.timestamp($0.createdAt) }), firstRunTime > 0 {
                anchorTime = firstRunTime
            } else {
                anchorTime = LeverDate.timestamp(sess.createdAt)
            }

            let updatedTime = max(
                LeverDate.timestamp(sess.messageAt),
                max(LeverDate.timestamp(lastRun?.updatedAt ?? lastRun?.createdAt), anchorTime)
            )
            let isActive = status == "approval" || status == "running"
            let unread = isSessionUnread(deviceId: deviceId, session: sess)
            let cleared = isSessionCleared(deviceId: deviceId, session: sess, isActiveRun: isActive)

            let summary = TopicSummary(
                id: sess.id,
                chatId: chatId,
                title: title,
                rootPrompt: rootPrompt.isEmpty ? title : rootPrompt,
                latestReplyText: latestReplyText,
                latestReplyIsUser: latestIsUser,
                previewLines: Array(previewLines.suffix(3)),
                pendingRequest: pendingReq,
                status: status,
                model: topicModel,
                effort: topicEffort,
                fast: topicFast,
                provider: topicProvider,
                replyCount: max(tRuns.count, sess.replyCount ?? 0),
                unreadSequence: sess.unreadSequence ?? 0,
                isUnread: unread,
                isCleared: cleared,
                canClear: !cleared && !isActive,
                anchorTimestamp: anchorTime,
                updatedTimestamp: updatedTime,
                runs: tRuns,
                requestsByRun: tReqsByRun,
                oldestRunSequence: oldestTopicSeq
            )
            topics.append(summary)
            entries.append(.topicCard(summary))
        }

        entries.sort { $0.sortDate < $1.sortDate }
        topics.sort { $0.updatedTimestamp > $1.updatedTimestamp }
        return TimelineSnapshot(
            entries: entries,
            topics: topics,
            mainSession: mainSess,
            mainHasQueuedRuns: mainHasQueuedRuns,
            mainProvider: mainProvider,
            mainModel: mainModel,
            mainEffort: mainEffort,
            mainFast: mainFast,
            oldestMainSequence: oldestMainSeq
        )
    }
}
