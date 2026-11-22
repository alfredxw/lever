import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Overview, Run } from "../src/api/types.gen";

function context() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    scope: string;
    otherScope: string;
  };
}

async function createAgent(page: Page, name: string, scope: string) {
  await page.goto(context().url);
  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await dialog.getByRole("textbox", { name: "工作范围目录" }).fill(scope);
  await dialog.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择模型和运行时", exact: true }),
  ).toContainText("GPT Test");
}

async function fetchOverview(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/overview", { credentials: "same-origin" });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as Overview;
  });
}

async function sendRun(
  page: Page,
  body: Record<string, unknown>,
): Promise<Run> {
  return page.evaluate(async (payload) => {
    const res = await fetch("/api/messages", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as Run;
  }, body);
}

async function approveRun(page: Page, runId: string) {
  await expect
    .poll(async () => {
      const overview = await fetchOverview(page);
      return overview.requests.find(
        (req) => req.runId === runId && req.status === "pending",
      )?.id;
    })
    .toBeTruthy();
  const overview = await fetchOverview(page);
  const req = overview.requests.find(
    (item) => item.runId === runId && item.status === "pending",
  )!;
  await page.evaluate(async (id) => {
    const res = await fetch(`/api/requests/${id}/answer`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: true }),
    });
    if (!res.ok) throw new Error(await res.text());
  }, req.id);
}

async function stopRun(page: Page, runId: string) {
  await page.evaluate(async (id) => {
    const res = await fetch(`/api/runs/${id}/stop`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(await res.text());
  }, runId);
}

test("/after hides when idle, preselects same-directory running tasks via + and /, waits for all to succeed, and blocks on failure", async ({
  page,
}) => {
  const { scope, otherScope } = context();
  await createAgent(page, "Repo Worker", scope);
  const composer = page.locator(".chat-composer-wrap");

  // Idle state: no persistent wait button in composer toolbar, and /after not shown in + menu.
  await expect(
    composer.getByRole("button", { name: "等待任务完成", exact: true }),
  ).toHaveCount(0);
  await composer
    .getByRole("button", { name: "添加附件、命令或引用", exact: true })
    .click();
  await expect(page.getByRole("option", { name: /\/after/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Create a second agent in another directory.
  await createAgent(page, "Other Repo Worker", otherScope);

  const overview0 = await fetchOverview(page);
  const repoAgent = overview0.agents.find((a) => a.name === "Repo Worker")!;
  const otherAgent = overview0.agents.find(
    (a) => a.name === "Other Repo Worker",
  )!;

  // Start two parallel Topics in Repo Worker's scope and one in Other Repo Worker's scope.
  const taskA = await sendRun(page, {
    commandId: crypto.randomUUID(),
    agentId: repoAgent.id,
    operation: "topic",
    text: "Fix auth [approval]",
  });
  const taskB = await sendRun(page, {
    commandId: crypto.randomUUID(),
    chatId: taskA.chatId,
    operation: "topic",
    text: "Add unit tests [approval]",
  });
  const taskOther = await sendRun(page, {
    commandId: crypto.randomUUID(),
    agentId: otherAgent.id,
    operation: "topic",
    text: "Other repo work [approval]",
  });

  // Wait for all three runs to enter waiting_user.
  await expect
    .poll(async () => {
      const ov = await fetchOverview(page);
      return [taskA.id, taskB.id, taskOther.id].every(
        (id) => ov.runs.find((r) => r.id === id)?.status === "waiting_user",
      );
    })
    .toBe(true);

  // Switch to Repo Worker's chat containing Task A and Task B.
  await page
    .getByRole("button", { name: "Fix auth [approval]" })
    .first()
    .click();
  await page.getByRole("button", { name: "定位原消息", exact: true }).click();
  await expect(page.locator(".topic-thread")).toHaveCount(2);

  // Trigger /after from the + action menu.
  await composer
    .getByRole("button", { name: "添加附件、命令或引用", exact: true })
    .click();
  await page.getByRole("option", { name: /\/after/ }).click();

  // Only the two same-directory tasks are preselected by default.
  const picker = composer.getByRole("group", {
    name: "等待任务完成",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("Fix auth");
  await expect(picker).toContainText("Add unit tests");
  await expect(picker).not.toContainText("Other repo work");

  // Verify the + Add tasks popover splits "当前目录" and "其他运行中任务".
  await picker.getByRole("button", { name: "添加任务", exact: true }).click();
  const popover = page.getByRole("dialog", {
    name: "选择要等待的任务",
    exact: true,
  });
  await expect(popover).toContainText("当前目录");
  await expect(popover).toContainText("其他运行中任务");
  await expect(
    popover.getByRole("checkbox", { name: /Fix auth/ }),
  ).toBeChecked();
  await expect(
    popover.getByRole("checkbox", { name: /Add unit tests/ }),
  ).toBeChecked();
  await expect(
    popover.getByRole("checkbox", { name: /Other repo work/ }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");

  // Cancel via active icon button, then re-activate via typing /after command!
  await composer
    .getByRole("button", { name: "等待任务完成", exact: true })
    .click();
  await expect(picker).toHaveCount(0);

  const textbox = composer.getByRole("textbox", { name: "发送消息" });
  await textbox.click();
  await textbox.pressSequentially("/after");
  await page.getByRole("option", { name: /\/after/ }).click();
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("Fix auth");
  await expect(picker).toContainText("Add unit tests");

  // Type commit & push prompt and submit.
  await textbox.pressSequentially("commit and push");
  await composer
    .getByRole("button", { name: "等 2 个任务成功后发送", exact: true })
    .click();

  // Composer returns to clean idle state (no persistent wait button).
  await expect(picker).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: "等待任务完成", exact: true }),
  ).toHaveCount(0);

  // Waiting Topic card appears in the Chat timeline showing 0 / 2.
  const waitingTopic = page.locator(".topic-thread", {
    hasText: "commit and push",
  });
  await expect(waitingTopic).toBeVisible();
  await expect(waitingTopic).toContainText("等待 0 / 2 个任务执行成功");

  // Approve Task A -> waiting card updates to 1 / 2 and remains queued.
  await approveRun(page, taskA.id);
  await expect(waitingTopic).toContainText("等待 1 / 2 个任务执行成功");
  await expect(waitingTopic).toHaveAttribute("data-status", "queued");

  // Approve Task B -> waiting card automatically starts and completes!
  await approveRun(page, taskB.id);
  await expect(waitingTopic).toHaveAttribute("data-status", "completed", {
    timeout: 15_000,
  });

  // Now verify fail-closed + "忽略失败并运行".
  const taskC = await sendRun(page, {
    commandId: crypto.randomUUID(),
    chatId: taskA.chatId,
    operation: "topic",
    text: "Risky refactor [approval]",
  });
  await expect
    .poll(async () => {
      const ov = await fetchOverview(page);
      return ov.runs.find((r) => r.id === taskC.id)?.status;
    })
    .toBe("waiting_user");

  await textbox.click();
  await textbox.pressSequentially("/after");
  await page.getByRole("option", { name: /\/after/ }).click();
  await expect(picker).toContainText("Risky refactor");
  await textbox.pressSequentially("push risky refactor");
  await composer
    .getByRole("button", { name: "等 1 个任务成功后发送", exact: true })
    .click();

  const blockedTopic = page.locator(".topic-thread", {
    hasText: "push risky refactor",
  });
  await expect(blockedTopic).toContainText("等待 0 / 1 个任务执行成功");

  // Stop Task C -> blockedTopic must stay queued and show fail-closed alert + "忽略失败并运行".
  await stopRun(page, taskC.id);
  await expect(blockedTopic).toContainText("已停止自动启动");
  await expect(blockedTopic).toHaveAttribute("data-status", "queued");

  await blockedTopic
    .getByRole("button", { name: "忽略失败并运行", exact: true })
    .click();
  await expect(blockedTopic).toHaveAttribute("data-status", "completed", {
    timeout: 15_000,
  });

  // Clean up other-repo run.
  await approveRun(page, taskOther.id);
});
