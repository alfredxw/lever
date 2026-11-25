import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  Agent,
  Chat,
  ChatView,
  Overview,
  Run,
  Session,
} from "../src/api/types.gen";

const selection = { provider: "codex", model: "", effort: "", fast: false };

function fixtureContext() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

function localISO(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
) {
  return new Date(year, monthIndex, day, hour, minute, second).toISOString();
}

async function seedTimestampChat(
  page: Page,
  {
    language = "zh-CN",
    now = new Date(2026, 10, 25, 12, 30, 0),
  }: {
    language?: "zh-CN" | "en-US";
    now?: Date;
  } = {},
) {
  const { url, scope } = fixtureContext();
  await page.clock.install({ time: now });
  await page.addInitScript((lang) => {
    localStorage.setItem("lever:language", lang);
  }, language);

  const prevYearCreated = localISO(2025, 2, 5, 9, 5, 10);
  const prevYearFinished = localISO(2025, 2, 5, 9, 6, 22);
  const earlierYearCreated = localISO(2026, 10, 20, 14, 22, 5);
  const earlierYearFinished = localISO(2026, 10, 20, 14, 23, 18);
  const yesterdayCreated = localISO(2026, 10, 24, 20, 37, 12);
  const yesterdayFinished = localISO(2026, 10, 24, 20, 38, 45);
  const todayCreated = localISO(2026, 10, 25, 9, 15, 0);
  const todayFinished = localISO(2026, 10, 25, 9, 16, 30);

  const agent: Agent = {
    id: "agent-time",
    name: "时间核对",
    profile: {
      provider: selection.provider,
      model: selection.model,
      roots: [{ id: "root", path: scope }],
      primaryRootId: "root",
      permission: "ask",
      instructions: "",
      skills: [],
      delegations: [],
    },
    archived: false,
    createdAt: prevYearCreated,
    updatedAt: todayFinished,
  };

  const chat: Chat = {
    id: "chat-time",
    agentId: agent.id,
    title: "历史消息时间",
    source: "user",
    createdAt: prevYearCreated,
    updatedAt: todayFinished,
  };

  const mainSession: Session = {
    id: "session-main",
    agentId: agent.id,
    chatId: chat.id,
    kind: "main",
    nativeId: "",
    roots: agent.profile.roots,
    primaryRootId: agent.profile.primaryRootId,
    selection,
    createdAt: prevYearCreated,
  };

  const topicSession: Session = {
    id: "session-topic-yesterday",
    agentId: agent.id,
    chatId: chat.id,
    kind: "topic",
    title: "昨天的独立话题",
    nativeId: "",
    roots: agent.profile.roots,
    primaryRootId: agent.profile.primaryRootId,
    selection,
    createdAt: yesterdayCreated,
  };

  const runs: Run[] = [
    {
      id: "run-prev-year",
      chatId: chat.id,
      sessionId: mainSession.id,
      agentId: agent.id,
      sequence: 1,
      selection,
      input: "去年的消息",
      attachments: [],
      handoff: false,
      status: "completed",
      items: [{ id: "i1", kind: "text", text: "去年的回复", status: "completed" }],
      createdAt: prevYearCreated,
      finishedAt: prevYearFinished,
    },
    {
      id: "run-earlier-year",
      chatId: chat.id,
      sessionId: mainSession.id,
      agentId: agent.id,
      sequence: 2,
      selection,
      input: "今年更早的消息",
      attachments: [],
      handoff: false,
      status: "completed",
      items: [
        { id: "i2", kind: "text", text: "今年更早的回复", status: "completed" },
      ],
      createdAt: earlierYearCreated,
      finishedAt: earlierYearFinished,
    },
    {
      id: "run-yesterday-topic",
      chatId: chat.id,
      sessionId: topicSession.id,
      agentId: agent.id,
      sequence: 1,
      selection,
      input: "昨天晚上发的话题消息",
      attachments: [],
      handoff: false,
      status: "completed",
      items: [
        { id: "i3", kind: "text", text: "昨天话题回复", status: "completed" },
      ],
      createdAt: yesterdayCreated,
      finishedAt: yesterdayFinished,
    },
    {
      id: "run-today",
      chatId: chat.id,
      sessionId: mainSession.id,
      agentId: agent.id,
      sequence: 3,
      selection,
      input: "今天早上的消息",
      attachments: [],
      handoff: false,
      status: "completed",
      items: [{ id: "i4", kind: "text", text: "今天的回复", status: "completed" }],
      createdAt: todayCreated,
      finishedAt: todayFinished,
    },
  ];

  const overview: Overview = {
    cursor: 4,
    agents: [agent],
    chats: [chat],
    conversations: [
      {
        id: mainSession.id,
        agentId: agent.id,
        chatId: chat.id,
        kind: "main",
        title: chat.title,
        preview: "今天的回复",
        messageAt: todayFinished,
        unreadSequence: 3,
      },
    ],
    runs: [],
    requests: [],
    dataDir: "",
    homeDir: "",
    deviceId: "fixture",
    deviceName: "fixture",
    platform: process.platform,
  };

  const view: ChatView = {
    chat,
    sessions: [mainSession, topicSession],
    entries: [
      { kind: "main", sessionId: mainSession.id, runId: "run-prev-year", replyCount: 0 },
      { kind: "main", sessionId: mainSession.id, runId: "run-earlier-year", replyCount: 0 },
      { kind: "topic", sessionId: topicSession.id, runId: "run-yesterday-topic", replyCount: 0 },
      { kind: "main", sessionId: mainSession.id, runId: "run-today", replyCount: 0 },
    ],
    runs,
    hasMore: false,
    cursor: 4,
  };

  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route(/\/api\/chats\/chat-time(\?|$)/, (route) =>
    route.fulfill({ json: view }),
  );
  await page.route(/\/api\/chats\/chat-time\/delegations/, (route) =>
    route.fulfill({ json: { outgoing: {} } }),
  );

  await page.goto(url);
  await expect(page.locator('[data-run-id="run-today"]')).toBeVisible();
}

test("older messages include dates while today stays 24h time, and midnight rollover updates visible timestamps", async ({
  page,
}) => {
  await seedTimestampChat(page, { language: "zh-CN" });

  const prevYear = page.locator('[data-run-id="run-prev-year"]');
  await expect(prevYear.locator(".user-message .message-actions time")).toHaveText(
    "2025年3月5日 09:05",
  );
  await expect(prevYear.locator(".agent-message .message-actions time")).toHaveText(
    "2025年3月5日 09:06",
  );
  await expect(prevYear.locator(".user-message .message-actions time")).toHaveAttribute(
    "title",
    "2025年3月5日 09:05:10",
  );

  const earlierYear = page.locator('[data-run-id="run-earlier-year"]');
  await expect(
    earlierYear.locator(".user-message .message-actions time"),
  ).toHaveText("11月20日 14:22");
  await expect(
    earlierYear.locator(".agent-message .message-actions time"),
  ).toHaveText("11月20日 14:23");

  const yesterdayTopic = page.locator('[data-session-id="session-topic-yesterday"]');
  await expect(
    yesterdayTopic.locator(".user-message .message-actions time"),
  ).toHaveText("昨天 20:37");
  await expect(
    yesterdayTopic.locator(".user-message .message-actions time"),
  ).toHaveAttribute("title", "2026年11月24日 20:37:12");

  const today = page.locator('[data-run-id="run-today"]');
  await expect(today.locator(".user-message .message-actions time")).toHaveText(
    "09:15",
  );
  await expect(today.locator(".agent-message .message-actions time")).toHaveText(
    "09:16",
  );

  // Hover the yesterday topic message to capture how the timestamp reads in context.
  await yesterdayTopic.locator(".user-message").hover();
  await expect(
    yesterdayTopic.locator(".user-message .message-actions-secondary"),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "../output/e2e/message-timestamps-zh.png" });

  // Advance past local midnight without reloading: today becomes yesterday, yesterday becomes month+day.
  await page.clock.fastForward(12 * 60 * 60 * 1000);
  await expect(today.locator(".user-message .message-actions time")).toHaveText(
    "昨天 09:15",
  );
  await expect(
    yesterdayTopic.locator(".user-message .message-actions time"),
  ).toHaveText("11月24日 20:37");
});

test("older messages format dates cleanly in en-US locale", async ({ page }) => {
  await seedTimestampChat(page, { language: "en-US" });

  await expect(
    page.locator('[data-run-id="run-prev-year"] .user-message .message-actions time'),
  ).toHaveText("Mar 5, 2025, 09:05");
  await expect(
    page.locator(
      '[data-run-id="run-earlier-year"] .user-message .message-actions time',
    ),
  ).toHaveText("Nov 20, 14:22");
  await expect(
    page.locator(
      '[data-session-id="session-topic-yesterday"] .user-message .message-actions time',
    ),
  ).toHaveText("Yesterday 20:37");
  await expect(
    page.locator('[data-run-id="run-today"] .user-message .message-actions time'),
  ).toHaveText("09:15");
});
