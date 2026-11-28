import Foundation

extension LeverStore {
    // MARK: - Bidirectional Read-State & Cleared-State Sync

    func effectiveReadCursor(deviceId: String, session: ArchiveRecord) -> Int64 {
        let serverSeq = session.readSequence ?? 0
        let hubSeq = hubReadCursors[deviceId]?[session.id] ?? 0
        let localSeq = localReadCursors["\(deviceId):\(session.id)"] ?? 0
        return max(serverSeq, max(hubSeq, localSeq))
    }

    func isSessionUnread(deviceId: String, session: ArchiveRecord) -> Bool {
        let unread = session.unreadSequence ?? 0
        guard unread > 0 else { return false }
        return unread > effectiveReadCursor(deviceId: deviceId, session: session)
    }

    func effectiveClearedCursor(deviceId: String, session: ArchiveRecord) -> Int64 {
        let key = "\(deviceId):\(session.id)"
        if let local = localClearedCursors[key] {
            if local == 0 { return 0 }
            let server = max(session.clearedSequence ?? 0, hubClearedCursors[deviceId]?[session.id] ?? 0)
            return max(local, server)
        }
        return max(session.clearedSequence ?? 0, hubClearedCursors[deviceId]?[session.id] ?? 0)
    }

    func isSessionCleared(deviceId: String, session: ArchiveRecord, isActiveRun: Bool = false) -> Bool {
        let pending = (session.pendingCount ?? 0) > 0
        let running = isActiveRun || isActiveRunStatus(session.activeStatus)
        if pending || running || isSessionUnread(deviceId: deviceId, session: session) {
            return false
        }
        let cleared = effectiveClearedCursor(deviceId: deviceId, session: session)
        guard cleared > 0 else { return false }
        let unreadSeq = session.unreadSequence ?? 0
        return unreadSeq <= cleared
    }

    func clearSessions(
        deviceId: String,
        marks: [ClearMark],
        alsoMarkRead readMarks: [ReadMark] = [],
        banner: String? = nil
    ) {
        let normalized = marks.compactMap { m -> ClearMark? in
            guard !m.sessionId.isEmpty else { return nil }
            return ClearMark(sessionId: m.sessionId, sequence: max(m.sequence, 1))
        }
        guard !normalized.isEmpty else { return }
        Haptics.light()

        // Mark unread idle sessions read atomically so Desktop & Mobile agree on readAndIdle + cleared
        let filteredReadMarks = readMarks.filter { mark in
            guard !mark.sessionId.isEmpty, mark.sequence > 0 else { return false }
            let key = "\(deviceId):\(mark.sessionId)"
            let current = max(
                localReadCursors[key] ?? 0,
                hubReadCursors[deviceId]?[mark.sessionId] ?? 0
            )
            return mark.sequence > current
        }
        if !filteredReadMarks.isEmpty {
            for mark in filteredReadMarks {
                let key = "\(deviceId):\(mark.sessionId)"
                localReadCursors[key] = max(localReadCursors[key] ?? 0, mark.sequence)
            }
            db.saveKV(localReadCursors, forKey: "read_cursors")
        }

        for m in normalized {
            let key = "\(deviceId):\(m.sessionId)"
            localClearedCursors[key] = max(localClearedCursors[key] ?? 0, m.sequence)
        }
        db.saveKV(localClearedCursors, forKey: "cleared_cursors")
        invalidateAllProjections()
        if let banner { showBanner(banner) }
        guard let sPath = spacePath else { return }
        let clearPayload = ClearSyncRequest(deviceId: deviceId, items: normalized)
        let readPayload = filteredReadMarks.isEmpty ? nil : ReadSyncRequest(deviceId: deviceId, items: filteredReadMarks)
        Task {
            if let readPayload {
                try? await bridge.requestVoid("POST", path: hasNativeOwner(deviceId) ? "\(sPath)/nodes/\(deviceId)/read" : "\(sPath)/read", body: readPayload)
            }
            try? await bridge.requestVoid("POST", path: "\(sPath)/cleared", body: clearPayload)
        }
    }

    func clearSingleTopic(deviceId: String, topicId: String, unreadSequence: Int64, title: String) {
        let readMarks = unreadSequence > 0 ? [ReadMark(sessionId: topicId, sequence: unreadSequence)] : []
        clearSessions(
            deviceId: deviceId,
            marks: [ClearMark(sessionId: topicId, sequence: max(unreadSequence, 1))],
            alsoMarkRead: readMarks,
            banner: "已清理话题「\(title)」并同步桌面"
        )
    }

    func restoreSessions(deviceId: String, sessionIds: [String], banner: String? = nil) {
        let ids = sessionIds.filter { !$0.isEmpty }
        guard !ids.isEmpty else { return }
        Haptics.light()
        let marks = ids.map { ClearMark(sessionId: $0, sequence: 0) }
        for id in ids {
            localClearedCursors["\(deviceId):\(id)"] = 0
        }
        db.saveKV(localClearedCursors, forKey: "cleared_cursors")
        invalidateAllProjections()
        if let banner { showBanner(banner) }
        guard let sPath = spacePath else { return }
        let payload = ClearSyncRequest(deviceId: deviceId, items: marks)
        Task {
            try? await bridge.requestVoid("POST", path: "\(sPath)/cleared", body: payload)
        }
    }

    func markSessionsRead(deviceId: String, marks: [ReadMark], banner: String? = nil) {
        let filtered = marks.filter { mark in
            guard !mark.sessionId.isEmpty, mark.sequence > 0 else { return false }
            let key = "\(deviceId):\(mark.sessionId)"
            let current = max(
                localReadCursors[key] ?? 0,
                hubReadCursors[deviceId]?[mark.sessionId] ?? 0
            )
            return mark.sequence > current
        }
        guard !filtered.isEmpty else { return }

        for mark in filtered {
            let key = "\(deviceId):\(mark.sessionId)"
            localReadCursors[key] = max(localReadCursors[key] ?? 0, mark.sequence)
        }
        db.saveKV(localReadCursors, forKey: "read_cursors")
        invalidateAllProjections()

        if let banner {
            showBanner(banner)
        }

        guard let sPath = spacePath else { return }
        let payload = ReadSyncRequest(deviceId: deviceId, items: filtered)
        Task {
            try? await bridge.requestVoid("POST", path: hasNativeOwner(deviceId) ? "\(sPath)/nodes/\(deviceId)/read" : "\(sPath)/read", body: payload)
        }
    }

    func markAgentRead(_ row: AgentFeedRow) {
        guard !row.unreadSessionMarks.isEmpty else { return }
        Haptics.light()
        markSessionsRead(
            deviceId: row.device.id,
            marks: row.unreadSessionMarks,
            banner: "「\(row.name)」已标为已读并同步到桌面"
        )
    }

    func markAllRead() {
        var grouped: [String: [ReadMark]] = [:]
        for row in cachedFeedRows where !row.unreadSessionMarks.isEmpty {
            grouped[row.device.id, default: []].append(contentsOf: row.unreadSessionMarks)
        }
        guard !grouped.isEmpty else { return }
        Haptics.medium()
        for (devId, marks) in grouped {
            markSessionsRead(deviceId: devId, marks: marks)
        }
        showBanner("全部已读状态已同步至桌面")
    }

    // MARK: - Pinning

    func isPinned(_ rowId: String) -> Bool {
        pinnedAgentKeys.contains(rowId)
    }

    func togglePin(_ rowId: String) {
        Haptics.light()
        if let idx = pinnedAgentKeys.firstIndex(of: rowId) {
            pinnedAgentKeys.remove(at: idx)
        } else {
            pinnedAgentKeys.insert(rowId, at: 0)
        }
        UserDefaults.standard.set(pinnedAgentKeys, forKey: "lever.pinnedAgents")
        invalidateAllProjections()
    }
}
