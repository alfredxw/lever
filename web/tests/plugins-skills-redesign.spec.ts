import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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

test("Skill files open new documents in edit mode and preview the unsaved draft", async ({ page }) => {
  await page.goto(serverContext().url);
  const name = `guide-${randomUUID().slice(0, 8)}`;
  const response = await page.request.post("/api/skills", { data: { name } });
  expect(response.ok()).toBeTruthy();
  const skill = await response.json();
  writeFileSync(join(skill.path, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>');
  await openPrimary(page, "技能");
  const library = page.getByRole("region", { name: "技能", exact: true });
  const nav = library.getByRole("navigation", { name: "技能", exact: true });
  await nav.getByRole("button", { name: "Lever 托管", exact: true }).click();
  await nav.getByRole("button", { name, exact: true }).click();
  const tree = library.getByRole("complementary", { name: "文件目录" });
  const preview = library.getByRole("radio", { name: "预览", exact: true });
  await tree.getByRole("treeitem", { name: "icon.svg", exact: true }).click();
  await expect(preview).toBeChecked();
  await expect(library.getByRole("radio", { name: "源码", exact: true })).toBeDisabled();
  await tree.getByRole("button", { name: "新建文件" }).click();
  const filename = tree.locator("[data-item-rename-input]");
  await filename.fill("guide.md");
  await filename.press("Enter");
  await expect(library.getByRole("radio", { name: "编辑", exact: true })).toBeChecked();
  const editor = library.locator(".monaco-editor:visible .view-lines");
  await editor.click();
  const holdSave = Promise.withResolvers<void>();
  await page.route((url) => url.pathname.endsWith("/file") && url.searchParams.get("path") === "guide.md", async (route) => {
    if (route.request().method() === "PUT") await holdSave.promise;
    await route.continue();
  });
  try {
    await page.keyboard.insertText("# Unsaved guide");
    await preview.click();
    await expect(library.getByRole("heading", { name: "Unsaved guide" })).toBeVisible();
    expect(readFileSync(join(skill.path, "guide.md"), "utf8")).toBe("");
    await library.getByRole("button", { name: "删除技能", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `删除技能 · ${name}` });
    await dialog.getByRole("button", { name: "仅从技能库移除", exact: true }).click();
    await expect(dialog).toContainText("请先保存或放弃");
    await dialog.getByRole("button", { name: "取消" }).click();
  } finally {
    holdSave.resolve();
  }
  await expect.poll(() => readFileSync(join(skill.path, "guide.md"), "utf8")).toBe("# Unsaved guide");
});

test("Skills lets users keep or delete original directories across sources", async ({
  page,
}) => {
  const { url, otherScope } = serverContext();
  await page.goto(url);
  const name = `removal-${randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/skills", { data: { name } });
  expect(created.ok()).toBeTruthy();
  const managed = await created.json();
  const external = join(otherScope, name);
  mkdirSync(external);
  const manifest = `---\nname: ${name}\n---\n\n# External copy\n`;
  writeFileSync(join(external, "SKILL.md"), manifest);
  const added = await page.request.post("/api/skills", {
    data: { directory: external },
  });
  expect(added.ok()).toBeTruthy();
  const { homeDir } = await (await page.request.get("/api/overview")).json();
  const autoName = `auto-${name}`;
  const autoPath = join(homeDir, ".agents", "skills", autoName);
  mkdirSync(autoPath, { recursive: true });
  writeFileSync(join(autoPath, "SKILL.md"), "# Discovered\n");
  await page.reload();
  await openPrimary(page, "技能");
  const skills = page.getByRole("region", { name: "技能", exact: true });
  const overview = skills.getByRole("region", { name: "Skills 技能库" });
  const dialog = page.getByRole("dialog");
  const checkbox = dialog.getByRole("checkbox", { name: "同时删除磁盘上的原目录" });
  const managedCard = overview.getByRole("group", { name, exact: true }).filter({
    has: page.getByRole("button", { name, exact: true }),
  });
  await managedCard
    .getByRole("button", { name: `删除技能 · ${name}`, exact: true })
    .click();
  await expect(dialog).toContainText(managed.path);
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(dialog).toContainText("此操作无法撤销");
  await dialog.getByRole("button", { name: "取消" }).click();
  expect(existsSync(managed.path)).toBe(true);
  await overview.getByRole("button", { name, exact: true }).click();
  await skills.getByRole("button", { name: "删除技能", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.route(
    (url) => url.pathname === `/api/skills/${managed.id}/remove`,
    (route) => route.fulfill({ status: 409, json: { error: "目录正在使用" } }),
    { times: 1 },
  );
  const confirm = dialog.getByRole("button", { name: "移除并删除目录", exact: true });
  await confirm.click();
  await expect(dialog).toContainText("目录正在使用");
  expect(existsSync(managed.path)).toBe(true);
  await confirm.click();
  await expect(overview).toBeVisible();
  await expect(managedCard).toHaveCount(0);
  expect(existsSync(managed.path)).toBe(false);

  await overview.getByRole("radio", { name: "列表", exact: true }).click();
  await overview
    .getByRole("button", { name: `删除技能 · ${name}`, exact: true })
    .click();
  await expect(checkbox).not.toBeChecked();
  await expect(dialog).toContainText(external);
  await dialog
    .getByRole("button", { name: "仅从技能库移除", exact: true })
    .click();
  await expect(
    overview.getByRole("button", { name: "External copy" }),
  ).toHaveCount(0);
  expect(readFileSync(join(external, "SKILL.md"), "utf8")).toBe(manifest);

  await overview
    .getByRole("button", { name: `删除技能 · ${autoName}`, exact: true })
    .click();
  await expect(dialog).toContainText(autoName);
  await dialog.getByRole("button", { name: "仅从技能库移除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await openPrimary(page, "技能");
  await expect(overview.getByRole("group", { name, exact: true })).toHaveCount(
    0,
  );
  await expect(
    overview.getByRole("group", { name: autoName, exact: true }),
  ).toHaveCount(0);
  expect(readFileSync(join(autoPath, "SKILL.md"), "utf8")).toBe("# Discovered\n");
  expect((await page.request.post("/api/skills", { data: { directory: external } })).ok()).toBeTruthy();
  await page.reload();
  await openPrimary(page, "技能");
  await overview.getByRole("button", { name: `删除技能 · ${name}`, exact: true }).click();
  await checkbox.check();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(external)).toBe(false);
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
  await expect(overview.locator(".skills-list-row").filter({ hasText: /sub-alpha|sub-beta/ })).toHaveCount(2);
  await overview.getByRole("radio", { name: "卡片", exact: true }).click();

  // Open sub-alpha in Files editor and edit SKILL.md locally
  await overview.getByRole("button", { name: "Alpha V1", exact: true }).click();
  await expect(
    library.getByRole("heading", { name: "Alpha V1", exact: true }),
  ).toBeVisible();
  // Subscribed skill is editable (not read-only)
  const tree = library.getByRole("complementary", { name: "文件目录" });
  await tree.getByRole("treeitem", { name: "scripts", exact: true }).click();
  await tree.getByRole("treeitem", { name: "check.sh", exact: true }).click();
  await expect(library.locator(".file-text-preview")).toContainText("echo ok");
  await expect(library.getByRole("radio", { name: "预览", exact: true })).toBeChecked();
  await library.getByRole("radio", { name: "编辑", exact: true }).click();
  const editor = library.locator(".monaco-editor:visible .view-lines");
  await expect(editor).toContainText("echo ok");
  await tree.getByRole("treeitem", { name: "SKILL.md", exact: true }).click();
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
  await library.getByRole("button", { name: "总览", exact: true }).click();
  const subscribedAlpha = alphaCard.filter({ has: page.getByRole("button", { name: "Alpha V2", exact: true }) });
  await subscribedAlpha.getByRole("button", { name: "删除技能 · sub-alpha", exact: true }).click();
  const single = page.getByRole("dialog", { name: "删除技能 · sub-alpha" });
  await single.getByRole("button", { name: "仅从技能库移除" }).click();
  await expect(subscribedAlpha).toHaveCount(0);
  await expect(overview.getByRole("button", { name: "Alpha Local Custom", exact: true })).toBeVisible();
  await expect(overview.getByRole("group", { name: "sub-beta", exact: true })).toBeVisible();
  await library.getByRole("navigation", { name: "技能" }).getByRole("button", { name: /订阅与更新/ }).click();
  const subscriptions = library.getByRole("region", { name: "订阅与更新", exact: true });
  await expect(subscriptions.getByRole("heading", { name: "team-pack", exact: true })).toBeVisible();
  const remove = subscriptions.getByRole("button", { name: "移除订阅", exact: true });
  await remove.click();
  const confirmation = page.getByRole("dialog", { name: "移除订阅 · team-pack" });
  await expect(confirmation).toContainText("1 个技能");
  await expect(confirmation.getByRole("checkbox")).not.toBeChecked();
  await confirmation.getByRole("button", { name: "取消" }).click();
  await expect(subscriptions.getByText("team-pack", { exact: true })).toBeVisible();
  await remove.click();
  await confirmation.getByRole("button", { name: "移除订阅", exact: true }).click();
  await expect(subscriptions.getByText("team-pack", { exact: true })).toHaveCount(0);
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
