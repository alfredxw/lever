import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Agent, Automation } from "../src/api/types.gen";

function taskFixture() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

test("automations support model and task-level permission overrides with ask-mode warnings", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const createdAgent = await page.request.post("/api/agents", {
    data: {
      name: "Ask Automation Agent",
      profile: {
        provider: "codex",
        permission: "ask",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(createdAgent.ok()).toBeTruthy();
  const agent: Agent = await createdAgent.json();

  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "自动化", exact: true }).click();
  const planSidebar = page.locator("#automation-sidebar");

  // 1. In Create dialog, selecting an ask-mode Agent immediately warns and lets the user switch permission + model.
  await planSidebar.getByRole("button", { name: "新建自动化" }).click();
  const dialog = page.getByRole("dialog", { name: "新建自动化" });
  await dialog.getByLabel("名称", { exact: true }).fill("Ask override plan");
  await dialog.getByLabel("执行指令", { exact: true }).fill("Daily audit");

  const ownerChip = dialog.getByRole("button", {
    name: agent.name,
    exact: true,
  });
  if (await ownerChip.count()) {
    for (const selected of await dialog
      .locator('.automation-owner-chip[aria-pressed="true"]')
      .all()) {
      if ((await selected.getAttribute("aria-label")) !== agent.name) {
        await selected.click();
      }
    }
    if ((await ownerChip.getAttribute("aria-pressed")) !== "true") {
      await ownerChip.click();
    }
  } else {
    await dialog.getByRole("button", { name: "归属 Agent", exact: true }).click();
    await page.getByRole("option", { name: agent.name, exact: true }).click();
  }

  const dialogWarning = dialog.locator(".automation-ask-warning");
  await expect(dialogWarning).toBeVisible();
  const switchBtn = dialogWarning.locator(".automation-ask-switch-btn");
  await expect(switchBtn).toBeVisible();
  await switchBtn.click();
  await expect(dialogWarning).toBeHidden();

  // Switch model and reasoning effort via ModelPicker inside the automation editor.
  const modelTrigger = dialog.getByRole("button", { name: "选择模型和运行时" });
  await modelTrigger.click();
  const modelPopover = page.getByRole("dialog", { name: "选择模型和运行时" });
  await expect(modelPopover).toBeVisible();
  const modelOption = modelPopover
    .getByRole("toolbar", { name: "模型" })
    .getByRole("button", { name: "GPT Review", exact: true });
  await expect(modelOption).toBeVisible();
  await modelOption.click();
  await modelPopover
    .getByRole("radiogroup", { name: "推理强度" })
    .getByRole("radio", { name: "高", exact: true })
    .click();
  await expect(modelPopover).toBeHidden();

  const saving = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/tasks/automations") &&
      res.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  const created: Automation = await (await saving).json();
  expect(created.selection?.permission).toBeTruthy();
  expect(created.selection?.permission).not.toBe("ask");
  expect(created.selection?.model).toBe("gpt-review");
  expect(created.selection?.effort).toBe("high");
  await expect(dialog).toBeHidden();

  // 2. An existing automation inheriting an ask-mode Agent warns even when inline config is collapsed,
  //    and supports 1-click task-level switching right in the ribbon.
  const askRes = await page.request.post("/api/tasks/automations", {
    data: {
      name: "Inherited ask plan",
      prompt: "Check repo",
      trigger: { kind: "schedule", schedule: { intervalMinutes: 1440 } },
      destination: { mode: "topic", agentId: agent.id },
      workItem: false,
    },
  });
  expect(askRes.ok()).toBeTruthy();
  const askPlan: Automation = await askRes.json();

  await planSidebar.getByTitle(askPlan.name).click();
  const detail = page.getByRole("article");
  await expect(detail.getByRole("heading", { name: askPlan.name })).toBeVisible();

  const ribbonWarning = detail.locator(".automation-ask-warning");
  await expect(ribbonWarning).toBeVisible();

  const quickUpdate = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/tasks/automations/${askPlan.id}`) &&
      res.request().method() === "PUT",
  );
  await ribbonWarning.locator(".automation-ask-switch-btn").click();
  const updated: Automation = await (await quickUpdate).json();
  expect(updated.selection?.permission).toBeTruthy();
  expect(updated.selection?.permission).not.toBe("ask");
  await expect(ribbonWarning).toBeHidden();

  // 3. Switching to the Settings tab exposes flat single-layer config with unified PermissionMenu and ModelPicker.
  await detail.getByRole("tab", { name: "规则配置" }).click();
  const permTrigger = detail.locator("#automation-config-permission");
  await expect(permTrigger).toBeVisible();
  await permTrigger.click();
  const fullAccessItem = page.getByRole("menuitemradio", { name: /完全访问/ });
  await expect(fullAccessItem).toBeVisible();
  const permSave = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/tasks/automations/${askPlan.id}`) &&
      res.request().method() === "PUT",
  );
  await fullAccessItem.click();
  const withFullAccess: Automation = await (await permSave).json();
  expect(withFullAccess.selection?.permission).toBe("full_access");
});
