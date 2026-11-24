import assert from "node:assert/strict";
import test from "node:test";
import type { Chat, Conversation } from "../src/api/types.gen.ts";
import {
  buildChatHistory,
  classifyChatSource,
  filterChatHistory,
  preferredAgentChat,
  type ChatHistoryOverview,
} from "../src/components/workbench/chatHistoryModel.ts";

function makeChat(overrides: Partial<Chat> & { id: string }): Chat {
  return {
    agentId: "agent-1",
    title: overrides.id,
    source: "user",
    createdAt: "2026-11-24T08:00:00Z",
    updatedAt: "2026-11-24T08:00:00Z",
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<Conversation> & { id: string; chatId: string },
): Conversation {
  return {
    agentId: "agent-1",
    kind: "main",
    title: overrides.id,
    preview: "",
    messageAt: "2026-11-24T08:00:00Z",
    unreadSequence: 0,
    ...overrides,
  };
}

test("classifyChatSource maps all Lever chat sources and channels", () => {
  assert.deepEqual(classifyChatSource({ source: "", channel: undefined }), {
    group: "user",
    badge: "user",
  });
  assert.deepEqual(classifyChatSource({ source: "user" }), {
    group: "user",
    badge: "user",
  });
  assert.deepEqual(classifyChatSource({ source: "comparison" }), {
    group: "user",
    badge: "comparison",
  });
  assert.deepEqual(
    classifyChatSource({ source: "channel", channel: "inhouse.larkx" }),
    { group: "channel", badge: "larkx" },
  );
  assert.deepEqual(
    classifyChatSource({ source: "channel", channel: "feishu" }),
    { group: "channel", badge: "feishu" },
  );
  assert.deepEqual(
    classifyChatSource({ source: "channel", channel: "custom.bot" }),
    { group: "channel", badge: "channel" },
  );
  assert.deepEqual(classifyChatSource({ source: "automation" }), {
    group: "automation",
    badge: "automation",
  });
  for (const source of ["works", "workItem", "task", "note", "taskSource"]) {
    assert.deepEqual(classifyChatSource({ source }), {
      group: "task",
      badge: "task",
    });
  }
  assert.deepEqual(classifyChatSource({ source: "delegation" }), {
    group: "delegation",
    badge: "delegation",
  });
});

test("preferredAgentChat prefers newest user Chat over channel/automation Chats", () => {
  const chats = [
    makeChat({ id: "c-larkx", source: "channel", channel: "inhouse.larkx" }),
    makeChat({ id: "c-auto", source: "automation" }),
    makeChat({ id: "c-daily", source: "user" }),
    makeChat({ id: "c-other-agent", agentId: "agent-2", source: "user" }),
  ];
  assert.equal(preferredAgentChat(chats, "agent-1")?.id, "c-daily");

  // Falls back to first non-user Chat when Agent has no normal user Chat yet.
  const onlySpecial = [
    makeChat({ id: "c-larkx", source: "channel", channel: "inhouse.larkx" }),
    makeChat({ id: "c-auto", source: "automation" }),
  ];
  assert.equal(preferredAgentChat(onlySpecial, "agent-1")?.id, "c-larkx");
  assert.equal(preferredAgentChat(chats, "missing"), undefined);
});

test("buildChatHistory aggregates topics, status, recency, filters, quiet chats, and trigger alert", () => {
  const overview: ChatHistoryOverview = {
    chats: [
      makeChat({
        id: "c-daily",
        title: "重构 Tab 淘汰",
        source: "user",
        updatedAt: "2026-11-24T09:00:00Z",
      }),
      makeChat({
        id: "c-larkx",
        title: "Larkx · 个人渠道",
        source: "channel",
        channel: "inhouse.larkx",
        updatedAt: "2026-11-24T08:30:00Z",
      }),
      makeChat({
        id: "c-auto",
        title: "每日 PR 巡检",
        source: "automation",
        updatedAt: "2026-11-24T09:10:00Z",
      }),
      makeChat({
        id: "c-quiet",
        title: "依赖安全周报",
        source: "automation",
        updatedAt: "2026-11-24T09:30:00Z",
      }),
      makeChat({
        id: "c-other",
        agentId: "agent-2",
        title: "其他 Agent 对话",
        source: "user",
        updatedAt: "2026-11-24T10:00:00Z",
      }),
    ],
    conversations: [
      makeConversation({
        id: "s-daily-main",
        chatId: "c-daily",
        kind: "main",
        preview: "主对话最新摘要",
        messageAt: "2026-11-24T09:05:00Z",
        unreadSequence: 2,
      }),
      makeConversation({
        id: "s-larkx-t1",
        chatId: "c-larkx",
        kind: "topic",
        title: "研发群 · 构建超时",
        preview: "已定位到交叉编译缓存",
        messageAt: "2026-11-24T09:40:00Z",
        unreadSequence: 3,
      }),
      makeConversation({
        id: "s-larkx-t2",
        chatId: "c-larkx",
        kind: "topic",
        title: "私聊 · 发布节奏",
        preview: "整理发布项",
        messageAt: "2026-11-24T08:40:00Z",
      }),
      makeConversation({
        id: "s-auto-t1",
        chatId: "c-auto",
        kind: "topic",
        title: "11-24 09:00",
        preview: "发现 2 个失败",
        messageAt: "2026-11-24T09:15:00Z",
        unreadSequence: 1,
      }),
      makeConversation({
        id: "s-quiet-t1",
        chatId: "c-quiet",
        kind: "topic",
        title: "静默周报",
        preview: "无漏洞",
        messageAt: "2026-11-24T09:35:00Z",
        backgroundOnly: true,
        unreadSequence: 1,
      }),
    ],
    runs: [
      { chatId: "c-larkx", sessionId: "s-larkx-t1", status: "running" },
      { chatId: "c-auto", sessionId: "s-auto-t1", status: "waiting_user" },
      {
        chatId: "c-quiet",
        sessionId: "s-quiet-t1",
        status: "running",
        quiet: true,
      },
    ],
    requests: [],
  };

  const result = buildChatHistory({
    agentId: "agent-1",
    overview,
    readCursors: { "s-daily-main": 2 },
    openTabIds: new Set(["c-larkx"]),
    activeTabId: "c-larkx",
    titleOf: (chat) => chat.title,
    sourceLabelOf: (badge) =>
      badge === "user" ? "" : badge === "larkx" ? "Larkx" : "自动化",
  });

  // Excludes agent-2; sorted by latest activity (including topic timestamps).
  assert.deepEqual(
    result.entries.map((entry) => entry.chat.id),
    ["c-larkx", "c-quiet", "c-auto", "c-daily"],
  );

  const larkx = result.entries[0];
  assert.equal(larkx.topicCount, 2);
  assert.equal(larkx.preview, "已定位到交叉编译缓存");
  assert.equal(larkx.status, "running");
  assert.equal(larkx.tabState, "active");
  assert.equal(larkx.quiet, false);

  const quiet = result.entries[1];
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.status, undefined);

  const auto = result.entries[2];
  assert.equal(auto.status, "waiting_user");
  assert.equal(auto.tabState, "closed");
  assert.equal(auto.unread, true);

  // Trigger alert detects closed attention chat (c-auto).
  assert.equal(result.triggerAlert, "attention");

  // Source filters appear when >= 2 non-quiet groups exist, excluding quiet chats.
  assert.deepEqual(result.sourceFilters, [
    { id: "all", count: 3 },
    { id: "user", count: 1 },
    { id: "channel", count: 1 },
    { id: "automation", count: 1 },
  ]);

  // Filtering hides quiet by default, matches topics, and reveals quiet when searching or toggled.
  const defaultFiltered = filterChatHistory({
    entries: result.entries,
    filter: "all",
    query: "",
    showQuiet: false,
  });
  assert.deepEqual(
    defaultFiltered.entries.map((e) => e.chat.id),
    ["c-larkx", "c-auto", "c-daily"],
  );
  assert.equal(defaultFiltered.hiddenQuietCount, 1);

  const topicSearch = filterChatHistory({
    entries: result.entries,
    filter: "all",
    query: "发布节奏",
    showQuiet: false,
  });
  assert.deepEqual(
    topicSearch.entries.map((e) => e.chat.id),
    ["c-larkx"],
  );

  const quietSearch = filterChatHistory({
    entries: result.entries,
    filter: "all",
    query: "漏洞",
    showQuiet: false,
  });
  assert.deepEqual(
    quietSearch.entries.map((e) => e.chat.id),
    ["c-quiet"],
  );
  assert.equal(quietSearch.hiddenQuietCount, 0);

  const expandedQuiet = filterChatHistory({
    entries: result.entries,
    filter: "all",
    query: "",
    showQuiet: true,
  });
  assert.equal(expandedQuiet.entries.length, 4);
  assert.equal(expandedQuiet.hiddenQuietCount, 0);
});

test("buildChatHistory omits source filter bar when Agent only has normal user Chats", () => {
  const result = buildChatHistory({
    agentId: "agent-1",
    overview: {
      chats: [
        makeChat({ id: "c-1", title: "日常 A" }),
        makeChat({ id: "c-2", title: "日常 B" }),
      ],
      conversations: [],
      runs: [],
      requests: [],
    },
    readCursors: {},
    openTabIds: new Set(["c-1"]),
    activeTabId: "c-1",
    titleOf: (chat) => chat.title,
    sourceLabelOf: () => "",
  });
  assert.deepEqual(result.sourceFilters, []);
  assert.equal(result.triggerAlert, undefined);
});
