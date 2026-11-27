import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Agent, Automation } from "../src/api/types.gen";

function testFixture() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

test("agent creation omits runtime config, composer persists latest selection, automations lock preselected model, and profile manages cross-provider permission policy", async ({
  page,
}) => {
  const { url, scope } = testFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  // Seed a base Agent via API so we can switch its model in Composer first.
  const seedRes = await page.request.post("/api/agents", {
    data: {
      name: "Selection Seed Agent",
      profile: {
        provider: "codex",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(seedRes.ok()).toBeTruthy();
  const seedAgent: Agent = await seedRes.json();
  expect(seedAgent.profile.permission).toBe("");

  await page.reload();

  // 1. Open seed Agent and switch model + effort in Composer; verify backend persistence.
  await page
    .getByRole("button", { name: seedAgent.name, exact: true })
    .first()
    .click();
  const composer = page.locator(".chat-composer-wrap:visible");
  const modelTrigger = composer.getByRole("button", { name: "选择模型和运行时" });
  await expect(modelTrigger).toBeVisible();

  await modelTrigger.click();
  const modelPopover = page.getByRole("dialog", { name: "选择模型和运行时" });
  await expect(modelPopover).toBeVisible();
  await modelPopover
    .getByRole("toolbar", { name: "模型" })
    .getByRole("button", { name: "GPT Review", exact: true })
    .click();
  const selectionSaved = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/agents/${seedAgent.id}/selection`) &&
      res.request().method() === "PUT" &&
      res.request().postDataJSON()?.effort === "high",
  );
  await modelPopover
    .getByRole("radiogroup", { name: "推理强度" })
    .getByRole("radio", { name: "高", exact: true })
    .click();
  const persistedAgent: Agent = await (await selectionSaved).json();
  expect(persistedAgent.profile.provider).toBe("codex");
  expect(persistedAgent.profile.model).toBe("gpt-review");
  expect(persistedAgent.profile.effort).toBe("high");

  // 2. Create a new Agent via UI: no runtime/model/permission fields shown; auto-inherits latest selection.
  await page.getByRole("button", { name: "创建 Agent", exact: true }).first().click();
  const createDialog = page.getByRole("dialog", { name: "创建 Agent", exact: true });
  await expect(createDialog).toBeVisible();
  await expect(
    createDialog.getByRole("combobox", { name: "运行时" }),
  ).toHaveCount(0);
  await expect(
    createDialog.getByRole("button", { name: "模型", exact: true }),
  ).toHaveCount(0);

  await createDialog.getByLabel("名称", { exact: true }).fill("Streamlined Agent");
  const creating = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/agents") && res.request().method() === "POST",
  );
  await createDialog
    .getByRole("button", { name: "创建 Agent", exact: true })
    .click();
  const createdAgent: Agent = await (await creating).json();
  expect(createdAgent.profile.provider).toBe("codex");
  expect(createdAgent.profile.model).toBe("gpt-review");
  expect(createdAgent.profile.effort).toBe("high");
  expect(createdAgent.profile.permission).toBe("");
  await expect(createDialog).toBeHidden();

  // 3. Automation editor pre-selects the Agent's latest model and LOCKS it on Create without touching ModelPicker.
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "自动化", exact: true }).click();
  const planSidebar = page.locator("#automation-sidebar");
  await planSidebar.getByRole("button", { name: "新建自动化" }).click();
  const autoDialog = page.getByRole("dialog", { name: "新建自动化" });
  await autoDialog.getByLabel("名称", { exact: true }).fill("Locked Latest Model Plan");
  await autoDialog.getByLabel("执行指令", { exact: true }).fill("Run daily check");

  const ownerChip = autoDialog.getByRole("button", {
    name: createdAgent.name,
    exact: true,
  });
  if (await ownerChip.count()) {
    for (const selected of await autoDialog
      .locator('.automation-owner-chip[aria-pressed="true"]')
      .all()) {
      if ((await selected.getAttribute("aria-label")) !== createdAgent.name) {
        await selected.click();
      }
    }
    if ((await ownerChip.getAttribute("aria-pressed")) !== "true") {
      await ownerChip.click();
    }
  } else {
    await autoDialog
      .getByRole("button", { name: "归属 Agent", exact: true })
      .click();
    await page.getByRole("option", { name: createdAgent.name, exact: true }).click();
  }

  await expect(
    autoDialog.getByRole("button", { name: "选择模型和运行时" }),
  ).toContainText("GPT Review");

  const createAuto = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/tasks/automations") &&
      res.request().method() === "POST",
  );
  await autoDialog.getByRole("button", { name: "创建", exact: true }).click();
  const lockedPlan: Automation = await (await createAuto).json();
  expect(lockedPlan.selection?.provider).toBe("codex");
  expect(lockedPlan.selection?.model).toBe("gpt-review");
  expect(lockedPlan.selection?.effort).toBe("high");
  expect(lockedPlan.selection?.permission).toBeTruthy();
  await expect(autoDialog).toBeHidden();

  // 4. Switching the Agent's latest selection later does NOT mutate the locked automation,
  //    and shows the sync button in Automation settings.
  const switchRes = await page.request.put(
    `/api/agents/${createdAgent.id}/selection`,
    {
      data: {
        provider: "claude",
        model: "default",
        effort: "medium",
        fast: false,
      },
    },
  );
  expect(switchRes.ok()).toBeTruthy();
  await page.reload();
  await nav.getByRole("button", { name: "自动化", exact: true }).click();
  await planSidebar.getByTitle(lockedPlan.name).click();
  const detail = page.getByRole("article");
  await detail.getByRole("tab", { name: "规则配置" }).click();
  await expect(
    detail.getByRole("button", { name: "选择模型和运行时" }),
  ).toContainText("GPT Review");
  await expect(
    detail.getByRole("button", { name: "同步为 Agent 当前模型与权限" }),
  ).toBeVisible();

  // 4b. Work page task dispatch panel pre-selects the Agent's NEW latest model (Claude).
  const wiRes = await page.request.post("/api/tasks/work-items", {
    data: {
      title: "Verify Latest Model Dispatch",
      assigneeAgentId: createdAgent.id,
    },
  });
  expect(wiRes.ok()).toBeTruthy();
  await nav.getByRole("button", { name: "工作", exact: true }).click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByText("Verify Latest Model Dispatch").first().click();
  await page
    .getByRole("button", { name: "交给 Agent", exact: true })
    .last()
    .click();
  const dispatchForm = page.getByRole("form", { name: "交给 Agent" });
  await expect(dispatchForm).toBeVisible();
  await expect(
    dispatchForm.getByRole("button", { name: "选择模型和运行时" }),
  ).toContainText(/Claude|Sonnet|Opus|default/i);

  // 5. Profile edit page exposes cross-provider permission ToggleGroup (no static provider/model form).
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByRole("button", { name: createdAgent.name, exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "更多工具", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置", exact: true }).click();
  const profile = page.locator('[id="panel-profile"]');
  await expect(profile).toBeVisible();
  await expect(profile.getByRole("combobox", { name: "运行时" })).toHaveCount(0);
  const permGroup = profile.getByRole("radiogroup", {
    name: "权限",
    exact: true,
  });
  await expect(permGroup).toBeVisible();
  await expect(
    permGroup.getByRole("radio", { name: "跟随全局", exact: true }),
  ).toBeChecked();

  const savingPerm = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/agents/${createdAgent.id}`) &&
      res.request().method() === "PUT",
  );
  await permGroup.getByRole("radio", { name: "只读", exact: true }).click();
  const savedPermAgent: Agent = await (await savingPerm).json();
  expect(savedPermAgent.profile.permission).toBe("read_only");
});
