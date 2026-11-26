import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { Agent, DelegationSettings } from "../src/api/types.gen";

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

test("Agent delegation policy defaults to off, supports global default and per-Agent all/selected modes without default confirmation", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { url, scope } = context();
  await page.goto(url);

  const createViaAPI = async (
    name: string,
    extra: Partial<Agent["profile"]> = {},
  ): Promise<Agent> => {
    const res = await page.request.post("/api/agents", {
      data: {
        name,
        profile: {
          provider: "codex",
          model: "",
          permission: "ask",
          instructions: "",
          roots: [{ id: "root", path: scope }],
          primaryRootId: "root",
          skills: [],
          delegations: [],
          ...extra,
        },
      },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as Agent;
  };

  try {
    const lead = await createViaAPI("委派主控测试");
    const helper = await createViaAPI("委派助手测试", {
      description: "负责排查与验证",
    });

    await page.reload();
    const sidebar = page.locator("#agent-sidebar");
    await sidebar
      .getByRole("button", { name: `打开 ${lead.name} 的配置` })
      .click();

    const policyGroup = page.getByRole("radiogroup", { name: "委派模式" });
    // 1. Newly created Agent defaults to 关闭 (none).
    await expect(
      policyGroup.getByRole("radio", { name: "关闭", exact: true }),
    ).toBeChecked();

    // 2. Switching to 仅选定 Agent and checking a collaborator defaults confirm to OFF (unchecked).
    await policyGroup.getByRole("radio", { name: "仅选定 Agent" }).click();
    const helperCheckbox = page.getByRole("checkbox", { name: helper.name });
    await expect(helperCheckbox).toBeVisible();
    await helperCheckbox.click();
    await expect(helperCheckbox).toBeChecked();

    const confirmSwitch = page
      .locator(".profile-delegation", { hasText: helper.name })
      .getByRole("switch");
    await expect(confirmSwitch).toBeVisible();
    await expect(confirmSwitch).not.toBeChecked();

    // 3. Switching to 全部 Agent（含新增）automatically includes newly created Agents and respects acceptDelegations.
    await policyGroup
      .getByRole("radio", { name: "全部 Agent（含新增）" })
      .click();
    const profileForm = page.locator(".profile-form");
    await expect(
      profileForm.getByText(helper.name, { exact: true }),
    ).toBeVisible();

    const late = await createViaAPI("后建协作测试");
    await expect(
      profileForm.getByText(late.name, { exact: true }),
    ).toBeVisible();

    // Disable acceptDelegations on helper -> removed from lead's eligible chips.
    await sidebar
      .getByRole("button", { name: `打开 ${helper.name} 的配置` })
      .click();
    const acceptSwitch = page.getByRole("switch", {
      name: "允许被其他 Agent 委派",
    });
    await expect(acceptSwitch).toBeChecked();
    const savedHelper = page.waitForResponse(
      (resp) =>
        resp.url().endsWith(`/api/agents/${helper.id}`) &&
        resp.request().method() === "PUT",
    );
    await acceptSwitch.click();
    await expect(acceptSwitch).not.toBeChecked();
    expect((await savedHelper).ok()).toBeTruthy();

    await sidebar
      .getByRole("button", { name: `打开 ${lead.name} 的配置` })
      .click();
    await expect(
      profileForm.getByText(late.name, { exact: true }),
    ).toBeVisible();
    await expect(
      profileForm.getByText(helper.name, { exact: true }),
    ).toHaveCount(0);

    // 4. Global setting: 新建 Agent 默认委派协作 -> 全部 Agent（含新增）applies to unconfigured Agents.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const globalPolicy = page.getByRole("radiogroup", {
      name: "新建 Agent 默认委派协作",
    });
    await expect(
      globalPolicy.getByRole("radio", { name: "默认关闭" }),
    ).toBeChecked();
    const savedSettings = page.waitForResponse(
      (resp) =>
        resp.url().endsWith("/api/settings/delegation") &&
        resp.request().method() === "PUT",
    );
    await globalPolicy
      .getByRole("radio", { name: "全部 Agent（含新增）" })
      .click();
    const settingsResp = await savedSettings;
    expect(settingsResp.ok()).toBeTruthy();
    const savedBody = (await settingsResp.json()) as DelegationSettings;
    expect(savedBody.defaultPolicy).toBe("all");
  } finally {
    await page.request.put("/api/settings/delegation", {
      data: { defaultPolicy: "none" },
    });
  }
});
