import Foundation

extension LeverStore {
    // MARK: - Composer Metadata (Multi-Provider Catalog, Starred Favorites, Skills) & Attachments

    func composerScopeKey(deviceId: String, agentId: String, providerId: String?) -> String {
        "\(deviceId)|\(agentId)|\(providerId ?? "")"
    }

    func providerCatalogs(deviceId: String, fallbackAgent: ArchiveRecord? = nil) -> [ProviderCatalog] {
        if let list = providersByDevice[deviceId], !list.isEmpty {
            return list
        }
        if let agent = fallbackAgent, let prov = agent.provider, !prov.isEmpty {
            return [ProviderCatalog(
                id: prov,
                name: prov,
                type: prov,
                pluginId: nil,
                models: agent.models,
                commands: nil
            )]
        }
        return []
    }

    func skills(deviceId: String, agentId: String, providerId: String?) -> [MessageReference] {
        let exact = composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: providerId)
        if let list = skillsByScopeKey[exact], !list.isEmpty { return list }
        let fallback = composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: nil)
        return skillsByScopeKey[fallback] ?? []
    }

    func starredModels(deviceId: String) -> [String: Set<String>] {
        let map = starredModelsByDevice[deviceId] ?? [:]
        return map.mapValues { Set($0) }
    }

    func isModelStarred(deviceId: String, providerId: String, modelId: String) -> Bool {
        starredModelsByDevice[deviceId]?[providerId]?.contains(modelId) == true
    }

    func toggleStarredModel(deviceId: String, providerId: String, modelId: String) {
        guard !providerId.isEmpty, !modelId.isEmpty else { return }
        Haptics.light()
        var deviceMap = starredModelsByDevice[deviceId] ?? [:]
        var list = deviceMap[providerId] ?? []
        if let idx = list.firstIndex(of: modelId) {
            list.remove(at: idx)
        } else {
            list.append(modelId)
        }
        if list.isEmpty {
            deviceMap.removeValue(forKey: providerId)
        } else {
            deviceMap[providerId] = list
        }
        starredModelsByDevice[deviceId] = deviceMap
        db.saveKV(starredModelsByDevice, forKey: "starred_models")

        guard let sPath = spacePath else { return }
        let payload = deviceMap
        Task {
            if let saved: [String: [String]] = try? await bridge.request("PUT", path: "\(sPath)/starred-models/\(deviceId)", body: payload) {
                if self.starredModelsByDevice[deviceId] != saved {
                    self.starredModelsByDevice[deviceId] = saved
                    self.db.saveKV(self.starredModelsByDevice, forKey: "starred_models")
                }
            }
        }
    }

    func loadComposerMeta(
        deviceId: String,
        agentId: String,
        chatId: String? = nil,
        sessionId: String? = nil,
        providerId: String? = nil
    ) async {
        guard let sPath = spacePath else { return }
        var params: [String] = []
        if !agentId.isEmpty { params.append("agent=\(urlEncode(agentId))") }
        if let chatId, !chatId.isEmpty { params.append("chat=\(urlEncode(chatId))") }
        if let sessionId, !sessionId.isEmpty { params.append("session=\(urlEncode(sessionId))") }
        if let providerId, !providerId.isEmpty { params.append("provider=\(urlEncode(providerId))") }
        let qs = params.isEmpty ? "" : "?\(params.joined(separator: "&"))"
        guard let meta: ComposerMeta = try? await bridge.request("GET", path: "\(sPath)/composer-meta/\(deviceId)\(qs)") else {
            return
        }
        if !meta.providers.isEmpty && providersByDevice[deviceId] != meta.providers {
            providersByDevice[deviceId] = meta.providers
            db.saveKV(providersByDevice, forKey: "providers_by_device")
        }
        // Merge remote starred models with local cache (remote authoritative when non-empty)
        if !meta.starredModels.isEmpty || starredModelsByDevice[deviceId] == nil {
            if starredModelsByDevice[deviceId] != meta.starredModels {
                starredModelsByDevice[deviceId] = meta.starredModels
                db.saveKV(starredModelsByDevice, forKey: "starred_models")
            }
        }
        let exactKey = composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: providerId)
        if skillsByScopeKey[exactKey] != meta.skills {
            skillsByScopeKey[exactKey] = meta.skills
        }
        if providerId == nil || skillsByScopeKey[composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: nil)] == nil {
            skillsByScopeKey[composerScopeKey(deviceId: deviceId, agentId: agentId, providerId: nil)] = meta.skills
        }
    }

    func uploadAttachment(
        deviceId: String,
        chatId: String?,
        agentId: String,
        fileName: String,
        data: Data
    ) async throws -> AttachmentRef {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let req = AttachmentUploadRequest(
            chatId: chatId,
            agentId: chatId == nil ? agentId : nil,
            name: fileName,
            data: data.base64EncodedString()
        )
        return try await bridge.request("POST", path: "\(sPath)/attachments/\(deviceId)", body: req)
    }

    /// Returns grouped `@` mention candidates (Topics, Chats, Agents) for live Composer suggestions.
    func mentionCandidates(
        deviceId: String,
        currentAgentId: String,
        currentSessionId: String?,
        query rawQuery: String
    ) -> [(label: String, items: [MessageReference])] {
        let q = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let records = mergedIndex(for: deviceId)

        var agentsById: [String: String] = [:]
        var chatsById: [String: ArchiveRecord] = [:]
        for r in records {
            if r.kind == "agent" { agentsById[r.id] = (r.title?.isEmpty == false) ? r.title! : r.id }
            if r.kind == "chat" { chatsById[r.id] = r }
        }

        var topicRefs: [(TimeInterval, MessageReference)] = []
        var chatRefs: [(TimeInterval, MessageReference)] = []
        for sess in records where sess.kind == "session" && sess.id != currentSessionId {
            guard let cid = sess.chatId, let chat = chatsById[cid] else { continue }
            let agentName = sess.agentId.flatMap { agentsById[$0] } ?? chat.agentId.flatMap { agentsById[$0] } ?? ""
            let chatTitle = (chat.title?.isEmpty == false) ? chat.title! : "主对话"
            let t = LeverDate.timestamp(sess.messageAt ?? sess.createdAt)
            if sess.type == "topic" {
                let title = (sess.title?.isEmpty == false) ? sess.title! : "独立话题"
                let desc = [agentName, chatTitle].filter { !$0.isEmpty }.joined(separator: " · ")
                if q.isEmpty || title.lowercased().contains(q) || desc.lowercased().contains(q) {
                    topicRefs.append((t, MessageReference(
                        kind: "topic", name: title, refId: sess.id, path: nil,
                        provider: nil, description: desc, argumentHint: nil, start: nil, end: nil
                    )))
                }
            } else if sess.type == "main" {
                let desc = [agentName, "主对话"].filter { !$0.isEmpty }.joined(separator: " · ")
                if q.isEmpty || chatTitle.lowercased().contains(q) || desc.lowercased().contains(q) {
                    chatRefs.append((t, MessageReference(
                        kind: "chat", name: chatTitle, refId: sess.id, path: nil,
                        provider: nil, description: desc, argumentHint: nil, start: nil, end: nil
                    )))
                }
            }
        }

        var agentRefs: [MessageReference] = []
        for r in records where r.kind == "agent" && r.id != currentAgentId {
            let name = (r.title?.isEmpty == false) ? r.title! : r.id
            let desc = r.description ?? r.model ?? ""
            if q.isEmpty || name.lowercased().contains(q) || desc.lowercased().contains(q) {
                agentRefs.append(MessageReference(
                    kind: "agent", name: name, refId: r.id, path: nil,
                    provider: nil, description: desc, argumentHint: nil, start: nil, end: nil
                ))
            }
        }

        var groups: [(String, [MessageReference])] = []
        let sortedTopics = topicRefs.sorted { $0.0 > $1.0 }.prefix(24).map(\.1)
        if !sortedTopics.isEmpty { groups.append(("话题", Array(sortedTopics))) }
        let sortedChats = chatRefs.sorted { $0.0 > $1.0 }.prefix(12).map(\.1)
        if !sortedChats.isEmpty { groups.append(("对话", Array(sortedChats))) }
        if !agentRefs.isEmpty { groups.append(("协作 Agent", agentRefs)) }
        return groups
    }

    // MARK: - Commands (Send / Topic / Model Selection / Approve / Stop / Resume)

    func sendMessage(
        deviceId: String,
        agentId: String,
        chatId: String?,
        isPrivate: Bool,
        text: String,
        mode: SendTargetMode,
        workingCopyId: String? = nil,
        selection: ModelSelection? = nil,
        attachmentIds: [String]? = nil,
        references: [MessageReference]? = nil,
        delivery: String = "queue"
    ) async throws -> CommandReceipt {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasAttachments = !(attachmentIds ?? []).isEmpty
        guard !trimmed.isEmpty || hasAttachments else { throw LeverCoreError.message("请输入消息内容或添加附件") }

        var operation = "main"
        var sessionId: String? = nil
        switch mode {
        case .main:
            operation = "main"
        case .newTopic:
            operation = "topic"
        case .topicReply(let tid):
            operation = "reply"
            sessionId = tid
        }

        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: "send",
            deviceId: deviceId,
            agentId: chatId == nil ? agentId : nil,
            workingCopyId: workingCopyId,
            chatId: chatId,
            sessionId: sessionId,
            runId: nil,
            requestId: nil,
            operation: operation,
            delivery: delivery,
            text: trimmed,
            selection: selection,
            attachmentIds: (attachmentIds?.isEmpty == false) ? attachmentIds : nil,
            references: (references?.isEmpty == false) ? references : nil,
            answer: nil
        )

        let item: InboxItem = try await submit(intent, space: sPath)
        Haptics.light()
        if let targetChat = item.receipt.chatId ?? chatId {
            let key = chatKey(deviceId: deviceId, chatId: targetChat, isPrivate: isPrivate)
            if case .topicReply(let tid) = mode {
                await refreshTopic(deviceId: deviceId, chatId: targetChat, isPrivate: isPrivate, topicId: tid)
            } else {
                await refreshChatByKey(key)
            }
        }
        await refreshAll(silent: true)
        return item.receipt
    }

    func answerRequest(
        deviceId: String,
        chatId: String,
        isPrivate: Bool,
        request: ArchiveRecord,
        answer: RequestAnswer? = nil,
        allowRun: Bool = false
    ) async throws {
        guard let sPath = spacePath else { throw LeverCoreError.message("尚未连接工作区") }
        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: allowRun ? "allow_run" : "answer",
            deviceId: deviceId,
            agentId: nil,
            workingCopyId: nil,
            chatId: chatId,
            sessionId: request.sessionId,
            runId: allowRun ? request.runId : nil,
            requestId: allowRun ? nil : request.id,
            operation: nil,
            delivery: nil,
            text: nil,
            selection: nil,
            answer: allowRun ? nil : answer
        )
        let _: InboxItem = try await submit(intent, space: sPath)
        Haptics.success()
        if let tid = activeTopicId, tid == request.sessionId {
            await refreshTopic(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate, topicId: tid)
        } else {
            await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
        }
        await refreshAll(silent: true)
    }

    func stopRun(deviceId: String, chatId: String, isPrivate: Bool, runId: String) async throws {
        guard let sPath = spacePath else { return }
        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: "stop",
            deviceId: deviceId,
            agentId: nil,
            workingCopyId: nil,
            chatId: chatId,
            sessionId: nil,
            runId: runId,
            requestId: nil,
            operation: nil,
            delivery: nil,
            text: nil,
            selection: nil,
            answer: nil
        )
        let _: InboxItem = try await submit(intent, space: sPath)
        Haptics.medium()
        if let tid = activeTopicId {
            await refreshTopic(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate, topicId: tid)
        } else {
            await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
        }
    }

    func resumeQueue(deviceId: String, chatId: String, isPrivate: Bool, sessionId: String) async throws {
        guard let sPath = spacePath else { return }
        let intent = CommandIntent(
            privateFlag: isPrivate ? true : nil,
            id: UUID().uuidString.lowercased(),
            kind: "resume_queue",
            deviceId: deviceId,
            agentId: nil,
            workingCopyId: nil,
            chatId: chatId,
            sessionId: sessionId,
            runId: nil,
            requestId: nil,
            operation: nil,
            delivery: nil,
            text: nil,
            selection: nil,
            answer: nil
        )
        let _: InboxItem = try await submit(intent, space: sPath)
        await refreshChatByKey(chatKey(deviceId: deviceId, chatId: chatId, isPrivate: isPrivate))
    }
}
