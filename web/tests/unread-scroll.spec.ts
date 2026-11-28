import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Agent, Overview, Run } from "../src/api/types.gen";

function fixtureContext() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    scope: string;
  };
}

async function waitRunCompleted(
  page: Page,
  sessionId: string,
  runId: string,
): Promise<Run> {
  let completed: Run | undefined;
  await expect
    .poll(
      async () => {
        const data = (await (
          await page.request.get(`/api/sessions/${sessionId}/runs`)
        ).json()) as { runs: Run[] };
        const found = data.runs.find((item) => item.id === runId);
        if (found?.status === "completed") completed = found;
        return found?.status;
      },
      { intervals: [50, 100] },
    )
    .toBe("completed");
  return completed!;
}

async function expectAlignedAtStartOfRun(panel: Locator, runId: string) {
  const viewport = panel.locator(".chat-scroll");
  const run = panel.locator(`[data-run-id="${runId}"]`);
  await expect(run).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "回到最新消息", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      viewport.evaluate((node, id) => {
        const item = node.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
        if (!item) return null;
        const view = node.getBoundingClientRect();
        const rect = item.getBoundingClientRect();
        return {
          topOffset: Math.round(rect.top - view.top),
          bottomBeyondView: Math.round(rect.bottom - view.bottom),
          distanceFromBottom: Math.round(
            node.scrollHeight - node.clientHeight - node.scrollTop,
          ),
        };
      }, runId),
    )
    .toEqual(
      expect.objectContaining({
        // Row starts near the top edge (with 24-32px breathing room) while its
        // long reply continues well below the viewport.
        topOffset: expect.any(Number),
        bottomBeyondView: expect.any(Number),
        distanceFromBottom: expect.any(Number),
      }),
    );

  const metrics = await viewport.evaluate((node, id) => {
    const item = node.querySelector<HTMLElement>(`[data-run-id="${id}"]`)!;
    const view = node.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    return {
      topOffset: rect.top - view.top,
      bottomBeyondView: rect.bottom - view.bottom,
      distanceFromBottom:
        node.scrollHeight - node.clientHeight - node.scrollTop,
    };
  }, runId);
  expect(metrics.topOffset).toBeGreaterThanOrEqual(-4);
  expect(metrics.topOffset).toBeLessThanOrEqual(48);
  expect(metrics.bottomBeyondView).toBeGreaterThan(200);
  expect(metrics.distanceFromBottom).toBeGreaterThan(200);
}

test("opening unread Chats and Topics lands at the start of the first unread message", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { url, scope } = fixtureContext();
  await page.setViewportSize({ width: 1360, height: 760 });
  await page.goto(url);

  // Long agent instructions make fakeruntime echo a tall (~2400px) reply for
  // even a one-line user prompt.
  const longInstructions = Array.from(
    { length: 40 },
    (_, i) =>
      `第 ${i + 1} 节详细分析：这是用于验证超长回复滚动定位的正文段落，确保整条回复显著超出视口高度。`,
  ).join("\n\n");

  const agentResponse = await page.request.post("/api/agents", {
    data: {
      name: "长回复未读定位",
      profile: {
        provider: "codex",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
        permission: "ask",
        instructions: longInstructions,
        skills: [],
        delegations: [],
      },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = (await agentResponse.json()) as Agent;

  const createChat = async (title: string) => {
    const res = await page.request.post("/api/chats", {
      data: { agentId: agent.id, title },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()) as { id: string };
  };
  const chatA = await createChat("未读主会话 A");
  const chatB = await createChat("中转会话 B");

  const postAndWait = async (
    chatId: string,
    operation: "main" | "topic" | "reply",
    text: string,
    sessionId?: string,
  ): Promise<Run> => {
    const res = await page.request.post("/api/messages", {
      data: {
        chatId,
        sessionId,
        commandId: randomUUID(),
        operation,
        text,
      },
    });
    expect(res.ok()).toBe(true);
    const run = (await res.json()) as Run;
    return waitRunCompleted(page, run.sessionId, run.id);
  };

  // Seed initial read turns in both chats so both appear in the sidebar.
  const turn1 = await postAndWait(chatA.id, "main", "第一轮已读问题");
  await postAndWait(chatB.id, "main", "中转占位问题");

  await page.reload();
  const sidebar = page.locator("#agent-sidebar");
  const agentGroup = sidebar.locator(`[data-agent-id="${agent.id}"]`);
  await expect(agentGroup).toBeVisible();
  if ((await agentGroup.getAttribute("aria-expanded")) === "false") {
    await agentGroup.getByRole("button").first().click();
  }

  const chatARow = sidebar.locator(`[data-session-id="${turn1.sessionId}"]`);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const chatBMain = overview.conversations.find(
    (c) => c.chatId === chatB.id && c.kind === "main",
  )!;
  const chatBRow = sidebar.locator(`[data-session-id="${chatBMain.id}"]`);

  // Open Chat A once so turn 1 is marked read, then switch to Chat B.
  await chatARow.click();
  const chatAPanel = page.locator(`#panel-${chatA.id}`);
  await expect(
    chatAPanel.locator(`[data-run-id="${turn1.id}"]`),
  ).toBeVisible();
  await expect(chatARow.locator(".agent-unread")).toHaveCount(0);

  await chatBRow.click();
  await expect(page.locator(`#panel-${chatB.id}`)).toBeVisible();

  // 1. Single long unread reply arrives in background retained Chat A.
  const turn2 = await postAndWait(chatA.id, "main", "第二轮超长未读问题");
  expect(turn2.unreadSequence ?? 0).toBeGreaterThan(0);
  await expect(chatARow.locator(".agent-unread")).toBeVisible();

  await chatARow.click();
  await expect(chatARow.locator(".agent-unread")).toHaveCount(0);
  await expectAlignedAtStartOfRun(chatAPanel, turn2.id);
  // Wait past the reveal settle window and confirm position remains stable.
  await page.waitForTimeout(550);
  await expectAlignedAtStartOfRun(chatAPanel, turn2.id);

  // 2. Multiple unread replies arrive while away -> lands at the FIRST unread one.
  await chatBRow.click();
  const turn3 = await postAndWait(chatA.id, "main", "第三轮首条未读");
  const turn4 = await postAndWait(chatA.id, "main", "第四轮后续未读");
  await expect(chatARow.locator(".agent-unread")).toBeVisible();

  await chatARow.click();
  await expect(chatARow.locator(".agent-unread")).toHaveCount(0);
  await expectAlignedAtStartOfRun(chatAPanel, turn3.id);
  // Confirm turn 4 is below the viewport (we landed on turn 3, not turn 4).
  const turn4Below = await chatAPanel
    .locator(".chat-scroll")
    .evaluate((node, id) => {
      const item = node.querySelector<HTMLElement>(`[data-run-id="${id}"]`);
      if (!item) return true;
      return item.getBoundingClientRect().top > node.getBoundingClientRect().bottom;
    }, turn4.id);
  expect(turn4Below).toBe(true);

  // 3. Unread Topic opened fresh lands at the start of its first unread message.
  await chatBRow.click();
  const topicRoot = await postAndWait(chatA.id, "topic", "未读长回复话题");
  const topicRow = sidebar.locator(`[data-session-id="${topicRoot.sessionId}"]`);
  await expect(topicRow.locator(".agent-unread")).toBeVisible();

  await topicRow.click();
  const topicPanel = page.locator(
    `[id="panel-${encodeURIComponent(`topic:${topicRoot.sessionId}`)}"]`,
  );
  await expect(topicRow.locator(".agent-unread")).toHaveCount(0);
  await expectAlignedAtStartOfRun(topicPanel, topicRoot.id);
  await page.waitForTimeout(550);
  await expectAlignedAtStartOfRun(topicPanel, topicRoot.id);

  // 4. Follow-up unread reply in the same Topic (while side pane is hidden)
  // jumps to the follow-up turn instead of staying on the first turn.
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "工作", exact: true }).click();
  await expect(topicPanel).toHaveAttribute("data-visible", "false");

  const topicReply = await postAndWait(
    chatA.id,
    "reply",
    "话题第二轮未读追问",
    topicRoot.sessionId,
  );
  // The pinned, already-read root is outside the newest page. The first
  // unread reply must be located in the earlier page, even across that gap.
  for (let i = 0; i < 12; i++) {
    await postAndWait(chatA.id, "reply", `后续未读追问 ${i + 1}`, topicRoot.sessionId);
  }
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  // Returning to Agents with the Topic already visible in the side pane opens
  // it while unread and jumps directly to the start of the follow-up turn.
  await expect(topicRow.locator(".agent-unread")).toHaveCount(0);
  await expectAlignedAtStartOfRun(topicPanel, topicReply.id);
  await page.waitForTimeout(550);
  await expectAlignedAtStartOfRun(topicPanel, topicReply.id);

  // 5. Already-read Topic preserves manual reading position and bottom scroll.
  const topicScroll = topicPanel.locator(".chat-scroll");
  const savedTop = await topicScroll.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    node.scrollTop += 400;
    return node.scrollTop;
  });
  await nav.getByRole("button", { name: "工作", exact: true }).click();
  await expect(topicPanel).toHaveAttribute("data-visible", "false");
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await expect
    .poll(() =>
      topicScroll.evaluate(
        (node, target) => Math.abs(node.scrollTop - target),
        savedTop,
      ),
    )
    .toBeLessThan(8);

  await topicPanel
    .getByRole("button", { name: "回到最新消息", exact: true })
    .click();
  await expect
    .poll(() =>
      topicScroll.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await nav.getByRole("button", { name: "工作", exact: true }).click();
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await expect
    .poll(() =>
      topicScroll.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);

  // 6. Expanding an unread Topic inline inside Chat also lands at its start.
  const inlineTopic = await postAndWait(chatA.id, "topic", "内联未读长话题");
  await chatARow.click();
  const latestBtn = chatAPanel.getByRole("button", {
    name: "回到最新消息",
    exact: true,
  });
  if (await latestBtn.isVisible()) await latestBtn.click();
  const inlineCard = chatAPanel.locator(
    `.topic-thread[data-session-id="${inlineTopic.sessionId}"]`,
  );
  await expect(inlineCard).toBeVisible();
  await inlineCard.locator(".topic-expand").click();
  await expectAlignedAtStartOfRun(chatAPanel, inlineTopic.id);
});

test("opening an unread conversation with a short reply keeps the bottom naturally visible", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { url, scope } = fixtureContext();
  await page.setViewportSize({ width: 1360, height: 760 });
  await page.goto(url);

  const agentResponse = await page.request.post("/api/agents", {
    data: {
      name: "短回复未读定位",
      profile: {
        provider: "codex",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
        permission: "ask",
        instructions: "简短回复即可。",
        skills: [],
        delegations: [],
      },
    },
  });
  expect(agentResponse.ok()).toBe(true);
  const agent = (await agentResponse.json()) as Agent;

  const createChat = async (title: string) => {
    const res = await page.request.post("/api/chats", {
      data: { agentId: agent.id, title },
    });
    expect(res.ok()).toBe(true);
    return (await res.json()) as { id: string };
  };
  const chatA = await createChat("短回复会话 A");
  const chatB = await createChat("短回复中转 B");

  const postAndWait = async (chatId: string, text: string): Promise<Run> => {
    const res = await page.request.post("/api/messages", {
      data: {
        chatId,
        commandId: randomUUID(),
        operation: "main",
        text,
      },
    });
    expect(res.ok()).toBe(true);
    const run = (await res.json()) as Run;
    return waitRunCompleted(page, run.sessionId, run.id);
  };

  // Seed enough earlier messages so the chat scrolls, then read them.
  const filler = Array.from({ length: 10 }, (_, i) => `历史段落 ${i + 1}`).join(
    "\n\n",
  );
  let lastRead!: Run;
  for (let i = 1; i <= 4; i++) {
    lastRead = await postAndWait(chatA.id, `历史消息 ${i}\n\n${filler}`);
  }
  const chatBRun = await postAndWait(chatB.id, "中转消息");

  await page.reload();
  const sidebar = page.locator("#agent-sidebar");
  const agentGroup = sidebar.locator(`[data-agent-id="${agent.id}"]`);
  await expect(agentGroup).toBeVisible();
  if ((await agentGroup.getAttribute("aria-expanded")) === "false") {
    await agentGroup.getByRole("button").first().click();
  }
  const chatARow = sidebar.locator(`[data-session-id="${lastRead.sessionId}"]`);
  const chatBRow = sidebar.locator(`[data-session-id="${chatBRun.sessionId}"]`);
  await chatARow.click();
  const chatAPanel = page.locator(`#panel-${chatA.id}`);
  await expect(chatARow.locator(".agent-unread")).toHaveCount(0);

  await chatBRow.click();
  const shortUnread = await postAndWait(chatA.id, "收到一条简短未读消息");
  await expect(chatARow.locator(".agent-unread")).toBeVisible();

  await chatARow.click();
  await expect(chatARow.locator(".agent-unread")).toHaveCount(0);
  const unreadItem = chatAPanel.locator(`[data-run-id="${shortUnread.id}"]`);
  await expect(unreadItem).toBeVisible();
  // Short unread reply clamps cleanly to the bottom of the conversation.
  await expect
    .poll(() =>
      chatAPanel
        .locator(".chat-scroll")
        .evaluate(
          (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
        ),
    )
    .toBeLessThanOrEqual(2);
  await expect(
    chatAPanel.getByRole("button", { name: "回到最新消息", exact: true }),
  ).toHaveCount(0);
});
