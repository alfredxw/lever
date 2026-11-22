import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function serverContext() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string; otherScope: string; skillRepo: string };
}

function runGit(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

async function openPrimary(page: Page, name: "插件" | "技能" | "设置") {
  await page.goto(serverContext().url);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
}

test("Plugins embeds shared Provider, Task Source, Event Source config and persists update policy", async ({
  page,
}) => {
  await openPrimary(page, "插件");
  const plugins = page.getByRole("main", { name: "插件" });

  // 1. Update policy popover persists globally
  const library = plugins.getByRole("region", {
    name: "插件总览",
    exact: true,
  });
  await library.getByRole("button", { name: "更新策略" }).click();
  const policyDialog = page.getByRole("dialog", { name: "更新策略" });
  const savedPolicy = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/plugin-update-settings") &&
      res.request().method() === "PUT" &&
      res.ok(),
  );
  await policyDialog
    .getByRole("radio", { name: "自动更新", exact: true })
    .click();
  await savedPolicy;
  await page.keyboard.press("Escape");
  await expect(library.getByRole("button", { name: "更新策略" })).toContainText(
    "自动更新",
  );

  // 2. Provider plugin embeds live shared configuration right inside Plugins
  await plugins
    .getByRole("group", { name: "Codex", exact: true })
    .getByRole("button")
    .click();
  await expect(
    plugins.getByText(/与「设置 → 运行时」共享同一份状态/),
  ).toBeVisible();
  await expect(
    plugins.getByRole("heading", { name: /连接实例 \d+/ }),
  ).toBeVisible();
  await expect(
    plugins.getByRole("tab", { name: "实时配置（共享）" }),
  ).toHaveAttribute("aria-selected", "true");
  // Models list and connection controls render directly inside the plugin detail page
  await expect(
    plugins.getByRole("switch", { name: /在模型选择器显示/ }).first(),
  ).toBeInViewport();
  const configuration = plugins
    .locator("summary")
    .filter({ hasText: "配置目录与启动命令" });
  await configuration.focus();
  await configuration.press("Enter");
  await expect(plugins.getByLabel("连接名称", { exact: true })).toBeVisible();
  await configuration.press("Enter");
  await expect(plugins.getByLabel("连接名称", { exact: true })).toBeHidden();

  // Switch to Package tab and verify built-in release info
  await plugins.getByRole("tab", { name: /包版本与订阅更新/ }).click();
  await expect(plugins.getByText("随 Lever 主程序内置发布")).toBeVisible();

  // 3. Task source plugin embeds shared Works task source panel
  const nav = plugins.getByRole("navigation", { name: "插件" });
  await nav.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(
    plugins.getByText(/与「工作 → 来源」共享同一数据源/),
  ).toBeVisible();
  await expect(
    plugins.getByRole("button", { name: "添加来源", exact: true }),
  ).toBeVisible();

  // 4. Event source plugin displays consuming automations + declared schema fields
  await nav.getByRole("button", { name: "IMAP 邮件", exact: true }).click();
  await expect(
    plugins.getByText(/此事件源供「自动化 → 事件触发」选用/),
  ).toBeVisible();
  await expect(plugins.getByText("事件契约与配置字段")).toBeVisible();

  // 5. Subscriptions view opens cleanly from sidebar
  await nav.getByRole("button", { name: /订阅与更新/ }).click();
  await expect(
    plugins.getByRole("heading", { name: "订阅与更新", exact: true }),
  ).toBeVisible();
  await expect(plugins.getByText("全局默认更新策略")).toBeVisible();
});

test("Skills supports Git subscriptions, Files editing with local-edit protection, conflict resolution, and list view", async ({
  page,
}) => {
  test.skip(process.platform === "win32", "POSIX SSH fixture");
  const repoDir = serverContext().skillRepo;
  runGit(repoDir, ["init", "-b", "main"]);
  mkdirSync(join(repoDir, "skills", "sub-alpha", "scripts"), {
    recursive: true,
  });
  writeFileSync(
    join(repoDir, "skills", "sub-alpha", "SKILL.md"),
    "---\nname: sub-alpha\ndescription: Subscribed alpha skill v1\n---\n\n# Alpha V1\n",
  );
  writeFileSync(
    join(repoDir, "skills", "sub-alpha", "scripts", "check.sh"),
    "#!/bin/sh\necho ok\n",
  );
  mkdirSync(join(repoDir, "skills", "sub-beta"), { recursive: true });
  writeFileSync(
    join(repoDir, "skills", "sub-beta", "SKILL.md"),
    "---\nname: sub-beta\ndescription: Subscribed beta skill v1\n---\n\n# Beta V1\n",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "v1"]);

  const repoUrl = "ssh://git@skills.fixture.test/team/skills";

  await openPrimary(page, "技能");
  const library = page.getByRole("region", { name: "技能", exact: true });
  const overview = library.getByRole("region", {
    name: "Skills 技能库",
    exact: true,
  });

  await overview.getByRole("button", { name: "添加技能", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^订阅 Git 仓库/ })
    .click();
  await page.getByLabel("Git 仓库地址", { exact: true }).fill(repoUrl);
  await page.getByLabel("订阅名称（可选）", { exact: true }).fill("team-pack");
  const createdSub = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/skill-subscriptions") &&
      res.request().method() === "POST" &&
      res.ok(),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加订阅源", exact: true })
    .click();
  await createdSub;

  // Both subscribed skills should appear in the overview
  await expect(
    overview.getByRole("button", { name: "Alpha V1", exact: true }),
  ).toBeVisible();
  await expect(
    overview.getByRole("button", { name: "Beta V1", exact: true }),
  ).toBeVisible();
  // File count badge visible for multi-file skill
  await expect(
    overview.getByRole("group", { name: "sub-alpha", exact: true }),
  ).toContainText("2 文件");
  await expect(
    overview.getByRole("group", { name: "sub-beta", exact: true }),
  ).toContainText("1 文件");

  // Toggle Compact List density mode
  await overview.getByRole("radio", { name: "列表", exact: true }).click();
  await expect(overview.locator(".skills-list-row")).toHaveCount(2);
  await overview.getByRole("radio", { name: "卡片", exact: true }).click();

  // Open sub-alpha in Files editor and edit SKILL.md locally
  await overview.getByRole("button", { name: "Alpha V1", exact: true }).click();
  await expect(
    library.getByRole("heading", { name: "Alpha V1", exact: true }),
  ).toBeVisible();
  // Subscribed skill is editable (not read-only)
  await library.getByRole("button", { name: "显示源码", exact: true }).click();
  const editor = library.locator(".monaco-editor:visible .view-lines");
  await expect(editor).toContainText("Alpha V1");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  const edited =
    "---\nname: sub-alpha\ndescription: Subscribed alpha skill v1\n---\n\n# Alpha Local Custom\n";
  await page.keyboard.insertText(edited);
  // Wait for save + localModified banner to appear
  await expect(library.getByText(/此订阅技能已在本地修改/)).toBeVisible({
    timeout: 8000,
  });

  // Commit v2 upstream in the Git repository
  writeFileSync(
    join(repoDir, "skills", "sub-alpha", "SKILL.md"),
    "---\nname: sub-alpha\ndescription: Subscribed alpha skill v2\n---\n\n# Alpha V2\n",
  );
  writeFileSync(
    join(repoDir, "skills", "sub-beta", "SKILL.md"),
    "---\nname: sub-beta\ndescription: Subscribed beta skill v2\n---\n\n# Beta V2\n",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "v2"]);

  // Open Subscriptions view, check & sync updates
  await library
    .getByRole("navigation", { name: "技能" })
    .getByRole("button", { name: /订阅与更新/ })
    .click();
  const subs = library.getByRole("region", { name: "订阅与更新", exact: true });
  await expect(
    subs.getByRole("heading", { name: "订阅与更新", exact: true }),
  ).toBeVisible();
  await subs.getByRole("button", { name: "检查", exact: true }).click();
  await expect(subs.getByText(/可更新 ·/)).toBeVisible();
  await subs.getByRole("button", { name: "同步更新", exact: true }).click();
  // Locally-modified badge should persist (sub-alpha was protected!)
  await expect(subs.getByText("1 项本地已改")).toBeVisible();

  // Return to overview -> resolve conflict by forking local changes to managed copy
  await library
    .getByRole("navigation", { name: "技能" })
    .getByRole("button", { name: "全部技能", exact: true })
    .click();
  const alphaCard = overview.getByRole("group", {
    name: "sub-alpha",
    exact: true,
  });
  await expect(alphaCard).toContainText("本地已改");
  await alphaCard
    .getByRole("button", { name: "Alpha Local Custom", exact: true })
    .click();
  await library.getByRole("button", { name: "处理更新", exact: true }).click();
  const conflictDialog = page.getByRole("dialog", {
    name: /本地修改保护/,
  });
  await expect(conflictDialog).toBeVisible();
  await conflictDialog
    .getByRole("button", { name: /另存托管副本并更新/ })
    .click();
  // Should open the forked managed copy containing our local edits!
  await expect(
    library.getByRole("heading", { name: "Alpha Local Custom", exact: true }),
  ).toBeVisible();
});

test("Skills keeps a large catalog searchable in both the sidebar and the library", async ({
  page,
}) => {
  await page.goto(serverContext().url);
  const { homeDir } = await (await page.request.get("/api/overview")).json();
  const collection = join(homeDir, ".agents", "skills");
  mkdirSync(collection, { recursive: true });
  const root = mkdtempSync(join(collection, "catalog-"));
  try {
    for (let index = 0; index < 230; index++) {
      const suffix = String(index).padStart(3, "0");
      const directory = join(root, `catalog-entry-${suffix}`);
      mkdirSync(directory);
      writeFileSync(join(directory, "SKILL.md"), `# Library item ${suffix}\n`);
    }
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "技能", exact: true })
      .click();
    const nav = page.getByRole("navigation", { name: "技能", exact: true });
    const overview = page.getByRole("region", {
      name: "Skills 技能库",
      exact: true,
    });
    await overview.getByRole("radio", { name: /可更新/ }).click();
    await nav.getByRole("searchbox").fill("/catalog-entry-");
    await expect(nav.locator(".skills-row")).toHaveCount(30);
    await nav.getByRole("button", { name: /在主区查看全部 230 项/ }).click();
    await expect(overview.getByRole("searchbox")).toHaveValue(
      "/catalog-entry-",
    );
    await expect(overview.locator(".skill-card")).toHaveCount(24);
    await overview.getByRole("button", { name: /加载更多/ }).click();
    await expect(overview.locator(".skill-card")).toHaveCount(60);
    await overview.getByRole("radio", { name: "列表", exact: true }).click();
    await expect(overview.locator(".skills-list-row")).toHaveCount(60);
    await overview.getByRole("searchbox").fill("Library item 229");
    const row = overview.getByRole("group", {
      name: "catalog-entry-229",
      exact: true,
    });
    await expect(row).toContainText("/catalog-entry-229");
    const open = row.getByRole("button", {
      name: "Library item 229",
      exact: true,
    });
    await open.focus();
    await open.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Library item 229", exact: true }),
    ).toBeVisible();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
