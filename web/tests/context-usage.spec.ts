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

test("context meter is off by default, toggles in Settings, supports Claude/Codex compact and fresh-topic handoff", async ({
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

  // 3. Return to Agents -> Claude Topic; verify context ring + Claude popover controls.
  await page.getByRole("button", { name: "Agents" }).click();
  const claudeMeter = topicComposer.getByRole("button", {
    name: /上下文窗口 \d+%/,
  });
  await expect(claudeMeter).toBeVisible();
  await expect(claudeMeter).toHaveText("");
  await claudeMeter.click();

  const popover = page.getByRole("dialog").last();
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("progressbar", { name: "上下文窗口" })).toBeVisible();
  await expect(popover.getByLabel("压缩保留重点（可选）")).toBeVisible();
  await expect(
    popover.getByRole("button", { name: "压缩", exact: true }),
  ).toBeVisible();
  await expect(popover.getByLabel("转入新话题的下一步目标")).toBeVisible();

  // 4. Trigger Fresh-Topic Handoff from the popover and verify lineage back-link.
  await popover
    .getByLabel("转入新话题的下一步目标")
    .fill("continue work in a fresh topic");
  const handoffPost = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/messages") &&
      res.request().method() === "POST" &&
      res.request().postDataJSON()?.handoffFromSessionId === claudeRun.sessionId,
  );
  await popover.getByRole("button", { name: "新话题", exact: true }).click();
  const handoffRun: Run = await (await handoffPost).json();
  expect(handoffRun.sessionId).not.toBe(claudeRun.sessionId);
  await waitRunCompleted(page.request, handoffRun.id);

  // Fresh Topic should open with a clickable "承接自 ..." back-link and no runtime-switch notice.
  const backToSource = page
    .locator(".topic-toolbar:visible")
    .getByRole("button", { name: /^承接自 / });
  await expect(backToSource).toBeVisible();
  await expect(page.locator(".runtime-handoff:visible")).toHaveCount(0);

  // 5. Switch to Codex Topic and verify arg-less compact button + post-compact state.
  await page
    .getByRole("button", { name: codexAgent.name, exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "回复", exact: true }).first().click();

  const codexMeter = page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: /上下文窗口 \d+%/ });
  await expect(codexMeter).toBeVisible();
  await codexMeter.click();

  const codexPopover = page.getByRole("dialog").last();
  await expect(codexPopover.getByLabel("压缩保留重点（可选）")).toHaveCount(0);
  const compactButton = codexPopover.getByRole("button", {
    name: "压缩当前会话",
    exact: true,
  });
  await expect(compactButton).toBeVisible();

  const compactPost = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/messages") &&
      res.request().method() === "POST" &&
      res.request().postDataJSON()?.text === "/compact",
  );
  await compactButton.click();
  const compactRun: Run = await (await compactPost).json();
  await waitRunCompleted(page.request, compactRun.id);

  // After Codex compacts, context usage clears until the next reply; meter still opens cleanly.
  const compactedMeter = page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "上下文窗口" });
  await expect(compactedMeter).toBeVisible();
  await compactedMeter.click();
  await expect(
    page.getByText("已压缩，下一轮回复后更新用量"),
  ).toBeVisible();
});
