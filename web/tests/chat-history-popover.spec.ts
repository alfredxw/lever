import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  Agent,
  Chat,
  ChatView,
  Overview,
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

async function seedMultiSourceWorkbench(
  page: Page,
  {
    storedWorkspace,
    singleSource = false,
  }: {
    storedWorkspace?: Record<string, unknown>;
    singleSource?: boolean;
  } = {},
) {
  const { url, scope } = fixtureContext();
  const agent: Agent = {
    id: "agent-code",
    name: "代码搭档",
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
    createdAt: "2026-11-24T08:00:00Z",
    updatedAt: "2026-11-24T08:00:00Z",
  };
  const otherAgent: Agent = {
    ...agent,
    id: "agent-docs",
    name: "文档搭档",
  };

  const chats: Chat[] = singleSource
    ? [
        {
          id: "chat-daily",
          agentId: agent.id,
          title: "重构工作台 Tab 淘汰",
          source: "user",
          createdAt: "2026-11-24T08:00:00Z",
          updatedAt: "2026-11-24T09:10:00Z",
        },
        {
          id: "chat-mobile",
          agentId: agent.id,
          title: "移动端配对体验",
          source: "user",
          createdAt: "2026-11-24T07:00:00Z",
          updatedAt: "2026-11-24T08:30:00Z",
        },
      ]
    : [
        {
          id: "chat-larkx",
          agentId: agent.id,
          title: "Larkx · 个人渠道",
          source: "channel",
          channel: "inhouse.larkx",
          createdAt: "2026-11-24T08:00:00Z",
          updatedAt: "2026-11-24T09:50:00Z",
        },
        {
          id: "chat-auto",
          agentId: agent.id,
          title: "每日 PR 巡检",
          source: "automation",
          createdAt: "2026-11-24T08:00:00Z",
          updatedAt: "2026-11-24T09:40:00Z",
        },
        {
          id: "chat-daily",
          agentId: agent.id,
          title: "重构工作台 Tab 淘汰",
          source: "user",
          createdAt: "2026-11-24T08:00:00Z",
          updatedAt: "2026-11-24T09:20:00Z",
        },
        {
          id: "chat-works",
          agentId: agent.id,
          title: "Works",
          source: "works",
          createdAt: "2026-11-24T08:00:00Z",
          updatedAt: "2026-11-24T09:00:00Z",
        },
        {
          id: "chat-quiet",
          agentId: agent.id,
          title: "依赖安全周报",
          source: "automation",
          createdAt: "2026-11-24T07:00:00Z",
          updatedAt: "2026-11-24T09:30:00Z",
        },
        {
          id: "chat-other",
          agentId: otherAgent.id,
          title: "其他 Agent 的文档对话",
          source: "user",
          createdAt: "2026-11-24T08:00:00Z",
          updatedAt: "2026-11-24T09:55:00Z",
        },
      ];

  const overview: Overview = {
    cursor: 10,
    agents: [agent, otherAgent],
    projects: [],
    chats,
    conversations: singleSource
      ? [
          {
            id: "s-daily-main",
            agentId: agent.id,
            chatId: "chat-daily",
            kind: "main",
            title: "重构工作台 Tab 淘汰",
            preview: "确认默认回退逻辑",
            messageAt: "2026-11-24T09:10:00Z",
            unreadSequence: 1,
          },
        ]
      : [
          {
            id: "s-larkx-t1",
            agentId: agent.id,
            chatId: "chat-larkx",
            kind: "topic",
            title: "研发群 · 构建超时",
            preview: "正在验证 arm64 缓存挂载",
            messageAt: "2026-11-24T09:50:00Z",
            unreadSequence: 2,
          },
          {
            id: "s-larkx-t2",
            agentId: agent.id,
            chatId: "chat-larkx",
            kind: "topic",
            title: "私聊 · 下周发布节奏",
            preview: "已拆出 3 个发布检查项",
            messageAt: "2026-11-24T08:50:00Z",
            unreadSequence: 1,
          },
          {
            id: "s-auto-t1",
            agentId: agent.id,
            chatId: "chat-auto",
            kind: "topic",
            title: "11-24 09:00 巡检",
            preview: "发现 2 个阻塞合并的 CI 失败",
            messageAt: "2026-11-24T09:40:00Z",
            unreadSequence: 3,
          },
          {
            id: "s-daily-main",
            agentId: agent.id,
            chatId: "chat-daily",
            kind: "main",
            title: "重构工作台 Tab 淘汰",
            preview: "tabLeftOrder 只在离开选中标签时递增",
            messageAt: "2026-11-24T09:20:00Z",
            unreadSequence: 1,
          },
          {
            id: "s-daily-t1",
            agentId: agent.id,
            chatId: "chat-daily",
            kind: "topic",
            title: "核对 preview tab 焦点",
            preview: "双击后固定标签",
            messageAt: "2026-11-24T09:15:00Z",
            unreadSequence: 1,
          },
          {
            id: "s-works-t1",
            agentId: agent.id,
            chatId: "chat-works",
            kind: "topic",
            title: "#89 修复缩放抖动",
            preview: "已完成并通过布局测试",
            messageAt: "2026-11-24T09:00:00Z",
            unreadSequence: 1,
          },
          {
            id: "s-quiet-t1",
            agentId: agent.id,
            chatId: "chat-quiet",
            kind: "topic",
            title: "11-24 03:00 依赖扫描",
            preview: "本周无高危 CVE 漏洞",
            messageAt: "2026-11-24T09:30:00Z",
            backgroundOnly: true,
            unreadSequence: 1,
          },
        ],
    runs: singleSource
      ? []
      : [
          {
            id: "run-auto",
            chatId: "chat-auto",
            sessionId: "s-auto-t1",
            agentId: agent.id,
            sequence: 1,
            selection,
            input: "巡检 PR",
            attachments: [],
            handoff: false,
            status: "waiting_user",
            items: [],
            createdAt: "2026-11-24T09:40:00Z",
          },
        ],
    requests: [],
    dataDir: "",
    homeDir: "",
    deviceId: "fixture",
    deviceName: "fixture",
    platform: process.platform,
  };

  await page.route((url) => url.pathname === "/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route(/\/api\/chats\/[^/?]+(\?|$)/, (route) => {
    const reqUrl = new URL(route.request().url());
    const chatId = reqUrl.pathname.split("/").pop() ?? "";
    const chat = chats.find((item) => item.id === chatId) ?? chats[0];
    const session: Session = {
      id: `${chat.id}-main`,
      agentId: chat.agentId,
      chatId: chat.id,
      kind: "main",
      nativeId: "",
      roots: agent.profile.roots,
      primaryRootId: agent.profile.primaryRootId,
      selection,
      createdAt: chat.createdAt,
    };
    const view: ChatView = {
      chat,
      sessions: [session],
      entries: [],
      runs: [],
      requests: [],
      cursor: 1,
      hasMore: false,
    };
    return route.fulfill({ json: view });
  });

  await page.addInitScript(
    ({ agentId, storedWorkspace }) => {
      localStorage.setItem("lever:agent", agentId);
      if (storedWorkspace) {
        localStorage.setItem(
          "lever:workspaces",
          JSON.stringify(storedWorkspace),
        );
      }
    },
    { agentId: agent.id, storedWorkspace },
  );

  await page.goto(url);
  return { agent, chats };
}

test("default workspace fallback prefers user Chat over newer channel and automation Chats", async ({
  page,
}) => {
  await seedMultiSourceWorkbench(page);
  await expect(
    page.getByRole("tab", { name: "重构工作台 Tab 淘汰" }),
  ).toHaveAttribute("aria-selected", "true");
});

test("ChatHistoryPopover switches, filters, splits, discloses quiet chats, and links to message search", async ({
  page,
}) => {
  // Simulate the exact user pain point: only Larkx and Automation tabs are open;
  // the user's daily Chat was closed/evicted.
  await seedMultiSourceWorkbench(page, {
    storedWorkspace: {
      "agent-code": {
        tabs: [
          { id: "chat-larkx", kind: "chat", title: "Larkx · 个人渠道" },
          { id: "chat-auto", kind: "chat", title: "每日 PR 巡检" },
        ],
        selected: "chat-larkx",
      },
    },
  });

  const historyButton = page.getByRole("button", {
    name: "最近对话",
    exact: true,
  });
  await expect(historyButton).toBeVisible();
  await historyButton.click();

  const dialog = page.getByRole("dialog", { name: "代码搭档的对话列表" });
  await expect(dialog).toBeVisible();

  const filterInput = dialog.getByRole("textbox", { name: "筛选对话…" });
  await expect(filterInput).toBeFocused();

  // Verify AGENTS.md rule: no focus ring/outline/glow shadow on trigger or popover buttons.
  const triggerStyles = await historyButton.evaluate((el) => {
    const style = getComputedStyle(el);
    return { outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
  });
  expect(triggerStyles.outlineStyle).toBe("none");
  expect(triggerStyles.boxShadow).toBe("none");

  // Lists current Agent's non-quiet chats only (excludes other Agent and hides quiet chat).
  const options = dialog.getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options.nth(0)).toContainText("Larkx · 个人渠道");
  await expect(options.nth(0)).toContainText("Larkx");
  await expect(options.nth(0)).toContainText("2 话题");
  await expect(options.nth(1)).toContainText("每日 PR 巡检");
  await expect(options.nth(2)).toContainText("重构工作台 Tab 淘汰");
  await expect(options.nth(3)).toContainText("工作");
  await expect(dialog).not.toContainText("其他 Agent 的文档对话");
  await expect(dialog).not.toContainText("依赖安全周报");

  // Source filter pills work cleanly.
  await dialog.getByRole("radio", { name: /渠道/ }).click();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Larkx · 个人渠道");

  await dialog.getByRole("radio", { name: /全部/ }).click();
  await expect(options).toHaveCount(4);

  // Quiet automation chat can be disclosed on demand.
  await dialog
    .getByRole("button", { name: "显示 1 个静默自动化对话" })
    .click();
  await expect(options).toHaveCount(5);
  await expect(dialog).toContainText("依赖安全周报");

  // Filtering matches Topic titles inside a container Chat.
  await filterInput.fill("下周发布节奏");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Larkx · 个人渠道");

  // Clear filter and reopen closed daily Chat via keyboard Enter.
  await dialog.getByRole("button", { name: "清空筛选" }).click();
  await filterInput.fill("重构工作台");
  await expect(options).toHaveCount(1);
  await filterInput.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("tab", { name: "重构工作台 Tab 淘汰" }),
  ).toHaveAttribute("aria-selected", "true");

  // Open another Chat in the side pane using the row split action.
  await historyButton.click();
  await expect(dialog).toBeVisible();
  const worksRow = dialog.locator('[data-chat-id="chat-works"]');
  await worksRow.hover();
  await worksRow.getByRole("button", { name: "在另一分栏打开" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.locator('.tab-strip[data-pane="side"]').getByRole("tab", { name: "工作" }),
  ).toBeVisible();

  // Footer action jumps directly to Agent-scoped message search.
  await historyButton.click();
  await dialog.getByRole("button", { name: /搜全部消息/ }).click();
  await expect(dialog).not.toBeVisible();
  const searchDialog = page.getByRole("dialog", { name: "搜索 Lever" });
  await expect(searchDialog).toBeVisible();
  await expect(
    searchDialog.getByRole("button", { name: "搜索范围" }),
  ).toHaveText("代码搭档");
  await expect(
    searchDialog.getByRole("radio", { name: "消息", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Agent-scoped empty search puts Chats ahead of Topics.
  await page.getByRole("button", { name: "搜索当前 Agent" }).click();
  await expect(searchDialog).toBeVisible();
  await expect(
    searchDialog.getByRole("option").first(),
  ).toHaveAttribute("data-value", /^chat:/);
});

test("ChatHistoryPopover hides source filter bar when Agent only has normal user Chats", async ({
  page,
}) => {
  await seedMultiSourceWorkbench(page, { singleSource: true });
  await page.getByRole("button", { name: "最近对话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "代码搭档的对话列表" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("group", { name: "按来源筛选" }),
  ).toHaveCount(0);
  await expect(dialog.getByRole("option")).toHaveCount(2);
});
