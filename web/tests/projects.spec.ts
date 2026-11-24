import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Agent, Overview } from "../src/api/types.gen";

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

async function createAgent(
  page: Page,
  name: string,
  options: { scope?: string; projectName?: string },
) {
  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  if (options.projectName) {
    await dialog.getByRole("combobox", { name: "共享项目", exact: true }).click();
    await page
      .getByRole("option", { name: options.projectName, exact: true })
      .click();
  } else if (options.scope) {
    await dialog
      .getByRole("textbox", { name: "工作范围目录" })
      .fill(options.scope);
  }
  await dialog.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toBeVisible();
}

test("Shared Project scope is managed inside Agent Profile without Projects tab or Composer switcher", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const temp = mkdtempSync(join(dirname(context().scope), "projects-e2e-"));
  const repoCore = join(temp, "lever-core");
  const repoMobile = join(temp, "lever-mobile");
  for (const dir of [repoCore, repoMobile]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(repoCore, "README.md"), "# Lever Core\n");
  writeFileSync(join(repoMobile, "APP.md"), "# Lever Mobile\n");
  for (const repo of [repoCore, repoMobile]) {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Initial",
      ],
      { cwd: repo },
    );
  }

  await page.goto(context().url);
  const sidebar = page.locator("#agent-sidebar");

  // 1. Sidebar stays clean: All | Recent | Archived, with NO Projects tab.
  await expect(
    sidebar.getByRole("tab", { name: "全部", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("tab", { name: "最近", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("tab", { name: "已归档", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("tab", { name: "项目", exact: true }),
  ).toHaveCount(0);

  // 2. Create first Agent and save its scope as a reusable shared Project inside Profile.
  await createAgent(page, "Claude 主控", { scope: repoCore });
  await sidebar
    .getByRole("button", { name: "打开 Claude 主控 的配置", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent 配置", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "存为共享项目", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "新建共享项目", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(
    "lever-core",
  );
  await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  await expect(
    page.getByRole("combobox", { name: "共享项目", exact: true }),
  ).toContainText("lever-core");

  // Create a shared worktree directory group under the project pool inside Profile.
  const scopeTabs = page.getByRole("tablist", { name: "工作范围", exact: true });
  await scopeTabs.getByRole("tab", { name: "目录组", exact: true }).click();
  const groupsPanel = page.getByRole("tabpanel", {
    name: "目录组",
    exact: true,
  });
  await groupsPanel
    .getByRole("button", { name: "新建目录组", exact: true })
    .click();
  await groupsPanel
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("feat-shared");
  await groupsPanel
    .getByRole("combobox", { name: "lever-core 的工作目录" })
    .click();
  await page.getByRole("option", { name: "新建 worktree", exact: true }).click();
  await groupsPanel
    .getByRole("button", { name: "创建 1 个 worktree 并保存组" })
    .click();
  await expect(
    groupsPanel.getByText("feat-shared", { exact: true }),
  ).toBeVisible();

  // 3. Create second Agent linked to the same shared Project and verify it inherits the Worktree pool.
  await createAgent(page, "Codex 后端", { projectName: "lever-core" });

  // Verify Composer has NO project switcher action.
  const composer = page.locator(".chat-composer-wrap:visible");
  await composer
    .getByRole("button", { name: "添加附件、命令或引用", exact: true })
    .click();
  await expect(page.getByRole("option", { name: /切换项目/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Verify Topic directory picker in Codex 后端 sees the shared Project's worktree group.
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await composer
    .getByRole("button", { name: "工作目录组", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: /feat-shared/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // 4. Open Codex 后端 Profile, set role description, and edit shared Project inline.
  await sidebar
    .getByRole("button", { name: "打开 Codex 后端 的配置", exact: true })
    .click();
  await page
    .getByLabel("职责简介", { exact: true })
    .fill("负责 Go 后端实现与单元测试");
  await page.getByLabel("职责简介", { exact: true }).blur();

  await page.getByRole("button", { name: "编辑项目", exact: true }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByText("已关联 Agent（2）")).toBeVisible();
  await expect(dialog.getByText("Claude 主控")).toBeVisible();
  await expect(dialog.getByText("Codex 后端")).toBeVisible();

  await dialog.getByLabel("名称", { exact: true }).fill("lever-platform");
  await dialog.getByRole("button", { name: "添加目录", exact: true }).click();
  const dirInputs = dialog.getByRole("textbox", { name: "工作范围目录" });
  await dirInputs.last().fill(repoMobile);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();

  // Both linked Agents automatically sync the renamed project & updated roots.
  await expect(
    page.getByRole("combobox", { name: "共享项目", exact: true }),
  ).toContainText("lever-platform");
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const linked = overview.agents.filter((a) =>
    ["Claude 主控", "Codex 后端"].includes(a.name),
  );
  expect(linked).toHaveLength(2);
  for (const ag of linked) {
    expect(ag.profile.roots).toHaveLength(2);
  }
});
