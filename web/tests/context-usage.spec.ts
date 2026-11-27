import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Agent, Run } from "../src/api/types.gen";

function testFixture() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

async function waitRunCompleted(request: APIRequestContext, runId: string) {
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/runs/${runId}`);
        expect(res.ok()).toBeTruthy();
        const run: Run = await res.json();
        return run.status;
      },
      { timeout: 15_000 },
    )
    .toBe("completed");
}

test("context meter is off by default, renders simplified usage when reported, and hides when unavailable", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { url, scope } = testFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  // Seed a Claude Agent and complete a Topic turn so session.runtime.context is populated.
  const claudeAgentRes = await page.request.post("/api/agents", {
    data: {
      name: "Context Claude Agent",
      profile: {
        provider: "claude",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(claudeAgentRes.ok()).toBeTruthy();
  const claudeAgent: Agent = await claudeAgentRes.json();

  const claudeTurnRes = await page.request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      agentId: claudeAgent.id,
      operation: "topic",
      text: "/goal finish",
    },
  });
  expect(claudeTurnRes.ok()).toBeTruthy();
  const claudeRun: Run = await claudeTurnRes.json();
  await waitRunCompleted(page.request, claudeRun.id);

  // Seed a Codex Agent and complete a Topic turn that populates context usage.
  const codexAgentRes = await page.request.post("/api/agents", {
    data: {
      name: "Context Codex Agent",
      profile: {
        provider: "codex",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(codexAgentRes.ok()).toBeTruthy();
  const codexAgent: Agent = await codexAgentRes.json();

  const codexTurnRes = await page.request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      agentId: codexAgent.id,
      operation: "topic",
      text: "/goal verify result",
    },
  });
  expect(codexTurnRes.ok()).toBeTruthy();
  const codexRun: Run = await codexTurnRes.json();
  await waitRunCompleted(page.request, codexRun.id);

  await page.reload();

  // 1. Open Claude Agent and its Topic; verify context meter is hidden by default.
  await page
    .getByRole("button", { name: claudeAgent.name, exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "回复", exact: true }).first().click();

  const topicComposer = page.locator(".topic-composer-wrap:visible");
  await expect(topicComposer).toBeVisible();
  await expect(
    topicComposer.getByRole("button", { name: /上下文窗口/ }),
  ).toHaveCount(0);

  // 2. Enable "显示上下文用量" in Settings -> General -> Conversation.
  await page.getByRole("button", { name: "设置" }).click();
  const contextSwitch = page.getByRole("switch", { name: "显示上下文用量" });
  await expect(contextSwitch).toBeVisible();
  await expect(contextSwitch).not.toBeChecked();
  await contextSwitch.click();
  await expect(contextSwitch).toBeChecked();

  // 3. Return to Agents -> Claude Topic; verify simplified context ring and read-only popover.
  await page.getByRole("button", { name: "Agents" }).click();
  const claudeMeter = topicComposer.getByRole("button", {
    name: /上下文窗口 20%/,
  });
  await expect(claudeMeter).toBeVisible();
  await expect(claudeMeter).toHaveText("");
  await claudeMeter.click();

  const popover = page.getByRole("dialog").last();
  await expect(popover).toBeVisible();
  await expect(
    popover.getByRole("progressbar", { name: "上下文窗口" }),
  ).toBeVisible();
  await expect(popover.getByText("20%")).toBeVisible();
  await expect(popover.getByText("2,000 / 10,000 tokens")).toBeVisible();
  await expect(popover.getByRole("button")).toHaveCount(0);
  await expect(popover.getByRole("textbox")).toHaveCount(0);

  // 4. Switch to Codex Topic; verify meter renders and disappears cleanly when usage is cleared.
  await page
    .getByRole("button", { name: codexAgent.name, exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "回复", exact: true }).first().click();

  const codexMeter = page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: /上下文窗口 7%/ });
  await expect(codexMeter).toBeVisible();
  await codexMeter.click();

  const codexPopover = page.getByRole("dialog").last();
  await expect(codexPopover.getByText("710 / 10,000 tokens")).toBeVisible();
  await expect(codexPopover.getByRole("button")).toHaveCount(0);

  // Compact Codex session via /compact; context usage clears and the indicator hides (no dashed placeholder).
  const compactRes = await page.request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      chatId: codexRun.chatId,
      sessionId: codexRun.sessionId,
      operation: "reply",
      text: "/compact",
    },
  });
  expect(compactRes.ok()).toBeTruthy();
  const compactRun: Run = await compactRes.json();
  await waitRunCompleted(page.request, compactRun.id);

  await expect(
    page
      .locator(".topic-composer-wrap:visible")
      .getByRole("button", { name: /上下文窗口/ }),
  ).toHaveCount(0);
});
