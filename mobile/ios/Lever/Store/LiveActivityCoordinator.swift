import ActivityKit
import Foundation
import UIKit

@MainActor
final class LiveActivityCoordinator {
    typealias Live = Activity<LeverActivityAttributes>
    struct Snapshot: Equatable {
        let attributes: LeverActivityAttributes
        let state: LeverActivityAttributes.ContentState
    }
    private var desired: (enabled: Bool, snapshot: Snapshot?, hub: String?, push: Bool) = (false, nil, nil, false)
    private var revision = 0
    private var worker: Task<Void, Never>?
    private var tokens: Task<Void, Never>?
    private var observedID: String?
    private var registered: String?
    private var retryAfter = Date.distantPast

    var current: LeverActivityAttributes? {
        Live.activities.first(where: { $0.activityState == .active || $0.activityState == .stale })?.attributes
    }

    func reconcile(enabled: Bool, snapshot: Snapshot?, hub: String?, push: Bool = false) {
        desired = (enabled, snapshot, hub, push)
        revision &+= 1
        guard worker == nil else { return }
        worker = Task {
            var done: Int
            repeat {
                done = revision
                await apply()
            } while done != revision
            worker = nil
        }
    }

    private func apply() async {
        let (enabled, snapshot, hub, push) = desired
        var activity = Live.activities.first { $0.activityState == .active || $0.activityState == .stale }
        if !enabled {
            tokens?.cancel(); tokens = nil; observedID = nil; registered = nil
            for item in Live.activities { await item.end(nil, dismissalPolicy: .immediate); await unregister(item, hub: hub) }
            return
        }
        if !push {
            tokens?.cancel()
            tokens = nil
            if observedID != nil, let activity { await unregister(activity, hub: hub) }
            observedID = nil
            registered = nil
        }
        guard let snapshot else { return }
        let content = ActivityContent(state: snapshot.state, staleDate: Date().addingTimeInterval(15 * 60))
        if let old = activity, old.attributes.run != snapshot.attributes.run || old.attributes.node != snapshot.attributes.node {
            await old.end(nil, dismissalPolicy: .immediate)
            await unregister(old, hub: hub)
            activity = nil
        }
        if snapshot.state.ended {
            if let activity {
                await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(300)))
                await unregister(activity, hub: hub)
            }
            tokens?.cancel(); observedID = nil; registered = nil
            return
        }
        if activity == nil {
            guard UIApplication.shared.applicationState == .active, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
            if hub != nil {
                activity = try? Live.request(attributes: snapshot.attributes, content: content, pushType: .token)
            }
            if activity == nil { activity = try? Live.request(attributes: snapshot.attributes, content: content) }
        } else if activity?.content.state != snapshot.state { await activity?.update(content) }
        guard push, let activity, let hub else { return }
        if observedID != activity.id {
            tokens?.cancel()
            observedID = activity.id
            registered = nil
            retryAfter = .distantPast
            tokens = Task {
                for await token in activity.pushTokenUpdates {
                    guard !Task.isCancelled else { return }
                    await register(token, activity: activity, hub: hub)
                }
            }
        }
        if let token = activity.pushToken, Date() >= retryAfter { await register(token, activity: activity, hub: hub) }
    }

    private func register(_ token: Data, activity: Live, hub: String) async {
        let value = token.map { String(format: "%02x", $0) }.joined()
        guard registered != value, observedID == activity.id, desired.enabled, desired.push, desired.hub == hub else { return }
        let attr = activity.attributes
        do {
            try await LeverBridge.shared.requestVoid("PUT", path: hub + "/push/live-activity", body: [
                "activityId":activity.id,"deviceId":attr.node,"sessionId":attr.session,"runId":attr.run,"token":value])
            if observedID == activity.id { registered = value }
        } catch { retryAfter = Date().addingTimeInterval(30) }
    }

    private func unregister(_ activity: Live, hub: String?) async {
        guard let hub else { return }
        try? await LeverBridge.shared.requestVoid("DELETE", path: hub + "/push/live-activity", body: ["activityId":activity.id])
    }
}

extension LeverStore {
    func updateLiveActivity() {
        let tracked = activities.current
        var candidate: LiveActivityCoordinator.Snapshot?
        let space = activeSpace?.id ?? ""
        if lockScreenProgress && isPaired {
            for host in hostDevices where host.online && !host.revoked {
                let index = mergedIndex(for: host.id)
                let sessions = Dictionary(index.filter { $0.kind == "session" }.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                // Older Owners publish progress only in the open conversation's history.
                let runs = liveRunsByDevice[host.id] ?? chatRecordsByKey
                    .filter { parseChatKey($0.key)?.deviceId == host.id }
                    .flatMap { $0.value.filter { $0.kind == "run" } }
                for run in runs where run.superseded != true {
                    guard let chat = run.chatId, let session = run.sessionId, let summary = sessions[session],
                          let agent = summary.agentId, summary.chatId == chat else { continue }
                    let same = tracked?.space == space && tracked?.node == host.id && tracked?.run == run.id
                    let phase: LeverActivityAttributes.ContentState.Phase
                    switch run.status {
                    case "completed" where same: phase = .completed
                    case "failed" where same, "interrupted" where same, "cancelled" where same: phase = .failed
                    case "waiting_user", "paused": phase = .waitingUser
                    case "starting", "running", "cancelling": phase = (run.pendingCount ?? 0) > 0 ? .waitingUser : .running
                    default: continue
                    }
                    guard let started = LeverDate.parse(run.createdAt) else { continue }
                    let attr = LeverActivityAttributes(space: space, node: host.id, agent: agent, chat: chat, session: session,
                                                      run: run.id, isTopic: summary.type == "topic", started: started)
                    let steps = max(run.stepCount ?? 0, (run.items ?? []).filter { $0.kind != "user" && $0.kind != "text" }.count)
                    let next = LiveActivityCoordinator.Snapshot(attributes: attr, state: .init(phase: phase, stepCount: steps,
                        pendingCount: max(run.pendingCount ?? 0, phase == .waitingUser ? 1 : 0)))
                    if same { candidate = next; break }
                    if candidate.map({ started > $0.attributes.started }) ?? true { candidate = next }
                }
                if let candidate, candidate.attributes.run == tracked?.run && candidate.attributes.node == tracked?.node { break }
            }
        }
        let revoked = tracked.map { attributes in
            devices.contains { $0.id == attributes.node && $0.revoked }
        } ?? false
        activities.reconcile(enabled: lockScreenProgress && isPaired && !revoked, snapshot: candidate,
                             hub: isDirectMode ? nil : spacePath, push: pushSettings.enabled)
    }
}
