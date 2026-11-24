import type { Chat, Conversation, Request } from "../../api/types.gen.ts";

export type ChatSourceGroup =
  | "user"
  | "channel"
  | "automation"
  | "task"
  | "delegation";

export type ChatSourceFilter = "all" | ChatSourceGroup;

export type ChatSourceBadge =
  | "user"
  | "larkx"
  | "feishu"
  | "channel"
  | "automation"
  | "task"
  | "delegation"
  | "comparison";

export type ChatHistoryStatus =
  | "waiting_user"
  | "waiting_blocked"
  | "unknown"
  | "running"
  | "waiting"
  | "paused";

export type ChatHistoryTabState = "active" | "open" | "closed";

export type ChatHistoryTriggerAlert = "attention" | "running" | "unread";

export type ChatHistoryRun = {
  chatId: string;
  sessionId: string;
  status: string;
  waiting?: boolean;
  waitingBlocked?: boolean;
  quiet?: boolean;
};

export type ChatHistoryOverview = {
  chats: readonly Chat[];
  conversations: readonly Conversation[];
  runs: readonly ChatHistoryRun[];
  requests: readonly Pick<Request, "chatId" | "sessionId">[];
};

export type ChatHistoryEntry = {
  chat: Chat;
  title: string;
  sourceGroup: ChatSourceGroup;
  sourceBadge: ChatSourceBadge;
  sourceLabel: string;
  preview: string;
  topicCount: number;
  topicTitles: string[];
  lastActivityAt: string;
  lastActivityMs: number;
  status?: ChatHistoryStatus;
  unread: boolean;
  quiet: boolean;
  tabState: ChatHistoryTabState;
};

export type ChatSourceFilterSummary = {
  id: ChatSourceFilter;
  count: number;
};

const sourceGroupOrder: readonly ChatSourceGroup[] = [
  "user",
  "channel",
  "automation",
  "task",
  "delegation",
];

const workingStatuses = new Set(["starting", "running", "cancelling"]);

function parseTime(timestamp?: string): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyChatSource(chat: Pick<Chat, "source" | "channel">): {
  group: ChatSourceGroup;
  badge: ChatSourceBadge;
} {
  switch (chat.source) {
    case "channel": {
      const channel = chat.channel?.toLowerCase() ?? "";
      if (channel.includes("larkx")) {
        return { group: "channel", badge: "larkx" };
      }
      if (channel === "feishu" || channel === "lever.feishu") {
        return { group: "channel", badge: "feishu" };
      }
      return { group: "channel", badge: "channel" };
    }
    case "automation":
      return { group: "automation", badge: "automation" };
    case "works":
    case "workItem":
    case "task":
    case "note":
    case "taskSource":
      return { group: "task", badge: "task" };
    case "delegation":
      return { group: "delegation", badge: "delegation" };
    case "comparison":
      return { group: "user", badge: "comparison" };
    default:
      return { group: "user", badge: "user" };
  }
}

/**
 * Prefer the Agent's most recent normal user Chat when no remembered tab exists,
 * so background automations or external channel turns do not hijack the default
 * entry point for an Agent.
 */
export function preferredAgentChat<
  T extends Pick<Chat, "id" | "agentId" | "source">,
>(chats: readonly T[], agentId: string): T | undefined {
  let fallback: T | undefined;
  for (const chat of chats) {
    if (chat.agentId !== agentId) continue;
    if (!chat.source || chat.source === "user") return chat;
    fallback ??= chat;
  }
  return fallback;
}

function aggregateStatus(
  runs: readonly ChatHistoryRun[],
  hasPendingRequest: boolean,
): ChatHistoryStatus | undefined {
  if (hasPendingRequest) return "waiting_user";
  let best: ChatHistoryStatus | undefined;
  const rank = (status: ChatHistoryStatus) => {
    switch (status) {
      case "waiting_user":
        return 6;
      case "waiting_blocked":
        return 5;
      case "unknown":
        return 4;
      case "running":
        return 3;
      case "waiting":
        return 2;
      case "paused":
        return 1;
    }
  };
  const consider = (status: ChatHistoryStatus) => {
    if (!best || rank(status) > rank(best)) best = status;
  };
  for (const run of runs) {
    if (run.status === "waiting_user") {
      consider("waiting_user");
    } else if (run.status === "unknown") {
      consider("unknown");
    } else if (run.quiet) {
      continue;
    } else if (run.waiting) {
      consider(run.waitingBlocked ? "waiting_blocked" : "waiting");
    } else if (workingStatuses.has(run.status)) {
      consider("running");
    } else if (run.status === "paused") {
      consider("paused");
    }
  }
  return best;
}

export function buildChatHistory({
  agentId,
  overview,
  readCursors,
  openTabIds,
  activeTabId,
  titleOf,
  sourceLabelOf,
}: {
  agentId: string;
  overview?: ChatHistoryOverview;
  readCursors: Record<string, number>;
  openTabIds: ReadonlySet<string>;
  activeTabId?: string;
  titleOf: (chat: Chat) => string;
  sourceLabelOf: (badge: ChatSourceBadge) => string;
}): {
  entries: ChatHistoryEntry[];
  sourceFilters: ChatSourceFilterSummary[];
  triggerAlert?: ChatHistoryTriggerAlert;
} {
  if (!overview) {
    return { entries: [], sourceFilters: [] };
  }

  const conversationsByChat = new Map<string, Conversation[]>();
  for (const conversation of overview.conversations) {
    if (conversation.agentId !== agentId) continue;
    const list = conversationsByChat.get(conversation.chatId);
    if (list) list.push(conversation);
    else conversationsByChat.set(conversation.chatId, [conversation]);
  }

  const runsByChat = new Map<string, ChatHistoryRun[]>();
  for (const run of overview.runs) {
    const list = runsByChat.get(run.chatId);
    if (list) list.push(run);
    else runsByChat.set(run.chatId, [run]);
  }

  const pendingChats = new Set(overview.requests.map((req) => req.chatId));

  const entries: ChatHistoryEntry[] = [];
  for (const chat of overview.chats) {
    if (chat.agentId !== agentId) continue;
    const conversations = conversationsByChat.get(chat.id) ?? [];
    const runs = runsByChat.get(chat.id) ?? [];
    const { group, badge } = classifyChatSource(chat);
    const title = titleOf(chat);
    const sourceLabel = sourceLabelOf(badge);
    const status = aggregateStatus(runs, pendingChats.has(chat.id));
    const tabState: ChatHistoryTabState =
      activeTabId === chat.id
        ? "active"
        : openTabIds.has(chat.id)
          ? "open"
          : "closed";

    let lastActivityAt = chat.updatedAt || chat.createdAt;
    let lastActivityMs = Math.max(
      parseTime(chat.updatedAt),
      parseTime(chat.createdAt),
    );
    let preview = "";
    let previewMs = -1;
    let topicCount = 0;
    const topicTitles: string[] = [];
    let unread = false;

    for (const conversation of conversations) {
      if (conversation.kind === "topic") {
        topicCount += 1;
        if (conversation.title) topicTitles.push(conversation.title);
      }
      if (
        !conversation.backgroundOnly &&
        conversation.unreadSequence > (readCursors[conversation.id] ?? 0)
      ) {
        unread = true;
      }
      const messageMs = parseTime(conversation.messageAt);
      const finishedMs = parseTime(conversation.finishedAt);
      const itemMs = Math.max(messageMs, finishedMs);
      if (itemMs > lastActivityMs) {
        lastActivityMs = itemMs;
        lastActivityAt =
          finishedMs >= messageMs && conversation.finishedAt
            ? conversation.finishedAt
            : conversation.messageAt;
      }
      const candidatePreview = conversation.preview.trim();
      if (candidatePreview && itemMs >= previewMs) {
        previewMs = itemMs;
        preview = candidatePreview;
      }
    }

    const isBackgroundOnly =
      Boolean(chat.source) &&
      chat.source !== "user" &&
      conversations.length > 0 &&
      conversations.every((conversation) => conversation.backgroundOnly);
    // Keep currently open or attention-needing chats visible even if their runs were quiet.
    const quiet =
      isBackgroundOnly &&
      tabState === "closed" &&
      status !== "waiting_user" &&
      status !== "unknown";

    entries.push({
      chat,
      title,
      sourceGroup: group,
      sourceBadge: badge,
      sourceLabel,
      preview: preview === title ? "" : preview,
      topicCount,
      topicTitles,
      lastActivityAt,
      lastActivityMs,
      status,
      unread,
      quiet,
      tabState,
    });
  }

  entries.sort(
    (a, b) => b.lastActivityMs - a.lastActivityMs || a.chat.id.localeCompare(b.chat.id),
  );

  const visibleEntries = entries.filter((entry) => !entry.quiet);
  const groupCounts = new Map<ChatSourceGroup, number>();
  for (const entry of visibleEntries) {
    groupCounts.set(
      entry.sourceGroup,
      (groupCounts.get(entry.sourceGroup) ?? 0) + 1,
    );
  }
  const sourceFilters: ChatSourceFilterSummary[] =
    groupCounts.size >= 2
      ? [
          { id: "all", count: visibleEntries.length },
          ...sourceGroupOrder.flatMap((id) => {
            const count = groupCounts.get(id) ?? 0;
            return count > 0 ? [{ id, count }] : [];
          }),
        ]
      : [];

  let triggerAlert: ChatHistoryTriggerAlert | undefined;
  for (const entry of visibleEntries) {
    if (entry.tabState !== "closed") continue;
    if (
      entry.status === "waiting_user" ||
      entry.status === "waiting_blocked" ||
      entry.status === "unknown"
    ) {
      triggerAlert = "attention";
      break;
    }
    if (entry.status === "running" || entry.status === "waiting") {
      triggerAlert = "running";
    } else if (entry.unread && !triggerAlert) {
      triggerAlert = "unread";
    }
  }

  return { entries, sourceFilters, triggerAlert };
}

export function filterChatHistory({
  entries,
  filter,
  query,
  showQuiet,
}: {
  entries: readonly ChatHistoryEntry[];
  filter: ChatSourceFilter;
  query: string;
  showQuiet: boolean;
}): {
  entries: ChatHistoryEntry[];
  hiddenQuietCount: number;
} {
  const term = query.trim().toLowerCase();
  const quietEntries = entries.filter((entry) => entry.quiet);
  const hiddenQuietCount = !term && !showQuiet ? quietEntries.length : 0;

  const filtered = entries.filter((entry) => {
    if (entry.quiet && !showQuiet && !term) return false;
    if (filter !== "all" && entry.sourceGroup !== filter) return false;
    if (!term) return true;
    return (
      entry.title.toLowerCase().includes(term) ||
      entry.preview.toLowerCase().includes(term) ||
      entry.sourceLabel.toLowerCase().includes(term) ||
      entry.topicTitles.some((title) => title.toLowerCase().includes(term))
    );
  });

  return { entries: filtered, hiddenQuietCount };
}
