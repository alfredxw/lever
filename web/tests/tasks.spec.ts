import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type {
  Agent,
  Automation,
  AutomationRun,
  Chat,
  ChatView,
  ExternalTask,
  TaskExecution,
  TaskNote,
  TaskSource,
  TaskSourceUpdate,
  TaskView,
} from "../src/api/types.gen";

function taskFixture() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

test("quiet automations keep their history and surface requests under Agents", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);
  const createdAgent = await page.request.post("/api/agents", {
    data: {
      name: "Automation activity fixture",
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
  const automations = nav.getByRole("button", { name: "自动化", exact: true });
  await automations.click();
  const planSidebar = page.locator("#automation-sidebar");
  await planSidebar.getByRole("button", { name: "新建自动化" }).click();
  const dialog = page.getByRole("dialog", { name: "新建自动化" });
  await dialog
    .getByLabel("名称", { exact: true })
    .fill("Quiet history fixture");
  await dialog.getByLabel("执行指令", { exact: true }).fill("Routine check");
  await dialog.getByRole("button", { name: "归属 Agent", exact: true }).click();
  await page.getByRole("option", { name: agent.name, exact: true }).click();
  await expect(dialog.getByRole("radio", { name: "正常显示" })).toBeChecked();
  await expect(
    dialog.getByRole("switch", { name: "每次运行加入看板" }),
  ).not.toBeChecked();
  await dialog.getByRole("radio", { name: "仅需处理时显示" }).click();
  const saving = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/tasks/automations") &&
      res.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  const quiet: Automation = await (await saving).json();
  expect(quiet).toMatchObject({ quiet: true, workItem: false });
  await expect(dialog).toBeHidden();
  const detail = page.getByRole("article");
  await expect(detail.getByRole("heading", { name: quiet.name })).toBeVisible();
  await expect(detail.getByText("仅需处理时显示")).toBeVisible();
  const enable = detail.getByRole("switch", { name: /启用/ });
  await enable.click();
  await expect(
    planSidebar.getByRole("list", { name: "已暂停" }).getByTitle(quiet.name),
  ).toBeVisible();
  await enable.click();
  await expect(
    planSidebar.getByRole("list", { name: "已启用" }).getByTitle(quiet.name),
  ).toBeVisible();

  const path = "/api/tasks/automations/";
  async function fire(plan: Automation, status: string) {
    const commandId = crypto.randomUUID();
    const started = await page.request.post(path + plan.id + "/run", {
      data: { commandId },
    });
    expect(started.ok()).toBeTruthy();
    const latest = async (): Promise<AutomationRun> =>
      (await (await page.request.get(path + plan.id + "/history")).json())[0];
    await expect.poll(async () => (await latest())?.status).toBe(status);
    return (await latest()).execution!;
  }
  await detail.getByRole("button", { name: "立即运行" }).click();
  const history = page.getByRole("region", { name: "运行历史" });
  await expect(history.getByText("已完成", { exact: true })).toBeVisible();
  const runs: AutomationRun[] = await (
    await page.request.get(path + quiet.id + "/history")
  ).json();
  const background = runs[0].execution!;
  await history.getByRole("button", { name: "打开 Topic" }).click();
  await expect(
    page.locator(`[data-run-id="${background.runId}"]:visible`).first(),
  ).toBeVisible();
  const executions: TaskExecution[] = await (
    await page.request.get("/api/tasks/executions")
  ).json();
  expect(executions.some((item) => item.taskId === background.taskId)).toBe(
    false,
  );
  await automations.click();
  await expect(detail.getByRole("heading", { name: quiet.name })).toBeVisible();
  await expect(
    history.getByRole("button", { name: "打开 Topic" }),
  ).toBeVisible();

  const input = { destination: quiet.destination, trigger: quiet.trigger };
  const runningQuiet = await page.request.post("/api/tasks/automations", {
    data: {
      ...input,
      name: "Quiet running fixture",
      prompt: "[hang]",
      quiet: true,
    },
  });
  const hidden = await fire(await runningQuiet.json(), "running");
  const normal = await page.request.post("/api/tasks/automations", {
    data: { ...input, name: "Visible running fixture", prompt: "[hang]" },
  });
  const visible = await fire(await normal.json(), "running");
  const attention = await page.request.post("/api/tasks/automations", {
    data: {
      ...input,
      name: "Quiet approval fixture",
      prompt: "[approval]",
      quiet: true,
    },
  });
  const pending = await fire(await attention.json(), "waiting_user");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const sidebar = page.locator("#agent-sidebar");
  const group = sidebar.locator(`[data-agent-id="${agent.id}"]`);
  const toggle = group.getByRole("button", { name: /展开或收起/ });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  for (const list of ["全部", "最近"]) {
    await sidebar.getByRole("tab", { name: list, exact: true }).click();
    await expect(
      sidebar.locator(`[data-session-id="${visible.sessionId}"]`),
    ).toBeVisible();
    await expect(
      sidebar.locator(`[data-session-id="${pending.sessionId}"]`),
    ).toBeVisible();
    await expect(
      sidebar.locator(`[data-session-id="${background.sessionId}"]`),
    ).toHaveCount(0);
    await expect(
      sidebar.locator(`[data-session-id="${hidden.sessionId}"]`),
    ).toHaveCount(0);
  }
  const reply = await page.request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      chatId: background.chatId,
      sessionId: background.sessionId,
      operation: "reply",
      text: "Manual follow-up to the quiet check",
    },
  });
  expect(reply.ok()).toBeTruthy();
  await expect(
    sidebar.locator(`[data-session-id="${background.sessionId}"]`),
  ).toBeVisible();
  for (const run of [visible, pending, hidden])
    expect(
      (await page.request.post("/api/runs/" + run.runId + "/stop")).ok(),
    ).toBeTruthy();
});

test("an automation work item opens its plan and handles an archived plan", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);
  const created = await page.request.post("/api/agents", {
    data: {
      name: "Board automation owner",
      profile: {
        provider: "codex",
        permission: "ask",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const agent: Agent = await created.json();
  const endpoint = "/api/tasks/automations";
  const input = {
    prompt: "Check the build",
    destination: { agentId: agent.id, mode: "topic" },
  };
  const scheduled = await page.request.post(endpoint, {
    data: {
      ...input,
      name: "Board build check",
      workItem: true,
      trigger: { kind: "schedule", schedule: { intervalMinutes: 1440 } },
    },
  });
  expect(scheduled.ok()).toBeTruthy();
  const plan: Automation = await scheduled.json();
  const webhook = await page.request.post(endpoint, {
    data: {
      ...input,
      name: "Triage webhook",
      trigger: { kind: "event", batchSize: 2 },
    },
  });
  expect(webhook.ok()).toBeTruthy();
  expect(
    (
      await page.request.post(endpoint + "/" + plan.id + "/run", {
        data: { commandId: crypto.randomUUID() },
      })
    ).ok(),
  ).toBeTruthy();
  const primary = page.getByRole("navigation", { name: "主导航" });
  await primary.getByRole("button", { name: "自动化" }).click();
  const sidebar = page.locator("#automation-sidebar");
  await sidebar.getByRole("searchbox").fill("webhook");
  await expect(sidebar.getByTitle(plan.name)).toHaveCount(0);
  await sidebar.getByTitle("Triage webhook").click();
  const detail = page.getByRole("article");
  await expect(detail.getByRole("button", { name: "立即运行" })).toHaveCount(0);
  await detail.getByText("事件接入", { exact: true }).click();
  await expect(detail.getByRole("button", { name: "复制 cURL" })).toBeVisible();

  const works = primary.getByRole("button", { name: "Works" });
  await works.click();
  const tasks = page.locator("#task-sidebar");
  await expect(tasks.getByRole("button", { name: "自动化" })).toHaveCount(0);
  await tasks.getByRole("button", { name: "全部", exact: true }).click();
  const card = page
    .locator(".task-board-card")
    .getByRole("button", { name: new RegExp(plan.name) });
  const source = page
    .getByRole("dialog")
    .getByRole("button", { name: "查看自动化" });
  await card.click();
  await source.click();
  await expect(detail.getByRole("heading", { name: plan.name })).toBeVisible();
  await expect(sidebar.getByTitle(plan.name)).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(detail.getByText("每次运行创建", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "自动化操作" }).click();
  await page.getByRole("menuitem", { name: "归档自动化" }).click();
  await page
    .getByRole("dialog", { name: "归档自动化" })
    .getByRole("button", { name: "归档自动化" })
    .click();
  await expect(sidebar.getByTitle(plan.name)).toHaveCount(0);
  await works.click();
  await card.click();
  await source.click();
  await expect(page.getByText("这个自动化已归档或已移除")).toBeVisible();
  await expect(sidebar.getByTitle("Triage webhook")).toBeVisible();
  await page.getByRole("button", { name: "查看其他计划" }).click();
  await expect(
    detail.getByRole("heading", { name: "Triage webhook" }),
  ).toBeVisible();
});

test("GitHub Sources and saved Board views expose Issue and PR choices", async ({
  page,
}) => {
  const repo = "example/workbench-task-source-scope-fixture";
  let source: TaskSource | undefined;
  let created: (TaskSourceUpdate & { target: string }) | undefined;
  await page.route("**/api/tasks/sources", async (route) => {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON() as TaskSourceUpdate & {
        target: string;
      };
      created = input;
      source = {
        id: "scope-fixture",
        pluginId: "lever.github",
        contributionId: "github",
        name: input.target,
        syncKind: input.syncKind ?? "both",
        enabled: true,
        pluginEnabled: true,
        syncPending: false,
      };
      await route.fulfill({ json: source });
    } else {
      await route.fulfill({ json: source ? [source] : [] });
    }
  });
  await page.route("**/api/tasks/sources/scope-fixture", async (route) => {
    if (route.request().method() === "DELETE") {
      source = undefined;
    } else {
      const update = route.request().postDataJSON() as TaskSourceUpdate;
      source = { ...source!, ...update };
    }
    await route.fulfill({ json: null });
  });
  const externalTasks: ExternalTask[] = [
    { kind: "issue", title: "Synced fixture issue" },
    { kind: "pr", title: "Synced fixture pull request" },
  ].map((task, index) => ({
    ...task,
    id: `fixture-external-${index}`,
    source: "github",
    project: repo,
    reference: `#${index + 1}`,
    state: "open",
    done: false,
  }));
  await page.route("**/api/tasks/external", (route) =>
    route.fulfill({
      json: externalTasks.filter(
        ({ kind }) => source?.syncKind === "both" || source?.syncKind === kind,
      ),
    }),
  );
  await page.goto(taskFixture().url);
  await page.waitForURL((url) => !url.hash);
  const note = {
    id: crypto.randomUUID(),
    title: "Quick filters fixture",
    state: "active",
    version: "fixture",
    path: "Fixture.xml",
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { taskId: crypto.randomUUID(), done: false },
          content: [{ type: "text", text: "Written fixture task" }],
        },
      ],
    },
  } satisfies TaskNote;
  await page.route("**/api/tasks/notes", (route) =>
    route.fulfill({
      json: [{ id: note.id, title: note.title, state: note.state }],
    }),
  );
  await page.route("**/api/tasks/notes/" + note.id, (route) =>
    route.fulfill({ json: note }),
  );

  await page.getByRole("button", { name: "Works", exact: true }).click();
  const sidebar = page.locator("#task-sidebar");
  const sourcesLink = sidebar.getByRole("button", {
    name: "来源",
    exact: true,
  });
  await sourcesLink.click();
  await expect(sourcesLink).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("textbox", { name: "工作笔记", exact: true }),
  ).toBeVisible();
  await sidebar.getByRole("button", { name: "添加来源", exact: true }).click();
  const add = page.getByRole("dialog", { name: "添加来源" });
  await expect(
    add.getByRole("radio", { name: "Issue 和 PR", exact: true }),
  ).toBeChecked();
  await add.getByRole("textbox", { name: "GitHub 仓库" }).fill(repo);
  await add.getByRole("radio", { name: "PR", exact: true }).click();
  await add.getByRole("button", { name: "添加来源", exact: true }).click();
  await expect(add).toBeHidden();
  expect(created).toMatchObject({ target: repo, syncKind: "pr" });
  const sourceLink = sidebar.getByRole("button", { name: repo, exact: true });
  await expect(sourceLink).toBeInViewport({ ratio: 1 });
  await expect(sourceLink).toHaveAttribute("aria-current", "page");
  const detail = page.getByRole("region", { name: repo, exact: true });
  await sourcesLink.press("Enter");
  await expect(sourcesLink).toHaveAttribute("aria-expanded", "false");
  await expect(sourceLink).toBeHidden();
  await expect(detail).toBeVisible();
  await sourcesLink.press("Space");
  await expect(sourceLink).toHaveAttribute("aria-current", "page");
  await expect(
    detail.getByRole("radio", { name: "PR", exact: true }),
  ).toBeChecked();
  await detail.getByRole("radio", { name: "Issue 和 PR", exact: true }).click();
  await expect(
    detail.getByRole("radio", { name: "Issue 和 PR", exact: true }),
  ).toBeChecked();
  expect(source).toMatchObject({ syncKind: "both", enabled: true });
  const search = sidebar.getByRole("searchbox", { name: "搜索", exact: true });
  await search.fill("fixture pull");
  await expect(sourceLink).toBeHidden();
  await expect(detail).toBeVisible();
  const boardLink = sidebar.getByRole("button", {
    name: "全部",
    exact: true,
  });
  await boardLink.click();
  const board = page.locator(".tasks-board");
  const filter = board.getByRole("button", { name: /^筛选/ });
  const filterPanel = page.getByRole("dialog", { name: "筛选", exact: true });
  const chooseQuickFilter = async (name: string) => {
    await filter.click();
    await filterPanel
      .getByRole("radiogroup", { name: "快捷筛选", exact: true })
      .getByRole("radio", { name, exact: true })
      .click();
    await page.keyboard.press("Escape");
  };
  const kinds = board.getByRole("toolbar", { name: "类型", exact: true });
  const issue = kinds.getByRole("button", { name: "Issue", exact: true });
  const pr = kinds.getByRole("button", { name: "PR", exact: true });
  await expect(search).toHaveValue("fixture pull");
  await expect(board).toContainText("Synced fixture pull request");
  await expect(board).not.toContainText("Written fixture task");
  await search.clear();
  await expect(board).toContainText("Written fixture task");
  await expect(board).toContainText("Synced fixture issue");
  await expect(board).toContainText("Synced fixture pull request");
  await chooseQuickFilter("类型");
  await issue.click();
  await expect(board).toContainText("Synced fixture issue");
  await expect(board).not.toContainText("Synced fixture pull request");
  await expect(board).not.toContainText("Written fixture task");
  await pr.click();
  await expect(board).toContainText("Synced fixture pull request");
  await expect(board).not.toContainText("Written fixture task");
  await issue.click();
  await expect(board).not.toContainText("Synced fixture issue");
  await search.fill("fixture issue");
  await expect(
    board.getByText("没有匹配结果。", { exact: true }),
  ).toBeVisible();
  await search.clear();

  await board.getByRole("button", { name: "保存为视图", exact: true }).click();
  const save = page.getByRole("dialog", { name: "保存为视图" });
  await save
    .getByRole("textbox", { name: "视图名称" })
    .fill("Pull request queue");
  await save.getByRole("button", { name: "保存", exact: true }).click();
  await expect(save).toBeHidden();
  const savedView = sidebar.getByRole("button", {
    name: "Pull request queue",
    exact: true,
  });
  const boardToggle = sidebar.getByRole("button", {
    name: "Board",
    exact: true,
  });
  await expect(savedView).toHaveAttribute("aria-current", "page");
  await boardToggle.click();
  await expect(boardToggle).toHaveAttribute("aria-expanded", "false");
  await expect(savedView).toBeHidden();
  await expect(
    board.getByRole("heading", { name: "Pull request queue", exact: true }),
  ).toBeVisible();
  await expect(sourceLink).toBeVisible();
  await boardToggle.press("Enter");
  await boardLink.click();
  await expect(
    board.getByRole("heading", { name: "全部", exact: true }),
  ).toBeVisible();
  await expect(savedView).toBeVisible();
  await expect(board).toContainText("Written fixture task");
  await search.fill("fixture pull");
  await savedView.click();
  await expect(search).toHaveValue("fixture pull");
  await expect(pr).toHaveAttribute("aria-pressed", "true");
  await expect(board).not.toContainText("Written fixture task");
  await search.clear();
  await chooseQuickFilter("关闭");
  await expect(kinds).toHaveCount(0);
  await expect(filter).toHaveText("筛选1");
  await expect(board).not.toContainText("Synced fixture issue");
  await board.getByRole("button", { name: "保存视图", exact: true }).click();
  await expect(
    board.getByRole("button", { name: "保存视图", exact: true }),
  ).toHaveCount(0);
  await boardToggle.click();
  await sidebar.getByRole("button", { name: "新建视图" }).click();
  const newView = page.getByRole("dialog", { name: "新建视图" });
  await newView.getByRole("textbox", { name: "视图名称" }).fill("Fresh board");
  await newView.getByRole("button", { name: "创建视图", exact: true }).click();
  const freshView = sidebar.getByRole("button", {
    name: "Fresh board",
    exact: true,
  });
  await expect(freshView).toHaveAttribute("aria-current", "page");
  await expect(board).toContainText("Written fixture task");
  await expect(
    board.getByRole("radio", { name: "按状态", exact: true }),
  ).toBeChecked();
  await expect(savedView).toBeVisible();
  const boardRows = sidebar
    .getByRole("list", { name: "Board", exact: true })
    .locator(".task-nav-child");
  await expect(boardRows.first()).toHaveText("全部");
  const views: TaskView[] = await (
    await page.request.get("/api/tasks/views")
  ).json();
  const saved = views.find(({ name }) => name === "Pull request queue")!;
  const fresh = views.find(({ name }) => name === "Fresh board")!;
  expect(saved).toMatchObject({
    quickFilter: "none",
    filters: { kind: ["pr"] },
  });
  expect(fresh).toMatchObject({ group: "status", filters: {} });
  await freshView.press("Shift+Space", { delay: 40 });
  const dragStatus = sidebar
    .getByRole("list", { name: "Board", exact: true })
    .getByRole("status");
  await expect(dragStatus).toContainText("over droppable area " + fresh.id);
  await page.keyboard.press("ArrowUp");
  await expect(dragStatus).toContainText("over droppable area " + saved.id);
  await page.keyboard.press("Space");
  await expect(boardRows.nth(1)).toHaveText("Fresh board");
  await expect(freshView).toHaveAttribute("aria-current", "page");
  await savedView.click();
  await filter.click();
  await filterPanel
    .getByRole("button", { name: "清除筛选", exact: true })
    .click();
  await expect(board).toContainText("Written fixture task");

  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await expect(boardRows.first()).toHaveText("全部");
  await expect(boardRows.nth(1)).toHaveText("Fresh board");
  await sourceLink.click();
  await expect(detail.getByRole("heading", { name: repo })).toBeFocused();
  await detail.getByRole("button", { name: "移除来源" }).click();
  await page
    .getByRole("dialog", { name: "移除来源" })
    .getByRole("button", { name: "移除来源" })
    .click();
  await expect(sourceLink).toHaveCount(0);
  await expect(boardLink).toHaveAttribute("aria-current", "page");
  for (const view of [saved, fresh]) {
    expect(
      (
        await page.request.delete("/api/tasks/views/" + view.id, {
          data: { revision: view.revision },
        })
      ).ok(),
    ).toBeTruthy();
  }
});

test("Agent shortcuts share selections across toolbar and searchable picker", async ({
  page,
}) => {
  const fixture = taskFixture();
  const agents: Agent[] = [
    "Build",
    "Release",
    "Review",
    "Support",
    "Draft",
    "Plan",
    "Check",
    "Sync",
    "Archive",
  ].map((name) => ({
    id: crypto.randomUUID(),
    name,
    profile: {
      provider: "codex",
      model: "gpt-test",
      permission: "ask",
      instructions: "",
      skills: [],
      delegations: [],
      primaryRootId: "root",
      roots: [{ id: "root", path: fixture.scope }],
    },
    archived: false,
    createdAt: "",
    updatedAt: "",
  }));
  let agentCount = 3;
  await page.route("**/api/overview", async (route) => {
    const overview = await route.fetch();
    await route.fulfill({
      response: overview,
      json: { ...(await overview.json()), agents: agents.slice(0, agentCount) },
    });
  });
  const note = {
    id: crypto.randomUUID(),
    title: "Agent quick filter fixture",
    state: "active",
    version: "fixture",
    path: "Fixture.xml",
    content: {
      type: "doc",
      content: agents.slice(0, 3).map(({ id, name }) => ({
        type: "paragraph",
        attrs: { taskId: crypto.randomUUID() },
        content: [
          { type: "agentMention", attrs: { agentId: id, label: name } },
          { type: "text", text: `${name} fixture task` },
        ],
      })),
    },
  } satisfies TaskNote;
  await page.route("**/api/tasks/notes", (route) =>
    route.fulfill({
      json: [{ id: note.id, title: note.title, state: note.state }],
    }),
  );
  await page.route("**/api/tasks/notes/" + note.id, (route) =>
    route.fulfill({ json: note }),
  );
  const openBoard = async () => {
    await page.getByRole("button", { name: "Works", exact: true }).click();
    await page
      .locator("#task-sidebar")
      .getByRole("button", { name: "全部", exact: true })
      .click();
  };

  await page.goto(fixture.url);
  await openBoard();
  const board = page.locator(".tasks-board");
  const toolbar = board.getByRole("toolbar", { name: "负责人", exact: true });
  const build = toolbar.getByRole("button", { name: "Build", exact: true });
  const review = toolbar.getByRole("button", { name: "Review", exact: true });
  const picker = board.getByRole("button", { name: /^负责人/ });
  const choices = page.getByRole("dialog", { name: "负责人", exact: true });
  await expect(toolbar.getByRole("button")).toHaveCount(4);
  await build.click();
  await expect(board).toContainText("Build fixture task");
  await expect(board).not.toContainText("Release fixture task");
  await expect(toolbar.getByRole("button")).toHaveCount(4);

  await page.getByRole("button", { name: "收起二级菜单", exact: true }).click();
  await page.setViewportSize({ width: 680, height: 900 });
  await picker.click();
  await expect(choices.getByRole("checkbox", { name: "Build" })).toBeChecked();
  await choices.getByRole("searchbox", { name: "搜索选项" }).fill("vie");
  await expect(choices.getByRole("checkbox")).toHaveCount(1);
  await choices.getByText("Review", { exact: true }).click();
  await expect(choices.getByRole("checkbox", { name: "Review" })).toBeChecked();
  await expect(board).toContainText("Review fixture task");
  await expect(board).not.toContainText("Release fixture task");

  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(choices).toBeHidden();
  await expect(build).toHaveAttribute("aria-pressed", "true");
  await expect(review).toHaveAttribute("aria-pressed", "true");

  agentCount = agents.length;
  await page.reload();
  await openBoard();
  await picker.click();
  await expect(toolbar).toHaveCount(0);
  await expect(choices.getByRole("checkbox")).toHaveCount(agents.length + 1);
  await page.keyboard.press("Escape");

  await board.getByRole("button", { name: /^筛选/ }).click();
  const filters = page.getByRole("dialog", { name: "筛选", exact: true });
  await filters.getByRole("button", { name: "负责人", exact: true }).click();
  const agentFilters = filters.getByRole("group", { name: "负责人" });
  await agentFilters.getByRole("searchbox", { name: "搜索选项" }).fill("vie");
  await expect(agentFilters.getByRole("checkbox")).toHaveCount(1);
  await agentFilters.getByRole("checkbox", { name: "Review" }).click();
  await filters.getByRole("button", { name: "状态", exact: true }).click();
  await expect(
    agentFilters.getByRole("checkbox", { name: "Review" }),
  ).toBeChecked();
  await expect(filters.getByRole("group", { name: "状态" })).toBeVisible();
  await expect(board).toContainText("Review fixture task");
  await expect(board).not.toContainText("Build fixture task");
});

test("notes inherit and override Agent mentions, link execution, and filter tasks on the Board", async ({
  page,
}) => {
  const fixture = taskFixture();
  await page.goto(fixture.url);
  const fixtureAgents: Agent[] = [];
  for (const [name, emoji] of [
    ["Web Fixture", "🔎"],
    ["Release Fixture", "🚀"],
  ]) {
    const response = await page.request.post("/api/agents", {
      data: {
        name,
        avatar: { kind: "emoji", value: emoji, color: "gradient-coast" },
        profile: {
          provider: "codex",
          model: "gpt-test",
          permission: "ask",
          skills: [],
          delegations: [],
          primaryRootId: "root",
          roots: [{ id: "root", path: fixture.scope }],
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    fixtureAgents.push(await response.json());
  }
  const configuredChat = await page.request.post("/api/chats", {
    data: { agentId: fixtureAgents[0].id, title: "Release handovers" },
  });
  expect(configuredChat.ok()).toBeTruthy();
  const destination: Chat = await configuredChat.json();
  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  const sidebar = page.locator("#task-sidebar");
  await expect(
    sidebar.getByRole("button", { name: /^(Board|笔记|来源)$/ }),
  ).toHaveText(["Board", "笔记", "来源"]);
  await sidebar.getByRole("button", { name: "工作笔记", exact: true }).click();
  const note = page.getByRole("textbox", { name: "工作笔记", exact: true });
  await note.click();
  await note.pressSequentially("## Planning @Web");
  await expect(page.getByRole("option", { name: "Web Fixture" })).toBeVisible();
  await page.keyboard.press("Enter");
  const mention = note.locator("h2 [data-agent-mention]");
  await expect(mention.locator(".agent-avatar")).toHaveText("🔎");
  await expect(mention.getByText("Web Fixture", { exact: true })).toBeVisible();
  await expect(mention).not.toContainText("@");
  await page.keyboard.press("Enter");
  await page.keyboard.type("### Search");
  await page.keyboard.press("Enter");
  await note.pressSequentially("1. Review search refresh");
  const item = note
    .locator("ol > li")
    .filter({ hasText: "Review search refresh" });
  const endOfItem = async () => {
    await note.focus();
    await note.evaluate((element) => {
      const { editor } = element as HTMLElement & { editor: Editor };
      const paragraph = element.querySelector("ol > li > p")!;
      editor.commands.setTextSelection(
        editor.view.posAtDOM(paragraph, paragraph.childNodes.length),
      );
    });
  };
  await note.getByRole("heading", { name: "Search", exact: true }).click();
  const handover = item.getByRole("button", {
    name: "交接 Review search refresh",
  });
  const handoverSheet = page.getByRole("dialog", { name: "交给 Agent" });
  await handover.click();
  await expect(handoverSheet).toContainText("Review search refresh");
  await expect
    .poll(() =>
      handoverSheet.evaluate((element) => {
        const { right, width } = element.getBoundingClientRect();
        return right === innerWidth && width === 368;
      }),
    )
    .toBe(true);
  await expect(
    handoverSheet.getByRole("button", { name: "选择 Agent" }),
  ).toContainText("Web Fixture");
  await page.keyboard.press("Escape");
  await expect(handover).toBeFocused();
  await endOfItem();
  await page.keyboard.type(" @Web");
  await expect(page.getByRole("option", { name: "Web Fixture" })).toBeVisible();
  await page.keyboard.press("Enter");
  const badge = item.locator("[data-agent-mention]");
  await expect(item).toHaveCSS("list-style-type", "decimal");
  await expect(item.locator("[data-task-id]")).toHaveCount(0);
  await handover.click();
  const dispatchNote = handoverSheet.getByRole("textbox", {
    name: "补充说明（可选）",
  });
  const submit = handoverSheet.getByRole("button", {
    name: "交接",
    exact: true,
  });
  let firstTaskId: string | undefined;
  await page.route(
    "**/api/tasks/queue",
    (route) => {
      firstTaskId = route.request().postDataJSON().taskId;
      return route.fulfill({ status: 503, body: "Temporary dispatch failure" });
    },
    { times: 1 },
  );
  await dispatchNote.fill("Include a search regression check");
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Temporary dispatch failure",
  );
  await expect(dispatchNote).toHaveValue("Include a search regression check");
  await submit.click();
  await expect(handoverSheet).toBeHidden();
  await item
    .getByRole("button", { name: "待验收 · Review search refresh" })
    .click();
  await expect(
    badge.getByRole("button", { name: "待验收 · Web Fixture" }),
  ).toBeVisible();
  await expect(item).toHaveCSS("list-style-type", "decimal");
  await expect(item.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "任务详情" }),
  ).toContainText("Review search refresh");
  const linked: TaskExecution[] = await (
    await page.request.get("/api/tasks/executions")
  ).json();
  const chat: ChatView = await (
    await page.request.get("/api/chats/" + linked[0].chatId)
  ).json();
  const topic = chat.sessions.find(({ id }) => id === linked[0].sessionId);
  expect(topic?.taskId).toBe(firstTaskId);
  expect(linked[0].topic).toBeTruthy();
  expect(linked[0].taskId).toBe(firstTaskId);
  expect(chat.runs[0].input).toBe(
    "Review search refresh\n\nInclude a search regression check",
  );
  await page.getByRole("button", { name: "打开 Topic", exact: true }).click();
  await expect(page.locator(".topic-conversation:visible")).toContainText(
    "Review search refresh",
  );
  await page.getByRole("button", { name: "定位原文", exact: true }).click();
  await expect(note).toBeFocused();
  await endOfItem();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Write release notes @Release");
  await expect(
    page.getByRole("option", { name: "Release Fixture" }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "交给 Agent · Release Fixture", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "选择 Agent" })).toContainText(
    "Release Fixture",
  );
  await page.keyboard.press("Escape");
  const release = note
    .locator("ol > li")
    .filter({ hasText: "Write release notes" });
  await expect(release).toHaveCSS("list-style-type", "decimal");
  await expect(release.locator("[data-task-id]")).toHaveCount(0);

  await page.getByRole("button", { name: "新建笔记", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新建笔记" });
  await create
    .getByRole("textbox", { name: "笔记名称" })
    .fill("Release checklist");
  await create.getByRole("button", { name: "创建笔记", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "笔记名称", exact: true }),
  ).toHaveValue("Release checklist");
  const settings = page.getByRole("dialog", { name: "交接设置" });
  await page.getByRole("button", { name: "交接设置", exact: true }).click();
  await settings.getByRole("button", { name: "默认 Agent" }).click();
  await page.getByRole("option", { name: "Web Fixture", exact: true }).click();
  await settings.getByText("已有 Chat", { exact: true }).click();
  await settings
    .getByRole("button", { name: "选择 Chat", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Release handovers", exact: true })
    .click();
  const saveSettings = page.waitForResponse(
    (response) =>
      response.url().endsWith("/handover") &&
      response.request().method() === "PUT",
  );
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  expect(await (await saveSettings).json()).toEqual({
    agentId: fixtureAgents[0].id,
    chatId: destination.id,
  });
  await expect(settings).toBeHidden();
  await page.getByRole("button", { name: "文档操作" }).click();
  await page.getByRole("menuitem", { name: "笔记所属项目" }).click();
  const projectDialog = page.getByRole("dialog", { name: "笔记所属项目" });
  await projectDialog
    .getByRole("textbox", { name: "项目名称" })
    .fill("Release cycle");
  await projectDialog
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("button", { name: "文档操作" }).click();
  await expect(page.getByRole("menuitem", { name: "笔记所属项目" })).toHaveText(
    "Release cycle",
  );
  await page.keyboard.press("Escape");

  await note.click();
  await note.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      "text/plain",
      "## Checklist\n- [ ] Draft the release\n- [x] Check the build",
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const draft = note
    .locator("p[data-task-id]")
    .filter({ hasText: "Draft the release" });
  await expect(draft).toHaveCount(1);
  await expect(
    note.locator("p[data-task-done]").filter({ hasText: "Check the build" }),
  ).toHaveCount(1);

  await note.getByRole("heading", { name: "Checklist" }).click();
  const todoHandover = draft.getByRole("button", {
    name: "交接 Draft the release",
  });
  await todoHandover.click();
  await expect(
    handoverSheet.getByRole("button", { name: "选择 Agent" }),
  ).toContainText("Web Fixture");
  await page.keyboard.press("Escape");
  const addAgent = draft.getByRole("button", { name: "添加 Agent" });
  const agentSearch = page.getByRole("combobox", { name: "搜索 Agent" });
  await addAgent.click();
  await expect(agentSearch).toBeFocused();
  await agentSearch.press("Escape");
  await expect(addAgent).toBeFocused();
  await addAgent.press("Enter");
  await agentSearch.fill("Release");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "Release Fixture" }),
  ).toBeVisible();
  await agentSearch.press("Enter");
  await expect(note).toBeFocused();
  await expect(note.locator("[data-agent-mention]")).toHaveCount(1);
  await expect(
    draft.getByRole("button", { name: "交给 Agent · Release Fixture" }),
  ).toBeVisible();
  await todoHandover.click();
  await expect(
    handoverSheet.getByRole("button", { name: "选择 Agent" }),
  ).toContainText("Release Fixture");
  await handoverSheet.getByRole("button", { name: "选择 Agent" }).click();
  await page.getByRole("option", { name: "Web Fixture" }).click();
  await expect(
    handoverSheet.getByRole("button", { name: "选择 Agent" }),
  ).toContainText("Web Fixture");
  await page.keyboard.press("Escape");
  await expect(todoHandover).toBeFocused();

  const issueUrl = "https://github.com/example/project/issues/123";
  // Notes saved before repository subscriptions still render and filter their snapshots.
  await note.evaluate((element, url) => {
    const { editor } = element as HTMLElement & { editor: Editor };
    editor.commands.insertContentAt(editor.state.doc.content.size, [
      {
        type: "paragraph",
        attrs: {
          taskId: crypto.randomUUID(),
          issue: { id: "issue-123", repository: "example/project" },
        },
        content: [{ type: "text", text: "Import fixture issue" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "example/project#123",
            marks: [{ type: "link", attrs: { href: url } }],
          },
        ],
      },
    ]);
  }, issueUrl);
  await expect(note).toContainText("example/project#123");

  const search = sidebar.getByRole("searchbox", { name: "搜索", exact: true });
  const boardLink = sidebar.getByRole("button", {
    name: "全部",
    exact: true,
  });
  await search.fill("Draft the release");
  await expect(note.locator(".task-search-match")).toContainText(
    "Draft the release",
  );

  const board = page.locator(".tasks-board");
  const group = board.getByRole("radiogroup", { name: "任务分组" });
  const byProject = group.getByRole("radio", { name: "按项目", exact: true });
  const filter = board.getByRole("button", { name: /^筛选/ });
  const filterPanel = page.getByRole("dialog", { name: "筛选", exact: true });
  async function selectFilters(field: string, ...options: string[]) {
    if (!(await filterPanel.isVisible())) await filter.click();
    const section = filterPanel.getByRole("group", {
      name: field,
      exact: true,
    });
    if (!(await section.isVisible())) {
      await filterPanel
        .getByRole("button", { name: field, exact: true })
        .click();
    }
    for (const option of options) {
      await section
        .getByRole("checkbox", { name: option, exact: true })
        .click();
    }
    await page.keyboard.press("Escape");
  }

  await boardLink.click();
  await expect(page.getByRole("searchbox")).toHaveCount(1);
  await expect(search).toHaveValue("Draft the release");
  await expect(board).toContainText("Draft the release");
  await expect(board).not.toContainText("Import fixture issue");
  await search.clear();
  await expect(board).not.toContainText("Write release notes");
  await expect(group.getByRole("radio", { name: "按状态" })).toBeChecked();
  await byProject.click();
  await expect(
    board.getByRole("heading", { name: /Release cycle/ }),
  ).toBeVisible();
  await expect(
    board.getByRole("heading", { name: /example\/project/ }),
  ).toBeVisible();
  await expect(board.getByRole("heading", { name: /未归项目/ })).toBeVisible();
  await selectFilters("来源", "GitHub");
  await expect(board).toContainText("Import fixture issue");
  await expect(board).not.toContainText("Draft the release");
  const saveAs = board.getByRole("button", { name: "保存为视图", exact: true });
  await saveAs.click();
  const saveDialog = page.getByRole("dialog", { name: "保存为视图" });
  await saveDialog
    .getByRole("textbox", { name: "视图名称" })
    .fill("GitHub follow-up");
  await saveDialog.getByRole("button", { name: "保存", exact: true }).click();
  const savedView = sidebar.getByRole("button", {
    name: "GitHub follow-up",
    exact: true,
  });
  await expect(savedView).toHaveAttribute("aria-current", "page");

  await boardLink.click();
  await expect(board).toContainText("Draft the release");
  await savedView.click();
  await expect(byProject).toBeChecked();
  await expect(filter).toHaveText("筛选1");
  await selectFilters("项目", "example/project");
  await board.getByRole("button", { name: "保存视图", exact: true }).click();
  await expect(
    board.getByRole("button", { name: "保存视图", exact: true }),
  ).toHaveCount(0);

  await boardLink.click();
  await selectFilters("笔记", "工作笔记");
  await selectFilters("负责人", "Web Fixture");
  await expect(board).toContainText("Review search refresh");
  await expect(board).not.toContainText("Write release notes");
  await search.fill("Review search");
  const card = board.getByRole("button", { name: /Review search refresh/ });
  const detail = board.getByRole("dialog", { name: "Review search refresh" });
  await card.click();
  await expect(detail).toBeVisible();
  await expect(filter).toHaveText("筛选2");
  await page.keyboard.press("Escape");
  await expect(card).toBeFocused();
  await expect(search).toHaveValue("Review search");
  await card.click();
  await detail.getByRole("button", { name: "标记完成", exact: true }).click();
  await expect(
    detail.getByRole("button", { name: "重新打开任务", exact: true }),
  ).toBeVisible();
  await detail.getByRole("button", { name: "定位原文", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已完成 · Web Fixture", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: "保存中…" })).toHaveCount(0);
  await expect
    .poll(async () => {
      const executions: TaskExecution[] = await (
        await page.request.get("/api/tasks/executions")
      ).json();
      return executions[0]?.done;
    })
    .toBe(true);
  await boardLink.click();
  await expect(filter).toHaveText("筛选2");
  await expect(search).toHaveValue("Review search");
  await search.clear();
  await filter.click();
  await filterPanel
    .getByRole("button", { name: "清除筛选", exact: true })
    .click();
  await selectFilters("状态", "待办", "已完成");
  await expect(board).toContainText("Check the build");
  await expect(board).toContainText("Draft the release");

  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await expect(
    sidebar.getByRole("button", { name: "Release checklist", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "已完成 · Web Fixture", exact: true }),
  ).toBeVisible();
  await expect(mention.locator(".agent-avatar")).toHaveText("🔎");
  await expect(badge.getByText("已完成", { exact: true })).toBeVisible();
  await expect(item).toHaveCSS("list-style-type", "decimal");
  await expect(item.getByRole("checkbox")).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: "Release checklist", exact: true })
    .click();
  await expect(draft.locator("[data-agent-mention]")).toContainText(
    "Release Fixture",
  );
  await savedView.click();
  await expect(byProject).toBeChecked();
  await expect(filter).toHaveText("筛选2");
  await expect(board).toContainText("Import fixture issue");
  await expect(board).not.toContainText("Draft the release");
  await expect(search).toBeVisible();

  const byAgent = group.getByRole("radio", { name: "按 Agent", exact: true });
  await byAgent.click();
  await expect(board).toContainText("Import fixture issue");
  await expect(board).not.toContainText("Draft the release");
  await filter.click();
  await filterPanel.getByRole("button", { name: "保存为视图" }).click();
  const saveCopy = page.getByRole("dialog", { name: "保存为视图" });
  await saveCopy
    .getByRole("textbox", { name: "视图名称" })
    .fill("Issues by Agent");
  await saveCopy.getByRole("button", { name: "保存", exact: true }).click();
  const copy = sidebar.getByRole("button", {
    name: "Issues by Agent",
    exact: true,
  });
  await expect(copy).toHaveAttribute("aria-current", "page");
  await expect(byAgent).toBeChecked();
  await savedView.click();
  await expect(byProject).toBeChecked();

  await sidebar
    .getByRole("button", { name: "「GitHub follow-up」的视图选项" })
    .click();
  await page.getByRole("menuitem", { name: "重命名视图" }).click();
  const rename = page.getByRole("dialog", { name: "重命名视图" });
  await rename.getByRole("textbox", { name: "视图名称" }).fill("Issue queue");
  await rename.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    sidebar.getByRole("button", { name: "Issue queue", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sidebar
    .getByRole("button", { name: "「Issue queue」的视图选项" })
    .click();
  await page.getByRole("menuitem", { name: "删除视图" }).click();
  const remove = page.getByRole("dialog", { name: "删除视图" });
  await remove.getByRole("button", { name: "删除视图", exact: true }).click();
  await expect(
    sidebar.getByRole("button", { name: "Issue queue", exact: true }),
  ).toHaveCount(0);
  await expect(board).toContainText("Import fixture issue");
  await expect(board).toContainText("Draft the release");
  await copy.click();
  await expect(board).not.toContainText("Draft the release");
});

test("the Board follows a dispatched Agent without closing task detail", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);
  const name = "Triage Activity Agent";
  const title = "Check the workspace export";
  const taskId = crypto.randomUUID();
  const profile = {
    provider: "codex",
    model: "gpt-test",
    permission: "ask",
    primaryRootId: "root",
    roots: [{ id: "root", path: scope }],
  };
  const reviewerResponse = await page.request.post("/api/agents", {
    data: { name: "Export Reviewer", profile },
  });
  expect(reviewerResponse.ok()).toBeTruthy();
  const reviewer: Agent = await reviewerResponse.json();
  const agent = await page.request.post("/api/agents", {
    data: {
      name,
      avatar: { kind: "emoji", value: "📋", color: "gradient-coast" },
      profile: {
        ...profile,
        delegations: [{ agentId: reviewer.id, confirm: false }],
      },
    },
  });
  expect(agent.ok()).toBeTruthy();
  const created = await page.request.post("/api/tasks/notes", {
    data: { id: crypto.randomUUID(), title: "Activity fixture" },
  });
  expect(created.ok()).toBeTruthy();
  const note: TaskNote = await created.json();
  const saved = await page.request.put("/api/tasks/notes/" + note.id, {
    data: {
      ...note,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { taskId, done: false },
            content: [{ type: "text", text: title }],
          },
        ],
      },
    },
  });
  expect(saved.ok()).toBeTruthy();

  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await page
    .locator("#task-sidebar")
    .getByRole("button", { name: "全部", exact: true })
    .click();
  const card = page.locator(".task-board-card").filter({ hasText: title });
  const detail = page.getByRole("dialog", { name: title });
  await card.getByRole("button", { name: new RegExp(title) }).click();
  await expect(detail.getByRole("region", { name: "动态" })).toContainText(
    "还没有 Agent 执行记录",
  );
  await detail.getByRole("button", { name: "关闭任务详情" }).click();

  await card.getByRole("button", { name: "交给 Agent", exact: true }).click();
  const dispatch = page.getByRole("dialog", { name: "交给 Agent" });
  await dispatch.getByRole("button", { name: "选择 Agent" }).click();
  const picker = page.getByRole("dialog", { name: "选择 Agent", exact: true });
  const search = picker.getByRole("combobox", { name: "搜索 Agent" });
  await search.fill(name);
  await expect(picker.getByRole("option", { name, exact: true })).toBeVisible();
  await search.press("Enter");
  await expect(picker).toBeHidden();
  await dispatch
    .getByRole("textbox", { name: "备注（可选）" })
    .fill("[approval]");
  await dispatch.getByRole("button", { name: "派发", exact: true }).click();
  const owner = card.locator(".task-board-card-footer");
  await expect(owner).toContainText(name);
  await expect(owner.locator(".agent-avatar")).toHaveText("📋");
  await expect(owner.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(card.getByText("待你处理", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: new RegExp(title) }).click();
  const activity = detail.getByRole("region", { name: "动态" });
  await expect(activity).toContainText("待你处理");
  await expect(activity).toContainText("已派发给");

  const executions: TaskExecution[] = await (
    await page.request.get("/api/tasks/executions")
  ).json();
  const { chatId, sessionId } = executions.find(
    (item) => item.taskId === taskId,
  )!;
  const chat: ChatView = await (
    await page.request.get("/api/chats/" + chatId)
  ).json();
  const answered = await page.request.post(
    `/api/requests/${chat.requests[0].id}/answer`,
    { data: { allow: true } },
  );
  expect(answered.ok()).toBeTruthy();
  await expect(activity).toContainText("Approval received:");
  await expect(detail.getByRole("button", { name: "标记完成" })).toBeVisible();
  const followUp = await page.request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      chatId,
      sessionId,
      text: "Confirm the export passes",
      operation: "reply",
    },
  });
  expect(followUp.ok()).toBeTruthy();
  await expect(activity).toContainText("Confirm the export passes");
  await expect(activity.locator("time")).toHaveCount(3);

  const delegate = await page.request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      chatId,
      sessionId,
      text: `[delegate:${reviewer.id}]`,
      operation: "reply",
    },
  });
  expect(delegate.ok()).toBeTruthy();
  await activity
    .getByRole("button", { name: /Export Reviewer.*打开会话/ })
    .click();
  const receivingChat = page.locator(".chat-panel:visible");
  await expect(
    receivingChat.getByRole("button", { name: `返回 ${name} 的委派消息` }),
  ).toBeVisible();
  await expect(detail).not.toBeVisible();
});

test("Notes limit handover to lists and to-dos and can skip confirmation", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);
  async function createAgent(name: string): Promise<Agent> {
    const response = await page.request.post("/api/agents", {
      data: {
        name,
        profile: {
          provider: "codex",
          permission: "ask",
          roots: [{ id: "root", path: scope }],
          primaryRootId: "root",
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  const mentioned = await createAgent("Handover editor");
  const fallback = await createAgent("Handover reviewer");
  const id = crypto.randomUUID();
  const title = "Handover preferences";
  const text = (text: string) => ({ type: "text", text });
  const paragraph = (value: string) => ({
    type: "paragraph",
    content: [text(value)],
  });
  const mention = {
    type: "agentMention",
    attrs: { agentId: mentioned.id, label: mentioned.name },
  };
  const created = await page.request.post("/api/tasks/notes", {
    data: {
      id,
      title,
      content: {
        type: "doc",
        content: [
          {
            ...paragraph("Choose a recipient"),
            attrs: { taskId: crypto.randomUUID() },
          },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [text("Planning "), mention],
          },
          paragraph("Ordinary text"),
          { type: "paragraph", content: [text("For reference "), mention] },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  paragraph("Review the plan"),
                  paragraph("Include feedback"),
                ],
              },
            ],
          },
        ],
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const editor = page.getByRole("textbox", { name: "工作笔记", exact: true });
  for (const value of ["Ordinary text", "For reference", "Include feedback"]) {
    const row = editor.locator("p").filter({ hasText: value });
    await row.click();
    await expect(row.getByRole("button")).toHaveCount(0);
  }
  const todo = editor.getByRole("button", { name: "交接 Choose a recipient" });
  const item = editor.getByRole("button", { name: "交接 Review the plan" });
  const sheet = page.getByRole("dialog", { name: "交给 Agent" });
  await item.click();
  await expect(sheet.getByRole("button", { name: "选择 Agent" })).toContainText(
    mentioned.name,
  );
  await page.keyboard.press("Escape");

  const openSettings = page.getByRole("button", { name: "交接设置" });
  const settings = page.getByRole("dialog", { name: "交接设置" });
  const oneClick = settings.getByRole("switch", { name: "一键交接" });
  const save = settings.getByRole("button", { name: "保存", exact: true });
  await openSettings.click();
  await expect(oneClick).not.toBeChecked();
  await oneClick.click();
  await save.click();
  await expect(settings).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await todo.click();
  await expect(sheet.getByRole("button", { name: "选择 Agent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await openSettings.click();
  await expect(oneClick).toBeChecked();
  await settings.getByRole("button", { name: "默认 Agent" }).click();
  await page.getByRole("option", { name: fallback.name, exact: true }).click();
  await save.click();
  await expect(settings).toBeHidden();

  const queueResponse = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/tasks/queue") &&
        response.request().method() === "POST",
    );
  await page.route(
    "**/api/tasks/queue",
    (route) => route.fulfill({ status: 503, body: "Retry this handover" }),
    { times: 1 },
  );
  const failed = queueResponse();
  await item.click();
  const first = (await failed).request().postDataJSON();
  await expect(
    page.getByText("Retry this handover", { exact: true }),
  ).toBeVisible();
  await expect(sheet).toBeHidden();
  const retry = queueResponse();
  await item.click();
  const retried = await retry;
  expect(retried.ok()).toBeTruthy();
  expect(retried.request().postDataJSON()).toMatchObject({
    commandId: first.commandId,
    taskId: first.taskId,
    agentId: mentioned.id,
    text: "Review the plan\n\nInclude feedback",
  });
  const dispatched = queueResponse();
  await todo.click();
  const accepted = await dispatched;
  expect(accepted.ok()).toBeTruthy();
  expect(accepted.request().postDataJSON()).toMatchObject({
    agentId: fallback.id,
    noteId: id,
  });
  await expect(sheet).toBeHidden();
  await expect(
    editor.getByRole("button", { name: "待验收 · Choose a recipient" }),
  ).toBeVisible();
});

test("Chinese composition saves the confirmed text when switching notes", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Composition is driven through Chromium's input protocol",
  );
  await page.goto(taskFixture().url);
  await page.waitForURL((url) => !url.hash);
  const id = crypto.randomUUID();
  const title = "中文输入";
  const created = await page.request.post("/api/tasks/notes", {
    data: { id, title },
  });
  expect(created.ok()).toBeTruthy();
  const initial: TaskNote = await created.json();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  const openNote = page.getByRole("button", { name: title, exact: true });
  await openNote.click();
  const note = page.getByRole("textbox", { name: "工作笔记", exact: true });
  await note.click();

  const writes: TaskNote[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "PUT" &&
      request.url().endsWith("/api/tasks/notes/" + id)
    )
      writes.push(request.postDataJSON());
  });
  const input = await page.context().newCDPSession(page);
  for (const text of ["n", "ni", "nihao"]) {
    await input.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  }
  await expect(note).toContainText("nihao");
  // A pause while picking a candidate must not run the note's 450ms autosave.
  await page.waitForTimeout(600);
  expect(writes).toHaveLength(0);

  await input.send("Input.insertText", { text: "你好" });
  await input.send("Input.imeSetComposition", {
    text: "shi",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await input.send("Input.insertText", { text: "世界" });
  await page.getByRole("button", { name: "工作笔记", exact: true }).click();
  await expect
    .poll(async () => {
      const saved: TaskNote = await (
        await page.request.get("/api/tasks/notes/" + id)
      ).json();
      return saved.version;
    })
    .not.toBe(initial.version);
  expect(writes).toHaveLength(1);
  await openNote.click();
  await expect(note.locator("p")).toContainText("你好世界");
  await expect(note).not.toContainText("nihao");
});

test("a save acknowledgement during composition advances the next write", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Composition uses Chromium's input protocol",
  );
  await page.goto(taskFixture().url);
  await page.waitForURL((url) => !url.hash);
  const id = crypto.randomUUID();
  const title = "Save during composition";
  const path = "/api/tasks/notes/" + id;
  expect(
    (await page.request.post("/api/tasks/notes", { data: { id, title } })).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const note = page.getByRole("textbox", { name: "工作笔记", exact: true });
  await note.click();

  const committed = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    committed.resolve();
    await acknowledge.promise;
    await route.fulfill({ response });
  });
  await page.keyboard.type("Start ");
  await committed.promise;
  const input = await page.context().newCDPSession(page);
  try {
    await input.send("Input.imeSetComposition", {
      text: "nihao",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await expect(note).toContainText("Start nihao");
  } finally {
    acknowledge.resolve();
  }
  await expect(page.getByText("保存中…", { exact: true })).toHaveCount(0);
  const saved: TaskNote = await (await page.request.get(path)).json();
  const nextWrite = page.waitForRequest(
    (request) => request.method() === "PUT" && request.url().endsWith(path),
  );
  await input.send("Input.insertText", { text: "你好" });
  expect((await nextWrite).postDataJSON()).toMatchObject({
    version: saved.version,
  });
  await expect
    .poll(async () => {
      const saved: TaskNote = await (await page.request.get(path)).json();
      return JSON.stringify(saved.content);
    })
    .toContain("Start 你好");
  await expect(note).toContainText("Start 你好");
});

test("concurrent note edits merge when independent and recover when they overlap", async ({
  page,
}) => {
  const { url } = taskFixture();
  await page.goto(url);
  await page.waitForURL((current) => !current.hash);
  const id = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const title = "Concurrent note";
  const path = "/api/tasks/notes/" + id;
  const content = (first: string, second: string, done = false) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { taskId, done, issue: null, textAlign: "right" },
        content: [{ type: "text", text: first, marks: [{ type: "bold" }] }],
      },
      {
        type: "paragraph",
        attrs: { taskId: null, done: false, issue: null, textAlign: null },
        content: [{ type: "text", text: second }],
      },
    ],
  });
  expect(
    (
      await page.request.post("/api/tasks/notes", {
        data: {
          id,
          title,
          project: "Operations",
          content: content("First task", "Second line"),
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const note = page.getByRole("textbox", { name: "工作笔记", exact: true });
  const other = await page.context().newPage();
  await other.goto(url);
  await other.getByRole("button", { name: "Works", exact: true }).click();
  await other.getByRole("button", { name: title, exact: true }).click();
  const peer = other.getByRole("textbox", { name: "工作笔记", exact: true });
  await expect(peer.locator("p").first()).toContainText("First task");

  async function holdLocalWrite() {
    const sent = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() === "PUT") {
        sent.resolve();
        await release.promise;
      }
      await route.continue();
    });
    return { sent: sent.promise, release: release.resolve };
  }

  const first = await holdLocalWrite();
  await note.locator("p").nth(1).click();
  await note.press("End");
  await page.keyboard.insertText(" (local)");
  await first.sent;
  try {
    await peer.getByRole("checkbox", { name: "标记完成", exact: true }).click();
    await expect(note).toContainText("Second line (local)");
    await expect
      .poll(async () => (await (await other.request.get(path)).json()).content)
      .toEqual(content("First task", "Second line", true));
  } finally {
    first.release();
  }
  const read = async () =>
    (await (await page.request.get(path)).json()) as TaskNote;
  await expect
    .poll(async () => (await read()).content)
    .toEqual(content("First task", "Second line (local)", true));
  await expect(peer).toContainText("Second line (local)");
  await expect(
    note.getByRole("checkbox", { name: "重新打开任务", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.unroute(`**${path}`);

  const second = await holdLocalWrite();
  await note.locator("p").nth(1).click();
  await note.press("End");
  await page.keyboard.insertText(" A");
  await second.sent;
  try {
    await peer.locator("p").nth(1).click();
    await peer.press("End");
    await other.keyboard.insertText(" B");
    await expect
      .poll(async () => (await read()).content)
      .toEqual(content("First task", "Second line (local) B", true));
  } finally {
    second.release();
  }
  await expect(page.getByRole("alert")).toContainText("有重叠的修改");
  await expect(note).toContainText("Second line (local) A");
  const copyTitle = "Concurrent note（恢复副本）";
  const copyCommitted = Promise.withResolvers<void>();
  await page.route("**/api/tasks/notes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    await route.abort("connectionreset");
    copyCommitted.resolve();
  });
  const recover = page.getByRole("button", { name: "保存恢复副本" });
  await recover.click();
  await copyCommitted.promise;
  await page.unroute("**/api/tasks/notes");
  await expect(recover).toBeEnabled();
  await expect(note).toContainText("Second line (local) A");
  await recover.click();
  await expect(note).toContainText("Second line (local) B");
  const copy = page.getByRole("button", { name: copyTitle, exact: true });
  await expect(copy).toHaveCount(1);
  await copy.click();
  await expect(note.locator("strong")).toHaveText("First task");
  await expect(note).toContainText("Second line (local) A");
  await page.getByRole("button", { name: "文档操作" }).click();
  await expect(page.getByRole("menuitem", { name: "笔记所属项目" })).toHaveText(
    "Operations",
  );
  await page.keyboard.press("Escape");
  const copyTaskId = await note
    .locator("p")
    .first()
    .getAttribute("data-task-id");
  expect(copyTaskId).toBeTruthy();
  expect(copyTaskId).not.toBe(taskId);
  await expect(
    note.getByRole("checkbox", { name: "重新打开任务", exact: true }),
  ).toBeVisible();
  expect((await read()).content).toEqual(
    content("First task", "Second line (local) B", true),
  );
});

test("note block conversion preserves formatting and existing task markers", async ({
  page,
}) => {
  await page.goto(taskFixture().url);
  const id = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const title = "Formatting fixture";
  const created: TaskNote = await (
    await page.request.post("/api/tasks/notes", {
      data: { id, title },
    })
  ).json();
  const response = await page.request.put(`/api/tasks/notes/${id}`, {
    data: {
      ...created,
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [
              { type: "text", text: "Release", marks: [{ type: "bold" }] },
            ],
          },
          {
            type: "paragraph",
            attrs: {
              taskId,
              done: true,
              issue: { id: "issue-formatting", repository: "example/project" },
            },
            content: [{ type: "text", text: "Verified" }],
          },
        ],
      },
    },
  });
  expect(response.ok()).toBeTruthy();

  await page.getByRole("button", { name: "Works", exact: true }).click();
  const openNote = page.getByRole("button", { name: title, exact: true });
  await openNote.click();
  const editor = page.getByRole("textbox", { name: "工作笔记", exact: true });
  const heading = editor.getByRole("heading", { name: "Release", level: 2 });
  const body = editor.locator("p strong").filter({ hasText: "Release" });
  const task = editor.locator(
    `p[data-task-id="${taskId}"][data-task-done][data-issue-id="issue-formatting"]`,
  );
  const handle = page.getByRole("button", { name: "转换块类型" });
  const mod = (await page.evaluate(() => navigator.platform.includes("Mac")))
    ? "Meta"
    : "Control";

  const checkbox = task.getByRole("checkbox", { name: "重新打开任务" });
  await expect(checkbox).toBeVisible();
  expect((await checkbox.boundingBox())!.x).toBeCloseTo(
    (await editor.boundingBox())!.x,
  );
  await expect(handle).toHaveCount(0);
  await heading.hover();
  await handle.click();
  await page.getByRole("menuitem", { name: "正文", exact: true }).click();
  await expect(body).toBeVisible();
  await page.keyboard.press(`${mod}+z`);
  await expect(heading).toBeVisible();

  await heading.click();
  await page.keyboard.press(mod === "Meta" ? "Meta+ArrowLeft" : "Home");
  await page.keyboard.press("Backspace");
  await expect(body).toBeVisible();
  await expect(editor.locator(":scope > p")).toHaveCount(3);
  await page.keyboard.press(`${mod}+z`);
  await expect(heading).toBeVisible();

  await page.keyboard.press(`${mod}+a`);
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const { state } = (element as HTMLElement & { editor: Editor }).editor;
        const { from, to, $from, $to } = state.selection;
        return $from.sameParent($to) && state.doc.textBetween(from, to);
      }),
    )
    .toBe("Release");
  const formatting = page.getByRole("group", { name: "行内格式", exact: true });
  await formatting
    .getByRole("button", { name: "文字对齐", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "居中对齐", exact: true })
    .click();
  await expect(heading).toHaveCSS("text-align", "center");
  await formatting.getByRole("button", { name: "下划线", exact: true }).click();
  await formatting
    .getByRole("button", { name: "应用上次使用的颜色", exact: true })
    .click();
  await expect(heading.locator("u")).toHaveText("Release");
  await expect(
    heading.locator("[data-note-highlight=light-yellow]"),
  ).toHaveText("Release");
  await expect(editor).toBeFocused();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+Alt+0`);
  await expect(body).toBeVisible();
  await expect(task).toHaveCount(1);
  await expect
    .poll(async () => {
      const saved: TaskNote = await (
        await page.request.get(`/api/tasks/notes/${id}`)
      ).json();
      return saved.version;
    })
    .not.toBe(((await response.json()) as TaskNote).version);
  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await expect(body).toBeVisible();
  await expect(body.locator("xpath=ancestor::p")).toHaveCSS(
    "text-align",
    "center",
  );
  await expect(editor.locator("p u")).toHaveText("Release");
  await expect(task).toHaveCount(1);
});

test("table rail actions keep the clicked column when a merged cell spans it", async ({
  page,
}) => {
  await page.goto(taskFixture().url);
  const title = "Table rail fixture";
  const cell = (text: string, colspan = 1) => ({
    type: "tableCell",
    attrs: { colspan },
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const row = (...content: ReturnType<typeof cell>[]) => ({
    type: "tableRow",
    content,
  });
  expect(
    (
      await page.request.post("/api/tasks/notes", {
        data: {
          id: crypto.randomUUID(),
          title,
          content: {
            type: "doc",
            content: [
              {
                type: "table",
                content: [
                  row(cell("Merged", 2), cell("C1")),
                  row(cell("A2"), cell("B2"), cell("C2")),
                ],
              },
              { type: "paragraph" },
            ],
          },
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Works", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const note = page.getByRole("textbox", { name: "工作笔记", exact: true });
  const table = note.locator("table");
  await table.getByText("B2", { exact: true }).click();
  await page.getByRole("button", { name: "选择第 2 行", exact: true }).click();
  const rowActions = page.getByRole("dialog", {
    name: "第 2 行操作",
    exact: true,
  });
  await rowActions
    .getByRole("button", { name: "文字对齐", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "居中对齐", exact: true }).click();
  await expect(
    table.locator("tr:last-child p[style*='text-align: center']"),
  ).toHaveCount(3);
  await expect(rowActions).toBeHidden();

  await page
    .getByRole("button", { name: "选择第 2 列", exact: true })
    .press("Enter");
  const columnActions = page.getByRole("dialog", {
    name: "第 2 列操作",
    exact: true,
  });
  await columnActions
    .getByRole("button", { name: "删除列", exact: true })
    .click();
  const topCells = table.locator("tr:first-child td");
  const bottomCells = table.locator("tr:last-child td");
  await expect(bottomCells).toHaveCount(2);
  await expect(bottomCells).toContainText(["A2", "C2"]);
  await expect(topCells).toHaveCount(2);
  await expect(topCells).toContainText(["Merged", "C1"]);
  await expect(note).toBeFocused();
  const mod = (await page.evaluate(() => navigator.platform.includes("Mac")))
    ? "Meta"
    : "Control";
  await page.keyboard.press(`${mod}+z`);
  await expect(bottomCells).toHaveText(["A2", "B2", "C2"]);
});
