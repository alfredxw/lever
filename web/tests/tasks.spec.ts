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
  const ownerChip = dialog.getByRole("button", { name: agent.name, exact: true });
  if (await ownerChip.count()) {
    for (const selected of await dialog.locator('.automation-owner-chip[aria-pressed="true"]').all()) {
      if ((await selected.getAttribute("aria-label")) !== agent.name) await selected.click();
    }
    if ((await ownerChip.getAttribute("aria-pressed")) !== "true") await ownerChip.click();
  } else {
    await dialog.getByRole("button", { name: "归属 Agent", exact: true }).click();
    await page.getByRole("option", { name: agent.name, exact: true }).click();
  }
  await dialog.locator(".automation-advanced-details > summary").click();
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
  await expect(detail.getByText("静默 · 仅失败提醒")).toBeVisible();
  const enable = detail.getByRole("switch", { name: /启用/ });
  await enable.click();
  await expect(
    planSidebar.getByRole("list", { name: "已暂停" }).getByTitle(quiet.name),
  ).toBeVisible();
  await enable.click();
  await expect(
    planSidebar.getByRole("list", { name: "静默守护" }).getByTitle(quiet.name),
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
  await expect(history.getByText("静默完成", { exact: true })).toBeVisible();
  const runs: AutomationRun[] = await (
    await page.request.get(path + quiet.id + "/history")
  ).json();
  const background = runs[0].execution!;
  await history.getByRole("button", { name: "打开话题" }).click();
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
    history.getByRole("button", { name: "打开话题" }),
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
  await detail.getByRole("tab", { name: "规则配置" }).click();
  await expect(detail.getByText("事件接入", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "复制 cURL" })).toBeVisible();

  const works = primary.getByRole("button", { name: "工作" });
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

test("automations support inline editing, multi-target flat runs, silent monitor, and inline follow-up", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const createAgent = async (name: string) => {
    const res = await page.request.post("/api/agents", {
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
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as Agent;
  };

  const backendAgent = await createAgent("Auto Backend Owner");
  const frontendAgent = await createAgent("Auto Frontend Owner");

  const createPlan = async (body: Record<string, unknown>) => {
    const res = await page.request.post("/api/tasks/automations", {
      data: body,
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as Automation;
  };

  const prPlan = await createPlan({
    name: "Direct Issue PR fixture",
    prompt: "Fix confirmed issues and open a PR",
    notifyPolicy: "always",
    deliveryMode: "deliver",
    workItem: false,
    trigger: { kind: "schedule", schedule: { intervalMinutes: 1440 } },
    destination: { agentId: backendAgent.id, mode: "topic" },
  });
  const silentPlan = await createPlan({
    name: "Silent Log Guard fixture",
    prompt: "Check error logs silently",
    notifyPolicy: "silent",
    deliveryMode: "deliver",
    workItem: false,
    quiet: true,
    trigger: { kind: "schedule", schedule: { intervalMinutes: 60 } },
    destination: { agentId: backendAgent.id, mode: "topic" },
  });

  for (const plan of [prPlan, silentPlan]) {
    const res = await page.request.post(`/api/tasks/automations/${plan.id}/run`, {
      data: { commandId: crypto.randomUUID() },
    });
    expect(res.ok()).toBeTruthy();
  }
  await expect
    .poll(async () => {
      const feed: AutomationRun[] = await (
        await page.request.get("/api/tasks/automation-runs")
      ).json();
      const mine = feed.filter(
        (run) =>
          run.automationId === prPlan.id || run.automationId === silentPlan.id,
      );
      return mine.length === 2 && mine.every((r) => r.status === "completed");
    })
    .toBe(true);

  const primary = page.getByRole("navigation", { name: "主导航" });
  await primary.getByRole("button", { name: "自动化", exact: true }).click();

  // Default Inbox shows non-silent output flat, hides silent completion until toggled
  const sidebar = page.locator("#automation-sidebar");
  await sidebar.getByRole("button", { name: /产物收件箱/ }).click();
  await expect(
    page.locator(".automation-run-card", { hasText: prPlan.name }).first(),
  ).toBeVisible();
  await expect(
    page.locator(".automation-run-card", { hasText: silentPlan.name }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /静默完成/ }).click();
  await expect(
    page.locator(".automation-run-card", { hasText: silentPlan.name }).first(),
  ).toBeVisible();

  // Operations Monitor surfaces silent daemons alongside active plans
  await sidebar.getByRole("button", { name: /运行监控/ }).click();
  await expect(
    page.locator(".automation-monitor-table", { hasText: silentPlan.name }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /仅静默守护/ }).click();
  await expect(
    page.locator(".automation-monitor-table tbody tr", {
      hasText: silentPlan.name,
    }),
  ).toHaveCount(1);

  // Open plan -> switch to Settings tab -> explicitly pick and add 2nd scope -> flat multi-target runs + scope filter
  await sidebar.getByTitle(prPlan.name).click();
  const detail = page.getByRole("article");
  await expect(
    detail.getByRole("heading", { name: prPlan.name }),
  ).toBeVisible();
  // Summary strip stays read-only without quick "+ Add Scope" action
  await expect(
    detail.getByRole("button", { name: "多 Agent / 范围" }),
  ).toHaveCount(0);

  await detail.getByRole("tab", { name: "规则配置" }).click();
  // Trigger schedule is flat (visible without expanding a 2nd-layer details section)
  await expect(detail.getByText("触发方式", { exact: true }).first()).toBeVisible();
  await detail.getByRole("button", { name: "添加 Agent / 范围" }).click();
  await detail.locator("#automation-add-scope-agent").click();
  await page
    .getByRole("option", { name: frontendAgent.name, exact: true })
    .click();
  await detail.getByRole("button", { name: "确认添加" }).click();
  await expect(detail.getByText(/2 个范围共用本条规则/)).toBeVisible();
  await expect(detail.locator(".automation-target-row")).toHaveCount(2);

  await detail.getByRole("button", { name: "立即运行" }).click();

  const history = detail.getByRole("region", { name: "运行历史" });
  await expect
    .poll(async () => {
      const runs: AutomationRun[] = await (
        await page.request.get(`/api/tasks/automations/${prPlan.id}/history`)
      ).json();
      return runs.length >= 3 && runs.every((r) => r.status === "completed");
    })
    .toBe(true);
  await expect(history.locator(".automation-run-card")).toHaveCount(3);

  // Progressive scope filter bar filters flat runs directly
  const scopeBar = detail.locator(".automation-scope-bar");
  await scopeBar
    .getByRole("button", { name: new RegExp(frontendAgent.name) })
    .click();
  await expect(history.locator(".automation-run-card")).toHaveCount(1);
  await scopeBar.getByRole("button", { name: /全部/ }).click();
  await expect(history.locator(".automation-run-card")).toHaveCount(3);

  // Inline follow-up reply inside docked Reader + promote rule to plan instructions + convert to WorkItem
  const reader = detail.locator(".automation-reader");
  await expect(reader).toBeVisible();
  const correction = "Always attach rollback SQL before opening schema PRs";
  await reader
    .getByRole("textbox", { name: "回复话题", exact: true })
    .fill(correction);
  await reader.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    reader.locator(".automation-thread-turn").getByText(correction),
  ).toBeVisible();

  const promoteSave = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/tasks/automations/${prPlan.id}`) &&
      res.request().method() === "PUT",
  );
  await reader.getByRole("button", { name: /沉淀到全部 2 个范围/ }).click();
  const updatedPlan: Automation = await (await promoteSave).json();
  expect(updatedPlan.prompt).toContain(correction);

  const convertRes = page.waitForResponse(
    (res) =>
      res.url().endsWith("/api/tasks/work-items") &&
      res.request().method() === "POST",
  );
  await reader.getByRole("button", { name: "转为工作项" }).click();
  expect((await convertRes).ok()).toBeTruthy();
});

test("automation artifacts stay searchable and open one at a time on narrow screens", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);
  const agent: Agent = await (
    await page.request.post("/api/agents", {
      data: {
        name: "Output reader fixture",
        profile: {
          provider: "codex",
          permission: "ask",
          roots: [{ id: "root", path: scope }],
          primaryRootId: "root",
        },
      },
    })
  ).json();
  const plan: Automation = await (
    await page.request.post("/api/tasks/automations", {
      data: {
        name: "Output reader audit",
        prompt: "Review changes",
        deliveryMode: "audit",
        notifyPolicy: "always",
        workItem: false,
        trigger: { kind: "schedule", schedule: { intervalMinutes: 1440 } },
        destination: { mode: "topic", agentId: agent.id },
      },
    })
  ).json();
  await page.request.post(`/api/tasks/automations/${plan.id}/run`, {
    data: { commandId: crypto.randomUUID() },
  });
  const history = async (): Promise<AutomationRun[]> =>
    (
      await page.request.get(`/api/tasks/automations/${plan.id}/history`)
    ).json();
  await expect.poll(async () => (await history())[0]?.status).toBe("completed");
  const entry: AutomationRun = {
    ...(await history())[0],
    summary: "Three findings",
    reportItems: ["Guard the cursor", "Add coverage", "Check retries"],
    pullRequests: [
      {
        repository: "sample/lever",
        number: "418",
        label: "Handle empty cursor",
      },
    ],
  };
  await page.route("**/api/tasks/automation-runs", (route) =>
    route.fulfill({ json: [entry] }),
  );
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "自动化", exact: true })
    .click();
  const sidebar = page.locator("#automation-sidebar"),
    card = page.locator(".automation-run-card"),
    reader = page.locator(".automation-reader");
  const search = sidebar.getByRole("searchbox");
  await search.fill("sample/lever#418");
  await expect(sidebar.getByTitle(plan.name)).toBeVisible();
  await expect(
    card.getByRole("link", { name: "审阅 PR 差异" }),
  ).toHaveAttribute("href", "https://github.com/sample/lever/pull/418/files");
  await expect(card.locator(".automation-report-list li")).toHaveCount(3);
  await expect(reader).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(reader).toHaveCount(0);
  await card.getByRole("button", { name: "详情与续聊" }).click();
  await expect(reader).toBeVisible();
  await expect(page.locator(".automation-feed-pane[inert]")).toHaveCount(1);
  await reader.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(reader).toHaveCount(0);
  await expect(card).toBeVisible();
  const finding = card.locator(".automation-report-list li").filter({ hasText: "Guard the cursor" });
  const fix = finding.getByRole("button", { name: "直接修" });
  const panel = page.getByRole("dialog", { name: "交给 Agent" });
  const findingItems = async () => {
    const items = await (await page.request.get("/api/tasks/work-items")).json();
    return items.filter((item: { origin?: { runId?: string }; body: string }) =>
      item.origin?.runId === entry.execution?.runId && item.body === "Guard the cursor");
  };
  await fix.click();
  await panel.getByRole("button", { name: "取消" }).click();
  expect(await findingItems()).toHaveLength(0);
  await fix.click();
  await panel.locator('button[type="submit"]').click();
  await expect(panel).toHaveCount(0);
  const [created] = await findingItems();
  await expect.poll(async () => {
    const runs: TaskExecution[] = await (await page.request.get("/api/tasks/executions")).json();
    return runs.find((run) => run.taskId === created.id)?.agentId;
  }).toBe(agent.id);
});

test("automation reader reuses Chat run activity, image preview, and fixed-session Composer", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const agent: Agent = await (
    await page.request.post("/api/agents", {
      data: {
        name: "Reader Chat Reuse Agent",
        profile: {
          provider: "codex",
          permission: "ask",
          roots: [{ id: "root", path: scope }],
          primaryRootId: "root",
        },
      },
    })
  ).json();

  // Main-session automation with tool-call activity + follow-up in fixedSession main mode
  const plan: Automation = await (
    await page.request.post("/api/tasks/automations", {
      data: {
        name: "Main-session tool audit",
        prompt: "[command-exits] Audit build commands",
        notifyPolicy: "always",
        deliveryMode: "deliver",
        workItem: false,
        trigger: { kind: "schedule", schedule: { intervalMinutes: 1440 } },
        destination: { mode: "chat", agentId: agent.id },
      },
    })
  ).json();

  // Second automation echoing a Markdown image link to verify ImagePreviewProvider
  const imagePlan: Automation = await (
    await page.request.post("/api/tasks/automations", {
      data: {
        name: "Screenshot report",
        prompt: "![Snapshot](https://example.invalid/snapshot.png)",
        notifyPolicy: "always",
        deliveryMode: "deliver",
        workItem: false,
        trigger: { kind: "schedule", schedule: { intervalMinutes: 1440 } },
        destination: { mode: "topic", agentId: agent.id },
      },
    })
  ).json();

  for (const item of [plan, imagePlan]) {
    const res = await page.request.post(`/api/tasks/automations/${item.id}/run`, {
      data: { commandId: crypto.randomUUID() },
    });
    expect(res.ok()).toBeTruthy();
  }
  await expect
    .poll(async () => {
      const feed: AutomationRun[] = await (
        await page.request.get("/api/tasks/automation-runs")
      ).json();
      const mine = feed.filter(
        (r) => r.automationId === plan.id || r.automationId === imagePlan.id,
      );
      return mine.length === 2 && mine.every((r) => r.status === "completed");
    })
    .toBe(true);

  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "自动化", exact: true })
    .click();

  const sidebar = page.locator("#automation-sidebar");
  await sidebar.getByTitle(plan.name).click();
  const reader = page.locator(".automation-reader");
  await expect(reader).toBeVisible();

  // Root run exposes Chat's RunWork / RunActivity trace (tool calls are expandable)
  const workToggle = reader.locator(".run-work-toggle").first();
  await expect(workToggle).toBeVisible();
  await workToggle.click();
  await expect(reader.locator(".run-activity")).toBeVisible();

  // Fixed-session Composer hides Chat/Topic mode switcher and keeps pure Chat UI without helper copy
  await expect(reader.locator(".composer-mode-button")).toHaveCount(0);
  await expect(reader.locator(".automation-quick-prompts")).toHaveCount(0);
  await expect(reader.getByText("原地追问或调教规则")).toHaveCount(0);
  await expect(
    reader.getByRole("button", { name: "选择模型和运行时", exact: true }),
  ).toBeVisible();

  const textbox = reader.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const followUpText = "Check exit codes and re-run build verification";
  await textbox.fill(followUpText);

  // Sending from main-session automation reader posts operation: "main"
  const sendReq = page.waitForRequest(
    (req) => req.url().endsWith("/api/messages") && req.method() === "POST",
  );
  await reader.getByRole("button", { name: "发送", exact: true }).click();
  const payload = (await sendReq).postDataJSON() as { operation: string };
  expect(payload.operation).toBe("main");

  const followUpTurn = reader.locator(".automation-thread-turn").first();
  await expect(followUpTurn).toContainText(followUpText);
  await expect(followUpTurn).toHaveAttribute("data-status", "completed");

  // Chat MessageActions (quote & edit) operate directly on the reader's Composer
  await followUpTurn
    .locator(".user-message")
    .getByRole("button", { name: "引用消息", exact: true })
    .click();
  await expect(reader.locator(".composer-quote")).toContainText(followUpText);
  await reader
    .locator(".composer-quote")
    .getByRole("button")
    .click();
  await expect(reader.locator(".composer-quote")).toHaveCount(0);

  await followUpTurn
    .locator(".user-message")
    .getByRole("button", { name: "从这里编辑", exact: true })
    .click();
  await expect(reader.locator(".queue-heading")).toBeVisible();
  await expect(textbox).toContainText(followUpText);
  await reader
    .getByRole("button", { name: "取消编辑已发送消息", exact: true })
    .click();
  await expect(reader.locator(".queue-heading")).toHaveCount(0);

  // Markdown image inside automation output renders safely with ImagePreviewProvider
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://example.invalid/snapshot.png", (route) =>
    route.fulfill({ contentType: "image/png", body: onePixelPng }),
  );
  await sidebar.getByTitle(imagePlan.name).click();
  await expect(reader).toBeVisible();
  const imageLink = reader.locator("a.chat-image-link").first();
  await expect(imageLink).toBeVisible();
  await imageLink.click();
  const preview = reader.getByRole("region", { name: "图片预览", exact: true });
  await expect(preview).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
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

  await page.getByRole("button", { name: "工作", exact: true }).click();
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
    name: "看板",
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
    .getByRole("list", { name: "看板", exact: true })
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
    .getByRole("list", { name: "看板", exact: true })
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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
    await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
  const sidebar = page.locator("#task-sidebar");
  await expect(
    sidebar.getByRole("button", { name: /^(看板|笔记|来源)$/ }),
  ).toHaveText(["看板", "笔记", "来源"]);
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
  await page.getByRole("button", { name: "打开话题", exact: true }).click();
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
  await expect(
    settings.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  const saveDefaultAgent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/handover") &&
      response.request().method() === "PUT",
  );
  await settings.getByRole("button", { name: "默认 Agent" }).click();
  await page.getByRole("option", { name: "Web Fixture", exact: true }).click();
  expect(await (await saveDefaultAgent).json()).toEqual({
    agentId: fixtureAgents[0].id,
  });
  await settings.getByText("已有对话", { exact: true }).click();
  await settings
    .getByRole("button", { name: "选择对话", exact: true })
    .click();
  const saveSettings = page.waitForResponse(
    (response) =>
      response.url().endsWith("/handover") &&
      response.request().method() === "PUT",
  );
  await page
    .getByRole("option", { name: "Release handovers", exact: true })
    .click();
  expect(await (await saveSettings).json()).toEqual({
    agentId: fixtureAgents[0].id,
    chatId: destination.id,
  });
  await page.keyboard.press("Escape");
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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

  await card.hover();
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
  const footer = card.locator(".task-board-card-footer");
  await expect(footer).toContainText(name);
  await expect(footer.locator(".agent-avatar")).toHaveText("📋");
  await expect(footer.locator("time")).toHaveAttribute("datetime", /T/);
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
  await expect(detail.getByRole("button", { name: "标记完成" })).toBeVisible();

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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await openSettings.click();
  await expect(
    settings.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await expect(oneClick).not.toBeChecked();
  const saveOneClick = page.waitForResponse(
    (response) =>
      response.url().endsWith("/handover") &&
      response.request().method() === "PUT",
  );
  await oneClick.click();
  expect(await (await saveOneClick).json()).toEqual({ oneClick: true });
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.reload();
  await page.getByRole("button", { name: "工作", exact: true }).click();
  await todo.click();
  await expect(sheet.getByRole("button", { name: "选择 Agent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await openSettings.click();
  await expect(oneClick).toBeChecked();
  const saveFallback = page.waitForResponse(
    (response) =>
      response.url().endsWith("/handover") &&
      response.request().method() === "PUT",
  );
  await settings.getByRole("button", { name: "默认 Agent" }).click();
  await page.getByRole("option", { name: fallback.name, exact: true }).click();
  expect(await (await saveFallback).json()).toEqual({
    agentId: fallback.id,
    oneClick: true,
  });
  await page.keyboard.press("Escape");
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const note = page.getByRole("textbox", { name: "工作笔记", exact: true });
  const other = await page.context().newPage();
  await other.goto(url);
  await other.getByRole("button", { name: "工作", exact: true }).click();
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

  await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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
  await page.getByRole("button", { name: "工作", exact: true }).click();
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


test("Quick-create Work Items, Agent Control Dock pause/concurrency, Drop-to-Dispatch, and List batch enqueue", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const agentName = "Dock Worker";
  const agentResp = await page.request.post("/api/agents", {
    data: {
      name: agentName,
      avatar: { kind: "emoji", value: "⚙️", color: "gradient-coast" },
      profile: {
        provider: "codex",
        model: "gpt-test",
        permission: "ask",
        skills: [],
        delegations: [],
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(agentResp.ok()).toBeTruthy();

  await page.reload();
  await page.getByRole("button", { name: "工作", exact: true }).click();
  await page
    .locator("#task-sidebar")
    .getByRole("button", { name: "全部", exact: true })
    .click();

  const board = page.locator(".tasks-board");
  // Kanban Board is the default display mode with text labels.
  await expect(
    board
      .getByRole("radiogroup", { name: "视图模式" })
      .getByRole("radio", { name: "看板", exact: true }),
  ).toBeChecked();

  const dock = board.getByRole("region", { name: "Agent 消费控制" });
  const capsule = dock
    .locator(".task-agent-capsule")
    .filter({ hasText: agentName });
  await expect(capsule).toBeVisible();

  // Pause agent auto-consumption directly from the Agent Control Dock.
  await capsule.getByRole("button", { name: `暂停 ${agentName} 自动消费` }).click();
  await expect(capsule).toContainText("已暂停");

  // Quick-create a human Work Item with Priority + Project -> lands directly in "待办" column (not "待确认").
  const quickInput = board.getByRole("textbox", { name: "工作项标题" });
  await quickInput.fill("Implement dock drop dispatch");
  await board.getByRole("button", { name: "优先级", exact: true }).click();
  await page
    .getByRole("dialog", { name: "优先级", exact: true })
    .getByRole("button", { name: "高", exact: true })
    .click();
  await board.getByRole("button", { name: "项目", exact: true }).click();
  const projectDialog = page.getByRole("dialog", { name: "项目", exact: true });
  await projectDialog.getByRole("textbox", { name: "项目名称" }).fill("Core");
  await projectDialog.getByRole("textbox", { name: "项目名称" }).press("Enter");
  await quickInput.press("Enter");

  const todoColumn = board.locator('.task-board-column[data-column="todo"]');
  const queuedColumn = board.locator('.task-board-column[data-column="queued"]');
  const firstCard = todoColumn
    .locator(".task-board-card")
    .filter({ hasText: "Implement dock drop dispatch" });
  await expect(firstCard).toBeVisible();
  await expect(firstCard).toContainText("Core");
  await expect(firstCard).not.toContainText("待确认");
  await expect(
    board.locator('.task-board-column[data-column="done"]'),
  ).toHaveCount(0);

  // Drop-to-Dispatch: drag the Kanban card directly onto the paused Agent capsule in the dock.
  const cardBox = (await firstCard.locator(".task-board-card-open").boundingBox())!;
  const capsuleBox = (await capsule.boundingBox())!;
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cardBox.x + cardBox.width / 2,
    cardBox.y + cardBox.height / 2 - 20,
    { steps: 4 },
  );
  await page.mouse.move(
    capsuleBox.x + capsuleBox.width / 2,
    capsuleBox.y + capsuleBox.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();

  const queuedCard = queuedColumn
    .locator(".task-board-card")
    .filter({ hasText: "Implement dock drop dispatch" });
  await expect(queuedCard).toBeVisible();
  await expect(queuedCard).toContainText("已暂停消费");
  await expect(capsule).toContainText("+1");

  // Open Agent queue settings popover: update concurrency to 2 and resume auto-consume.
  await capsule
    .getByRole("button", { name: `${agentName} 队列设置` })
    .click();
  const settingsDialog = page.getByRole("dialog", {
    name: `${agentName} 队列设置`,
  });
  await settingsDialog
    .getByRole("radiogroup", { name: "最大并发槽位" })
    .getByRole("radio", { name: "2", exact: true })
    .click();
  await expect(capsule).toContainText("/2");
  await settingsDialog.getByRole("switch", { name: "自动消费队列" }).click();
  await page.keyboard.press("Escape");

  const reviewColumn = board.locator('.task-board-column[data-column="review"]');
  const reviewCard = reviewColumn
    .locator(".task-board-card")
    .filter({ hasText: "Implement dock drop dispatch" });
  await expect(reviewCard).toBeVisible();
  await reviewCard
    .getByRole("button", { name: "标记完成", exact: true })
    .click();
  await board.getByRole("button", { name: "显示已完成", exact: true }).click();
  await expect(
    board
      .locator('.task-board-column[data-column="done"]')
      .locator(".task-board-card")
      .filter({ hasText: "Implement dock drop dispatch" }),
  ).toBeVisible();

  // Switch to List View and verify multi-select batch enqueue.
  await board
    .getByRole("radiogroup", { name: "视图模式" })
    .getByRole("radio", { name: "列表", exact: true })
    .click();
  await quickInput.fill("Batch item one");
  await quickInput.press("Enter");
  await quickInput.fill("Batch item two");
  await quickInput.press("Enter");

  await board
    .getByRole("checkbox", { name: "选择 Batch item one", exact: true })
    .click();
  await board
    .getByRole("checkbox", { name: "选择 Batch item two", exact: true })
    .click();
  const batchBar = board.getByRole("region", { name: "已选 2 项" });
  await expect(batchBar).toBeVisible();
  await batchBar.getByRole("button", { name: "批量入队" }).click();
  await page
    .getByRole("dialog", { name: "批量入队" })
    .getByRole("button", { name: agentName, exact: true })
    .click();
  await expect(batchBar).toBeHidden();
});

test("Needs-You Inbox approves requests in place and sends inline follow-ups", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const agentName = "Inbox Approver";
  const agentResp = await page.request.post("/api/agents", {
    data: {
      name: agentName,
      avatar: { kind: "emoji", value: "🛡️", color: "gradient-coast" },
      profile: {
        provider: "codex",
        model: "gpt-test",
        permission: "ask",
        skills: [],
        delegations: [],
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(agentResp.ok()).toBeTruthy();
  const agent: Agent = await agentResp.json();

  const createdResp = await page.request.post("/api/tasks/work-items", {
    data: {
      title: "Approve release deploy",
      body: "[approval]",
      priority: "urgent",
      project: "Release",
      assigneeAgentId: agent.id,
    },
  });
  expect(createdResp.ok()).toBeTruthy();
  const item = await createdResp.json();

  const queued = await page.request.post("/api/tasks/queue", {
    data: {
      commandId: crypto.randomUUID(),
      record: "workItem",
      taskId: item.id,
      agentId: agent.id,
    },
  });
  expect(queued.ok()).toBeTruthy();

  await page.reload();
  await page.getByRole("button", { name: "工作", exact: true }).click();
  const sidebar = page.locator("#task-sidebar");
  const inboxNav = sidebar.getByRole("button", { name: /^需我处理/ });
  await expect(inboxNav).toContainText(/[1-9]/);
  await inboxNav.click();

  const inbox = page.locator(".task-inbox");
  const inboxRow = inbox
    .locator(".task-inbox-item")
    .filter({ hasText: "Approve release deploy" });
  await expect(inboxRow).toBeVisible();
  await expect(inboxRow).toContainText("需审批");
  await inboxRow.click();

  const detailPane = inbox.locator(".task-inbox-detail");
  // Approve the pending RequestCard right inside Works Inbox!
  const allowButton = detailPane.getByRole("button", {
    name: "仅允许此操作",
    exact: true,
  });
  await expect(allowButton).toBeVisible();
  await allowButton.click();

  await expect(detailPane).toContainText("Approval received:");
  await expect(
    detailPane.getByRole("button", { name: "标记完成", exact: true }),
  ).toBeVisible();

  // Send an inline follow-up right inside the detail pane without leaving Works.
  const followupInput = detailPane.getByRole("textbox", { name: "发送追问" });
  await followupInput.fill("Verify smoke check output");
  await followupInput.press("Enter");
  await expect(detailPane).toContainText("Verify smoke check output");
  await expect(
    detailPane.getByRole("button", { name: "标记完成", exact: true }),
  ).toBeVisible();

  // Mark complete -> item clears from Inbox.
  await detailPane.getByRole("button", { name: "标记完成", exact: true }).click();
  await expect(inboxRow).toHaveCount(0);
});

test("Task deadlines prioritize earlier DDL on Board & List, configure custom reminders, and surface overdue items in Inbox", async ({
  page,
}) => {
  const { url } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  // Create three work items: urgent with no DDL, medium with far DDL, low with overdue DDL.
  const now = Date.now();
  const urgentNoDDL = await page.request.post("/api/tasks/work-items", {
    data: { title: "Urgent without DDL", priority: "urgent" },
  });
  expect(urgentNoDDL.ok()).toBeTruthy();

  const laterDDL = await page.request.post("/api/tasks/work-items", {
    data: {
      title: "Later DDL task",
      priority: "medium",
      deadline: { dueAt: now + 72 * 60 * 60 * 1000, remindOffsets: [60] },
    },
  });
  expect(laterDDL.ok()).toBeTruthy();

  const overdueDDL = await page.request.post("/api/tasks/work-items", {
    data: {
      title: "Overdue DDL task",
      priority: "low",
      deadline: { dueAt: now - 2 * 60 * 60 * 1000, remindOffsets: [30] },
    },
  });
  expect(overdueDDL.ok()).toBeTruthy();

  await page.getByRole("button", { name: "工作", exact: true }).click();
  const sidebar = page.locator("#task-sidebar");
  await sidebar.getByRole("button", { name: "全部", exact: true }).click();

  // Default sort ("截止优先"): Overdue -> Later -> Urgent without DDL.
  const todoCards = page.locator(
    '.task-board-column[data-column="todo"] .task-board-card-title',
  );
  await expect(todoCards).toHaveText([
    "Overdue DDL task",
    "Later DDL task",
    "Urgent without DDL",
  ]);

  // Switch sort to Priority ("优先级"): Urgent without DDL -> Later -> Overdue.
  await page.getByRole("radio", { name: "优先级", exact: true }).click();
  await expect(todoCards).toHaveText([
    "Urgent without DDL",
    "Later DDL task",
    "Overdue DDL task",
  ]);

  // Switch back to Deadline sort and create a task with quick deadline + custom reminder.
  await page.getByRole("radio", { name: "截止优先", exact: true }).click();
  const quickForm = page.locator(".task-quick-create");
  await quickForm.getByRole("button", { name: "截止时间" }).click();
  const popover = page.locator(".task-deadline-popover");
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: /^明天/ }).click();
  await popover.getByRole("button", { name: "自定义" }).click();
  await popover.getByLabel("提前数值").fill("2");
  await popover.getByRole("button", { name: "添加", exact: true }).click();
  await popover.getByRole("button", { name: "保存", exact: true }).click();

  await quickForm.getByLabel("工作项标题").fill("Tomorrow deadline task");
  await quickForm.getByLabel("工作项标题").press("Enter");

  await expect(todoCards).toHaveText([
    "Overdue DDL task",
    "Tomorrow deadline task",
    "Later DDL task",
    "Urgent without DDL",
  ]);

  // Open detail dialog for Tomorrow deadline task and verify reminder + deadline display.
  await page
    .locator(".task-board-card")
    .filter({ hasText: "Tomorrow deadline task" })
    .locator(".task-board-card-open")
    .click();
  const detail = page.locator(".task-board-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("提前 2 天");
  await detail.getByRole("button", { name: "关闭任务详情" }).click();

  // Overdue task surfaces inside Needs-You Inbox with snooze & postpone banner.
  const inboxNav = sidebar.getByRole("button", { name: /^需我处理/ });
  await expect(inboxNav).toContainText(/[1-9]/);
  await inboxNav.click();
  const inbox = page.locator(".task-inbox");
  const overdueRow = inbox
    .locator(".task-inbox-item")
    .filter({ hasText: "Overdue DDL task" });
  await expect(overdueRow).toBeVisible();
  await expect(overdueRow).toContainText("已逾期");
  await overdueRow.click();
  await expect(inbox.locator(".task-detail-deadline-banner")).toBeVisible();
  await inbox
    .locator(".task-detail-deadline-banner")
    .getByRole("button", { name: "顺延至明天", exact: true })
    .click();
  await expect(overdueRow).toHaveCount(0);

  // Settings page exposes global default reminder lead time & all-day wall time.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "通知与提醒" }),
  ).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "待办默认提前提醒" })
    .getByRole("radio", { name: "1 小时" })
    .click();
  await expect
    .poll(async () => {
      const resp = await page.request.get("/api/settings/task-reminders");
      return (await resp.json()).defaultRemindOffsets;
    })
    .toEqual([60]);
});

test("Board and Inbox detail unify work item actions in the footer without duplicate menu items", async ({
  page,
}) => {
  const { url, scope } = taskFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const agent: Agent = await (
    await page.request.post("/api/agents", {
      data: {
        name: "Footer Actions Agent",
        profile: {
          provider: "codex",
          permission: "ask",
          roots: [{ id: "root", path: scope }],
          primaryRootId: "root",
        },
      },
    })
  ).json();

  const proposedResp = await page.request.post("/api/tasks/work-items", {
    data: {
      title: "Proposed footer triage item",
      body: "Verify footer-unified triage actions.",
      assigneeAgentId: agent.id,
    },
  });
  expect(proposedResp.ok()).toBeTruthy();
  const proposedItem = await proposedResp.json();

  // Simulate an Agent-proposed (unconfirmed) item so it surfaces in Inbox with triage actions.
  await page.route("**/api/tasks/work-items", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const list = await res.json();
    await route.fulfill({
      response: res,
      json: list.map((item: { id: string }) =>
        item.id === proposedItem.id
          ? { ...item, createdByAgentId: agent.id }
          : item,
      ),
    });
  });
  await page.route(`**/api/tasks/work-items/${proposedItem.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const item = await res.json();
    await route.fulfill({
      response: res,
      json: { ...item, createdByAgentId: agent.id },
    });
  });

  await page.reload();
  await page.getByRole("button", { name: "工作", exact: true }).click();
  const sidebar = page.locator("#task-sidebar");
  await sidebar.getByRole("button", { name: /^需我处理/ }).click();

  const inbox = page.locator(".task-inbox");
  const inboxRow = inbox
    .locator(".task-inbox-item")
    .filter({ hasText: "Proposed footer triage item" });
  await expect(inboxRow).toBeVisible();
  await inboxRow.click();

  const inboxDetail = inbox.locator(".task-inbox-detail");
  const inboxHeader = inboxDetail.locator(".task-board-detail-header");
  const inboxFooter = inboxDetail.locator(".task-board-detail-footer");

  // Header no longer hosts the work-item overflow menu; footer hosts it on the left.
  await expect(
    inboxHeader.getByRole("button", { name: "工作项操作" }),
  ).toHaveCount(0);
  const inboxManage = inboxFooter.getByRole("button", { name: "工作项操作" });
  const acceptEnqueue = inboxFooter.getByRole("button", {
    name: "收下并入队",
    exact: true,
  });
  await expect(inboxManage).toBeVisible();
  await expect(acceptEnqueue).toBeVisible();
  const manageBox = (await inboxManage.boundingBox())!;
  const primaryBox = (await acceptEnqueue.boundingBox())!;
  expect(manageBox.x).toBeLessThan(primaryBox.x);

  // Unconfirmed item menu omits redundant "移回待办".
  await inboxManage.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "归档工作项" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "从工作台删除" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "移回待办" })).toHaveCount(0);

  // Archive directly from the footer menu -> item leaves Inbox.
  await menu.getByRole("menuitem", { name: "归档工作项" }).click();
  await expect(inboxRow).toHaveCount(0);

  // Switch to Board -> show closed item -> open detail dialog and check footer menu deduplication.
  await sidebar.getByRole("button", { name: "全部", exact: true }).click();
  const board = page.locator(".tasks-board");
  await board.getByRole("button", { name: /^筛选/ }).click();
  const filterDialog = page.getByRole("dialog", { name: "筛选", exact: true });
  await filterDialog.getByRole("button", { name: "状态", exact: true }).click();
  await filterDialog.getByRole("checkbox", { name: "已归档", exact: true }).click();
  await page.keyboard.press("Escape");

  const closedCard = board
    .locator(".task-board-card")
    .filter({ hasText: "Proposed footer triage item" });
  await expect(closedCard).toBeVisible();
  await closedCard.locator(".task-board-card-open").click();

  const detailDialog = page.locator(".task-board-detail");
  await expect(detailDialog).toBeVisible();
  await expect(
    detailDialog
      .locator(".task-board-detail-header")
      .getByRole("button", { name: "工作项操作" }),
  ).toHaveCount(0);
  const dialogFooter = detailDialog.locator(".task-board-detail-footer");
  await expect(
    dialogFooter.getByRole("button", { name: "重新打开任务", exact: true }),
  ).toBeVisible();
  await dialogFooter.getByRole("button", { name: "工作项操作" }).click();
  const closedMenu = page.getByRole("menu");
  await expect(
    closedMenu.getByRole("menuitem", { name: "移回待办" }),
  ).toBeVisible();
  await expect(
    closedMenu.getByRole("menuitem", { name: "从工作台删除" }),
  ).toBeVisible();
  await expect(
    closedMenu.getByRole("menuitem", { name: "取消归档" }),
  ).toHaveCount(0);
  await closedMenu.getByRole("menuitem", { name: "移回待办" }).click();
  await expect(
    dialogFooter.getByRole("button", { name: "标记完成", exact: true }),
  ).toBeVisible();
});
