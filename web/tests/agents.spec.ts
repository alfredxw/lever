import {
  test,
  expect,
  type Locator,
  type Page,
  type WebSocket,
} from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Editor } from "@tiptap/core";
import type {
  Agent,
  Catalog,
  ChatView,
  Comparison,
  ComparisonInput,
  ComparisonResult,
  CopyOptions,
  FileContent,
  Overview,
  ProviderInfo,
  Run,
  SessionView,
  TopicSummary,
  WorkingCopy,
} from "../src/api/types.gen";

function context() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    scope: string;
    skill: string;
    otherScope: string;
    pluginDirectory: string;
  };
}
async function enterScopePath(page: Page, trigger: Locator, path: string) {
  await trigger.click();
  const input = page.getByRole("textbox", {
    name: "输入目录路径",
    exact: true,
  });
  await input.fill(path);
  await input.press("Enter");
}

async function createAgent(page: Page, name: string, scope = context().scope) {
  await page.goto(context().url);
  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await dialog.getByRole("textbox", { name: "工作范围目录" }).fill(scope);
  await dialog
    .getByLabel("职责（选填）", { exact: true })
    .fill("Keep changes small and explain the result.");
  await dialog.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择模型和运行时", exact: true }),
  ).toContainText("GPT Test");
}
async function send(page: Page, text?: string) {
  const composer = page.locator(".chat-composer-wrap");
  if (text !== undefined)
    await composer
      .getByRole("textbox", { name: "发送消息", exact: true })
      .fill(text);
  const entries = page.locator(
    ".chat-panel .conversation > .run-content, .topic-thread",
  );
  const previous = await entries.count();
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(entries).toHaveCount(previous + 1);
  await expect(entries.last()).toHaveAttribute("data-status", "completed");
}

async function expectInlineReference(reference: Locator) {
  await expect
    .poll(() =>
      reference.evaluate((element) => {
        const node = element.nextSibling;
        if (!(node instanceof Text)) return false;
        const start = node.data.search(/\S/);
        if (start < 0) return false;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 1);
        const text = range.getBoundingClientRect();
        const label = element.getBoundingClientRect();
        return (
          text.top < label.bottom &&
          text.bottom > label.top &&
          text.left >= label.right - 0.5
        );
      }),
    )
    .toBe(true);
}

async function closeTab(tab: Locator) {
  await tab.hover();
  await tab.locator("..").getByRole("button").click();
}

async function closeTopic(page: Page) {
  const tab = await page
    .locator(".topic-conversation:visible")
    .evaluate((element) =>
      element.closest('[role="tabpanel"]')!.getAttribute("aria-labelledby"),
    );
  await closeTab(page.locator(`[id="${tab}"]`));
}

async function openMoreTool(
  scope: Page | Locator,
  name = "配置",
  more = "更多工具",
) {
  const page = "goto" in scope ? scope : scope.page();
  await scope.getByRole("button", { name: more, exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

async function openProfileScope(page: Page) {
  const tabs = page.getByRole("tablist", { name: "工作范围", exact: true });
  if (!(await tabs.isVisible())) await openMoreTool(page);
  return tabs;
}

async function openScopeTab(page: Page, name: string) {
  const tabs = await openProfileScope(page);
  await tabs.getByRole("tab", { name, exact: true }).click();
  return page.getByRole("tabpanel", { name, exact: true });
}

test("Agent creation needs only a name and uses the device home and an installed runtime", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  // Exercise creation without a current Agent supplying defaults.
  await page.route("**/api/overview", async (route) => {
    const response = await route.fetch();
    const overview = (await response.json()) as Overview;
    await route.fulfill({
      response,
      json: {
        ...overview,
        agents: overview.agents.filter((agent) => agent.name !== "Lever"),
      },
    });
  });
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const providers = (await response.json()) as ProviderInfo[];
    await route.fulfill({
      response,
      json: providers.map((provider) => ({
        ...provider,
        installed: provider.id === "claude",
      })),
    });
  });
  await page.goto(context().url);
  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "创建 Agent" });
  const name = dialog.getByRole("textbox", { name: "名称", exact: true });
  const create = dialog.getByRole("button", { name: "创建 Agent" });
  await expect(name).toBeFocused();
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  await expect(dialog.getByRole("textbox", { name: "工作范围目录" })).toHaveValue(
    overview.homeDir,
  );
  await expect(
    dialog.getByRole("button", { name: "更多选项" }),
  ).toHaveAttribute("aria-expanded", "false");
  const role = dialog.getByRole("textbox", { name: "职责（选填）" });
  const directory = dialog.getByRole("textbox", { name: "工作范围目录" });
  const model = dialog.getByRole("button", { name: "模型", exact: true });
  await expect(role).toBeInViewport({ ratio: 1 });
  await expect(directory).toBeInViewport({ ratio: 1 });
  await expect(model).toBeInViewport({ ratio: 1 });
  await expect(
    dialog.getByRole("radiogroup", { name: "权限", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  const roleBounds = (await role.boundingBox())!;
  const providerBounds = (await dialog
    .getByRole("combobox", { name: "运行时", exact: true })
    .boundingBox())!;
  const nameBounds = (await name.locator("..").boundingBox())!;
  const directoryBounds = (await directory.locator("..").boundingBox())!;
  const modelBounds = (await model.boundingBox())!;
  expect(Math.abs(nameBounds.y - providerBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(directoryBounds.y - modelBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(directoryBounds.x - roleBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(modelBounds.x - providerBounds.x)).toBeLessThanOrEqual(1);
  expect(modelBounds.x).toBeGreaterThan(roleBounds.x + roleBounds.width);
  await name.fill("   ");
  await expect(create).toBeDisabled();
  await name.fill("Home Agent");
  await expect(create).toBeEnabled();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST",
  );
  await name.press("Enter");
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const { profile } = (await response.json()) as Agent;
  expect(profile.roots).toEqual([
    { id: profile.primaryRootId, path: realpathSync(overview.homeDir) },
  ]);
  expect(profile.provider).toBe("claude");
  expect(profile.instructions).toBe("");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toBeVisible();
});

test("Agent creation replaces the home directory and saves the chosen default", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const { scope, otherScope } = context();
  const selections = [[], [scope], [scope, otherScope, scope], [scope]];
  const calls: unknown[][] = [];
  await page.exposeFunction(
    "scopeDialogCall",
    (method: string, ...args: unknown[]) => {
      if (method.startsWith("Dialogs.")) calls.push([method, ...args]);
      if (method === "Dialogs.PickDirectories") return selections.shift();
    },
  );
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "mygo", {
      value: {
        platform: "darwin",
        locale: "zh-CN",
        call: Reflect.get(globalThis, "scopeDialogCall"),
        on: () => () => {},
      },
    });
  });
  const overviewResponse = page.waitForResponse(
    (response) => response.url().endsWith("/api/overview") && response.ok(),
  );
  await page.goto(context().url);
  const overview = (await (await overviewResponse).json()) as Overview;
  if (overview.agents.length === 1 && !overview.agents[0].archived) {
    await page.getByRole("button", { name: "展开 Agent 列表" }).click();
  }
  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "创建 Agent", exact: true });
  await dialog.getByLabel("名称", { exact: true }).fill("Scope picker");
  const choose = dialog.getByRole("button", {
    name: "选择工作目录",
    exact: true,
  });
  const save = dialog.getByRole("button", { name: "创建 Agent" });
  const paths = dialog.getByRole("textbox", {
    name: "工作范围目录",
    exact: true,
  });
  const defaults = dialog
    .getByRole("radiogroup", { name: "工作范围" })
    .getByRole("radio");
  const actions = dialog.getByRole("button", { name: /的目录操作$/ });
  await expect(choose).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(
    0,
  );
  await expect(save).toBeInViewport({ ratio: 1 });
  const { homeDir } = overview;
  const initialPath = await paths.inputValue();
  expect(realpathSync(initialPath)).toBe(realpathSync(homeDir));
  await expect(defaults).toHaveCount(0);
  await expect(save).toBeEnabled();
  await choose.click();
  await expect(choose).toBeEnabled();
  await expect(paths).toHaveValue(initialPath);
  expect(calls.at(-1)).toEqual(["Dialogs.PickDirectories", initialPath, false]);
  await choose.click();
  await expect(paths).toHaveValue(scope);
  await actions.click();
  await page.getByRole("menuitem", { name: "在 Finder 中打开" }).click();
  await expect
    .poll(() => calls.at(-1))
    .toEqual(["Dialogs.OpenDirectory", scope]);
  await actions.click();
  await page.getByRole("menuitem", { name: "移除目录" }).click();
  await expect(choose).toBeVisible();
  await expect(save).toBeDisabled();

  await choose.click();
  await expect(paths).toHaveCount(2);
  await expect(actions.nth(1)).toBeInViewport({ ratio: 1 });
  await expect(defaults.first()).toBeChecked();
  await defaults.nth(1).click();
  await dialog.getByRole("button", { name: "添加目录", exact: true }).click();
  await expect(save).toBeEnabled();
  await expect(paths).toHaveCount(2);
  await expect(defaults.nth(1)).toBeChecked();
  expect(calls.at(-1)).toEqual(["Dialogs.PickDirectories", otherScope, true]);
  const instructions = dialog.getByRole("textbox", { name: "职责（选填）" });
  await instructions.fill("Use the selected workspace.");
  const options = dialog.getByRole("button", { name: "更多选项" });
  await options.click();
  const skills = dialog.getByRole("group", { name: "技能", exact: true });
  const delegations = dialog.getByRole("group", {
    name: "委派协作",
    exact: true,
  });
  await expect(
    dialog.getByRole("group", { name: "任务队列", exact: true }),
  ).toHaveCount(0);
  await expect(
    skills.getByRole("button", { name: "添加技能" }),
  ).toBeVisible();
  await expect(delegations).toBeVisible();
  const skillsBounds = (await skills.boundingBox())!;
  const delegationsBounds = (await delegations.boundingBox())!;
  expect(delegationsBounds.y).toBeGreaterThanOrEqual(
    skillsBounds.y + skillsBounds.height,
  );
  expect(Math.abs(delegationsBounds.width - skillsBounds.width)).toBeLessThanOrEqual(
    2,
  );
  await options.click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST",
  );
  await save.click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const { profile } = (await response.json()) as Agent;
  expect(profile.instructions).toBe("Use the selected workspace.");
  expect(profile.roots.map((root) => root.path)).toEqual(
    [scope, otherScope].map((path) => realpathSync(path)),
  );
  expect(profile.primaryRootId).toBe(profile.roots[1].id);
});

test("new Agent uses the current workspace and both copy entries open the same draft", async ({
  page,
}) => {
  const { url, scope, otherScope, skill } = context();
  await page.goto(url);
  const create = page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first();
  await expect(create).toBeVisible();
  const response = await page.request.post("/api/agents", {
    data: {
      name: "发布流程模板",
      avatar: { kind: "emoji", value: "📝", color: "gray" },
      profile: {
        provider: "claude",
        model: "fixture-claude",
        permission: "ask",
        instructions: "Summarize merged changes.",
        roots: [
          { id: "one", path: scope },
          { id: "two", path: otherScope },
        ],
        primaryRootId: "two",
        skills: [skill],
        delegations: [],
        taskConcurrency: 2,
        disabledSkills: ["fixture-review"],
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const source: Agent = await response.json();
  const row = page.getByRole("button", { name: source.name, exact: true });
  await row.click();
  await create.click();
  const blank = page.getByRole("dialog", { name: "创建 Agent", exact: true });
  await expect(blank.getByRole("textbox", { name: "工作范围目录" })).toHaveValue(
    realpathSync(otherScope),
  );
  await expect(blank.getByRole("combobox", { name: "运行时" })).toContainText(
    "Claude Code",
  );
  await expect(blank.getByLabel("职责（选填）")).toBeEmpty();
  const blankName = blank.getByRole("textbox", { name: "名称", exact: true });
  await blankName.fill("准备好的新 Agent");
  await blank.getByLabel("职责（选填）").fill("Review documentation.");
  const dialogBounds = await blank.boundingBox();
  await blank.getByRole("radio", { name: "从已有 Agent 复制" }).click();
  const copy = page.getByRole("dialog", { name: "复制 Agent", exact: true });
  await expect(copy.getByRole("button", { name: "创建副本" })).toBeDisabled();
  expect(await copy.boundingBox()).toEqual(dialogBounds);
  await page.getByRole("combobox", { name: "搜索 Agent" }).fill("发布流程");
  await page.getByRole("option", { name: source.name }).click();
  const name = copy.getByRole("textbox", { name: "名称", exact: true });
  const expectSelectedName = async () => {
    await expect(name).toBeFocused();
    expect(
      await name.evaluate((input: HTMLInputElement) =>
        input.value.slice(input.selectionStart!, input.selectionEnd!),
      ),
    ).toBe(`${source.name} 副本`);
  };
  await expect(name).toHaveValue(`${source.name} 副本`);
  await expectSelectedName();
  expect(await copy.boundingBox()).toEqual(dialogBounds);
  await name.fill("草稿中的副本");
  await copy.getByRole("radio", { name: "新建", exact: true }).click();
  await expect(blankName).toHaveValue("准备好的新 Agent");
  await expect(blank.getByLabel("职责（选填）")).toHaveValue(
    "Review documentation.",
  );
  await expect(blank.getByRole("textbox", { name: "工作范围目录" })).toHaveValue(
    realpathSync(otherScope),
  );
  expect(await blank.boundingBox()).toEqual(dialogBounds);
  await blank.getByRole("radio", { name: "从已有 Agent 复制" }).click();
  await expect(name).toHaveValue("草稿中的副本");
  await copy.getByRole("button", { name: "取消", exact: true }).click();

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制 Agent…" }).click();
  await expectSelectedName();
  await copy.getByRole("button", { name: "更多选项" }).click();
  const skills = copy.getByRole("group", { name: "技能", exact: true });
  const delegations = copy.getByRole("group", {
    name: "委派协作",
    exact: true,
  });
  await expect(
    copy.getByRole("group", { name: "任务队列", exact: true }),
  ).toHaveCount(0);
  await expect(
    skills.getByText("fixture-review", { exact: true }),
  ).toBeVisible();
  await expect(
    delegations.getByRole("checkbox", { name: source.name }),
  ).toBeVisible();
  const skillsBounds = (await skills.boundingBox())!;
  const delegationsBounds = (await delegations.boundingBox())!;
  expect(delegationsBounds.y).toBeGreaterThanOrEqual(
    skillsBounds.y + skillsBounds.height,
  );
  expect(Math.abs(delegationsBounds.width - skillsBounds.width)).toBeLessThanOrEqual(
    2,
  );
  await name.fill("发布说明副本");
  const saved = page.waitForResponse(
    (result) =>
      result.url().endsWith("/api/agents") &&
      result.request().method() === "POST",
  );
  await name.press("Enter");
  const created: Agent = await (await saved).json();
  expect(created.id).not.toBe(source.id);
  expect(created.name).toBe("发布说明副本");
  expect(created.avatar).toEqual(source.avatar);
  const { roots, primaryRootId, ...settings } = created.profile;
  expect({
    ...settings,
    roots: source.profile.roots,
    primaryRootId: source.profile.primaryRootId,
  }).toEqual(source.profile);
  expect(roots.map(({ path }) => path)).toEqual(
    source.profile.roots.map(({ path }) => path),
  );
  expect(roots[1].id).toBe(primaryRootId);
  expect(roots[1].id).not.toBe(source.profile.primaryRootId);
  await expect(copy).toBeHidden();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toBeVisible();
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  expect(overview.agents.find(({ id }) => id === source.id)).toEqual(source);
  expect(overview.chats.some(({ agentId }) => agentId === created.id)).toBe(
    false,
  );
});

test("an Agent can create and open a new Agent from the originating chat", async ({
  page,
}) => {
  await createAgent(page, "Agent 创建助手");
  const calls = [
    {
      name: "agent_create",
      arguments: {
        name: "发布说明助手",
        instructions: "Summarize merged changes.",
        requestKey: "release-notes",
      },
    },
  ];
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const parent = overview.agents.find(({ name }) => name === "Agent 创建助手")!;
  const started = await page.request.post("/api/messages", {
    data: {
      agentId: parent.id,
      commandId: randomUUID(),
      operation: "main",
      text: `[chat-context] ${JSON.stringify(calls)}`,
    },
  });
  expect(started.ok()).toBeTruthy();
  const run: Run = await started.json();
  await page
    .locator(`#agent-sidebar [data-session-id="${run.sessionId}"]`)
    .click();
  const result = page.getByRole("button", {
    name: "已创建 · 发布说明助手 打开 Agent",
  });
  await expect(result).toBeVisible();
  await page.reload();
  await result.click();
  await expect(
    page.getByRole("textbox", { name: "名称", exact: true }),
  ).toHaveValue("发布说明助手");
  await expect(page.getByRole("textbox", { name: "系统指令" })).toHaveValue(
    "Summarize merged changes.",
  );
});

test("shows each detected subscription above Settings", async ({
  page,
  browserName,
}) => {
  await page.goto(context().url);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const usage = navigation.getByRole("button", { name: "订阅用量" });
  const settings = navigation.getByRole("button", {
    name: "设置",
    exact: true,
  });
  await expect(usage).toBeVisible();
  expect((await usage.boundingBox())!.y).toBeLessThan(
    (await settings.boundingBox())!.y,
  );
  await usage.hover();

  const details = page.getByRole("tooltip");
  const codex = details.locator("section").filter({ hasText: "Codex" });
  const claude = details.locator("section").filter({ hasText: "Claude Code" });
  const agy = details.locator("section").filter({ hasText: "Antigravity" });
  const weekly = page.getByText("7d", { exact: true });
  const codexWeekly = codex.getByRole("listitem").filter({ has: weekly });
  const codexBar = codexWeekly.locator("[style*='width:']");
  const summary = usage.locator("svg g[fill]");
  await expect(codexWeekly).toContainText("剩余 78%");
  await expect(codexBar).toHaveAttribute("style", /width: 22%;/);
  await expect(summary).toHaveCount(3);
  const codexColor = await summary
    .first()
    .evaluate((bar) => getComputedStyle(bar).fill);
  const claudeColor = await summary
    .nth(1)
    .evaluate((bar) => getComputedStyle(bar).fill);
  expect(codexColor).not.toBe(claudeColor);
  await expect(codexBar).toHaveCSS("background-color", codexColor);
  await expect(claude.locator("[style*='width:']").first()).toHaveCSS(
    "background-color",
    claudeColor,
  );
  await expect(details.locator("svg")).toHaveCount(0);
  await expect(codexWeekly.locator("time")).toHaveText(
    /^\d+d(?: \d+h)? 后重置$/,
  );
  await expect(codex).toContainText("剩余 100%");
  await expect(claude).toContainText("剩余 31.5%");
  const claudeWeekly = claude.getByRole("listitem").filter({ has: weekly });
  await expect(claudeWeekly).toContainText("剩余 76%");
  await expect(claudeWeekly.locator("time")).toHaveCount(0);
  await expect(agy.getByText("Gemini Models", { exact: true })).toBeVisible();
  await expect(
    agy.getByText("Claude and GPT models", { exact: true }),
  ).toBeVisible();
  await expect(agy.getByRole("listitem").first()).toContainText("剩余 75%");
  await expect(agy.getByRole("listitem").last()).toContainText("剩余 50%");
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  await navigation.getByRole("separator").focus();
  await page.keyboard.press("Home");
  await page.mouse.move(250, 40);
  // macOS WebKit's alternate Tab key includes buttons in keyboard navigation.
  const previousControl =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Shift+Tab"
      : "Shift+Tab";
  await page.keyboard.press(previousControl);
  await expect(settings).toBeFocused();
  await page.keyboard.press(previousControl);
  await expect(usage).toBeFocused();
  await expect(details).toBeVisible();

  await page.evaluate(() => localStorage.setItem("lever:language", "en-US"));
  await page.reload();
  await page
    .getByRole("button", { name: "Subscription usage", exact: true })
    .hover();
  const remaining = codexWeekly.getByText("78% left", { exact: true });
  await expect(remaining).toBeVisible();
  const periodBox = (await codexWeekly
    .getByText("7d", { exact: true })
    .boundingBox())!;
  const resetBox = (await codexWeekly.locator("time").boundingBox())!;
  const remainingBox = (await remaining.boundingBox())!;
  const rowBox = (await codexWeekly.boundingBox())!;
  const nameBox = (await codex
    .getByText("Codex", { exact: true })
    .boundingBox())!;
  expect(periodBox.x).toBeCloseTo(nameBox.x);
  expect(resetBox.x).toBeGreaterThan(periodBox.x + periodBox.width);
  expect(remainingBox.x).toBeGreaterThan(resetBox.x + resetBox.width);
  expect(remainingBox.x + remainingBox.width).toBeCloseTo(
    rowBox.x + rowBox.width,
    0,
  );
});

test("summarizes up to three subscriptions and lists the rest in Usage", async ({
  page,
}) => {
  let showAll = false;
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const providers = (await response.json()) as ProviderInfo[];
    const codex = providers.find(({ id }) => id === "codex")!;
    const extra = ["Work", "Team", "Lab"].map((profile) => ({
      ...codex,
      id: `usage-${profile.toLowerCase()}`,
      name: `Codex · ${profile}`,
      configPath: `${codex.configPath}/${profile}`,
    }));
    await route.fulfill({
      response,
      json: showAll
        ? [...providers, ...extra]
        : providers.map((provider) => ({
            ...provider,
            reportsUsage: provider.id === "codex",
          })),
    });
  });
  await page.route("**/api/providers/usage-*/usage", (route) =>
    route.fulfill({
      json: [{ id: "primary", minutes: 300, usedPercent: 46 }],
    }),
  );

  await page.goto(context().url);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const usage = navigation.getByRole("button", { name: "订阅用量" });
  await expect(usage.locator("circle[stroke-dasharray]")).toHaveCount(1);

  showAll = true;
  await page.reload();
  const summary = usage.locator("svg g[fill]");
  const overflow = usage.getByText("+3", { exact: true });
  await expect(summary).toHaveCount(3);
  await expect(overflow).toBeVisible();
  await usage.hover();
  const details = page.getByRole("tooltip");
  await expect(details.locator("section")).toHaveCount(6);
  await expect(details).toContainText("Codex · Lab");
  await expect(details).toContainText("剩余 54%");

  await page.keyboard.press("Escape");
  await navigation.getByRole("separator").focus();
  await page.keyboard.press("Home");
  await expect(usage).toHaveCSS("width", "36px");
  await expect(overflow).toBeHidden();
  await expect(summary).toHaveCount(3);
});

test("Compare Agent picker follows sidebar sorting and fits wrapped labels", async ({
  page,
}, testInfo) => {
  const { scope, url } = context();
  const prefix = `Compare ${randomUUID().slice(0, 8)}`;
  const longModel = "LongComparisonModel".repeat(5);
  const agents: Agent[] = [];
  await page.goto(url);
  for (const number of [1, 10, 2, 3, 4, 5, 6]) {
    const response = await page.request.post("/api/agents", {
      data: {
        name: `${prefix} ${number}`,
        profile: {
          provider: "codex",
          model: number === 10 ? longModel : "",
          permission: "ask",
          roots: [{ path: scope }],
          skills: [],
          delegations: [],
        },
      },
    });
    expect(response.ok()).toBe(true);
    agents.push(await response.json());
  }
  const manualOrder = [agents[1], agents[0], ...agents.slice(2)];
  await page.addInitScript(
    ({ owner, order }) => {
      localStorage.setItem("lever:agent", owner);
      localStorage.setItem("lever:agent-sort", "manual");
      localStorage.setItem("lever:agent-order", JSON.stringify(order));
    },
    { owner: agents[0].id, order: manualOrder.map((agent) => agent.id) },
  );
  await page.reload();
  const sidebar = page.locator("#agent-sidebar");
  const sidebarNames = sidebar.locator(".agent-select");
  await expect(sidebarNames.filter({ hasText: prefix })).toHaveText(
    manualOrder.map((agent) => agent.name),
  );

  const composer = page.locator(".chat-composer-wrap:visible");
  await composer
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("/compare");
  await page.getByRole("option", { name: /^\/compare/ }).click();
  const picker = page.getByRole("dialog", { name: "参与对比的 Agent" });
  const pickerNames = picker.locator('[data-slot="field-label"] .truncate');
  await expect(pickerNames).toHaveText(await sidebarNames.allTextContents());
  await expect(
    picker.getByRole("checkbox", { name: `${prefix} 10` }),
  ).toBeEnabled();
  const modelLabel = picker.getByText(longModel);
  expect(
    await modelLabel.evaluate(
      (label) =>
        label.getBoundingClientRect().height >
        Number.parseFloat(getComputedStyle(label).lineHeight),
    ),
  ).toBe(true);
  expect(
    await picker.locator('[data-slot="field"]').evaluateAll((rows) =>
      rows.every((row) => {
        const bounds = row.getBoundingClientRect();
        const label = row
          .querySelector('[data-slot="field-label"]')!
          .getBoundingClientRect();
        return label.top >= bounds.top && label.bottom <= bounds.bottom;
      }),
    ),
  ).toBe(true);
  await picker.screenshot({
    path: testInfo.outputPath("comparison-agent-picker.png"),
    animations: "disabled",
  });

  await page.keyboard.press("Escape");
  const sortMenu = sidebar.getByRole("button", { name: "Agent 排序" });
  const addAgents = composer.getByRole("button", { name: "添加 Agent" });
  for (const sort of ["名称", "最近活跃", "手动排序"]) {
    await sortMenu.click();
    await page.getByRole("menuitemradio", { name: sort, exact: true }).click();
    await addAgents.click();
    await expect(pickerNames).toHaveText(await sidebarNames.allTextContents());
    await page.keyboard.press("Escape");
  }
  await sidebarNames.first().press("Space");
  await expect(sidebar.locator(".agent-group.dragging")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator('[id^="DndLiveRegion-"]').filter({
      hasText: `droppable area ${agents[0].id}`,
    }),
  ).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(sidebarNames.first()).toHaveText(agents[0].name);
  await addAgents.click();
  await expect(pickerNames).toHaveText(await sidebarNames.allTextContents());
});

test("compares ordinary replies from multiple Agents and continues the selected Topic", async ({
  page,
}, testInfo) => {
  const { url, scope } = context();
  const suffix = randomUUID().slice(0, 8);
  const owner = `工程 ${suffix}`;
  const reviewer = `审阅 ${suffix}`;
  const designer = `设计 ${suffix}`;
  await page.goto(url);
  await page.evaluate(
    async ({ scope, recipients }) => {
      for (const { name, provider } of recipients) {
        const response = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            profile: {
              provider,
              permission: "ask",
              instructions: [
                `Profile for ${name}`,
                ...Array.from(
                  { length: 32 },
                  (_, i) => `Review paragraph ${i + 1}`,
                ),
              ].join("\n\n"),
              roots: [{ id: "root", path: scope }],
              primaryRootId: "root",
              skills: [],
              delegations: [],
            },
          }),
        });
        if (!response.ok) throw new Error(await response.text());
        const { id } = await response.json();
        if (name === recipients[0].name)
          localStorage.setItem("lever:agent", id);
        if (name === recipients[1].name)
          localStorage.setItem(
            `lever:model-preferences:${id}`,
            JSON.stringify({
              provider: "claude",
              models: {
                claude: { model: "default", effort: "max", fast: false },
              },
            }),
          );
      }
    },
    {
      scope,
      recipients: [
        { name: owner, provider: "codex" },
        { name: reviewer, provider: "codex" },
        { name: designer, provider: "codex" },
      ],
    },
  );
  await page.reload();
  const newChat = page
    .getByRole("button", { name: "新对话", exact: true })
    .first();
  await newChat.click();
  const composer = page.locator(".chat-composer-wrap:visible");
  const textbox = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const topicMode = composer.getByRole("button", {
    name: "话题",
    exact: true,
  });
  const compare = composer.getByRole("button", {
    name: "回复对比",
    exact: true,
  });
  const addAgents = composer.getByRole("button", { name: "添加 Agent" });
  const picker = page.getByRole("dialog", { name: "参与对比的 Agent" });
  const compareCommand = page.getByRole("option", { name: /^\/compare/ });
  await composer.getByRole("button", { name: "选择模型和运行时" }).click();
  const models = page.getByRole("dialog", { name: "选择模型和运行时" });
  await models
    .getByRole("button", { name: "GPT Review", exact: true })
    .press("ArrowRight");
  await models.getByRole("radio", { name: "高", exact: true }).click();
  await expect(textbox).toBeFocused();
  await expect(topicMode).toHaveAttribute("aria-pressed", "false");
  await expect(compare).toHaveCount(0);
  await textbox.fill("、compare");
  await expect(compareCommand).toBeVisible();
  await textbox.press("Enter");
  await expect(textbox).toHaveText("");
  await expect(topicMode).toHaveAttribute("aria-pressed", "true");
  await expect(compare).toHaveAttribute("aria-pressed", "true");
  await expect(picker).toBeVisible();
  await expect(composer.getByText("至少选择两位 Agent")).toHaveCount(0);
  await compare.click();
  await expect(compare).toHaveCount(0);
  await expect(addAgents).toHaveCount(0);
  await expect(topicMode).toHaveAttribute("aria-pressed", "true");
  await expect(textbox).toBeFocused();
  await textbox.fill("/compare");
  await compareCommand.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  const prompt = `比较工作区方案 ${suffix}`;
  await textbox.fill(prompt);
  await expect(
    composer.getByRole("button", { name: "发送给 1 位 Agent" }),
  ).toBeDisabled();
  await addAgents.click();
  await picker.getByRole("checkbox", { name: reviewer, exact: false }).click();
  await picker.getByRole("checkbox", { name: designer, exact: false }).click();
  await page.keyboard.press("Escape");
  const labels = [
    "Codex · GPT Review · 推理强度 高",
    "Claude Code · Claude Sonnet · 推理强度 最大",
    "Codex · GPT Test · 推理强度 低",
  ];
  for (const label of labels)
    await expect(composer.getByText(label, { exact: true })).toBeVisible();
  const modelLabel = (name: string) => `为 ${name} 选择模型`;
  await composer.getByRole("button", { name: modelLabel(designer) }).click();
  const designerModels = page.getByRole("dialog", {
    name: modelLabel(designer),
  });
  await designerModels
    .getByRole("button", { name: "GPT Review", exact: true })
    .click();
  await designerModels
    .getByRole("radio", { name: "更高", exact: true })
    .click();
  labels[2] = "Codex · GPT Review · 推理强度 更高";
  await expect(
    composer.getByRole("button", { name: modelLabel(designer) }),
  ).toContainText(labels[2]);
  await expect(composer.getByText("每位 Agent 使用自己的 Profile")).toHaveCount(
    0,
  );
  await composer.screenshot({
    path: testInfo.outputPath("comparison-composer.png"),
    animations: "disabled",
  });
  const submissions: ComparisonInput[] = [];
  await page.route("**/api/comparisons", async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) return route.abort();
    if (submissions.length === 2) {
      // The backend accepted the edited comparison, but the composer lost its response.
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort();
    } else await route.continue();
  });
  const submit = composer.getByRole("button", { name: "发送给 3 位 Agent" });
  await submit.click();
  await expect(composer.getByRole("alert")).toBeVisible();
  await composer.getByRole("button", { name: modelLabel(reviewer) }).click();
  const reviewerModels = page.getByRole("dialog", {
    name: modelLabel(reviewer),
  });
  await reviewerModels
    .getByRole("radio", { name: "Codex", exact: true })
    .click();
  await reviewerModels
    .getByRole("button", { name: "GPT Test", exact: true })
    .click();
  await reviewerModels.getByRole("radio", { name: "中", exact: true }).click();
  labels[1] = "Codex · GPT Test · 推理强度 中";
  await expect(
    composer.getByRole("button", { name: modelLabel(reviewer) }),
  ).toContainText(labels[1]);
  await submit.click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect(composer.getByRole("alert")).toBeVisible();
  await page.reload();
  await textbox.click();
  for (const label of labels)
    await expect(composer.getByText(label, { exact: true })).toBeVisible();
  await submit.click();

  const comparison = page.getByRole("region", {
    name: "回复对比",
    exact: true,
  });
  await expect(comparison).toHaveCount(1);
  await expect(comparison).toContainText("3 / 3 已完成");
  expect(submissions).toHaveLength(3);
  expect(submissions[1].commandId).not.toBe(submissions[0].commandId);
  expect(submissions[2]).toEqual(submissions[1]);
  const { agentIds, selections } = submissions[1];
  expect(agentIds.map((id) => selections?.[id])).toMatchObject([
    { provider: "codex", model: "gpt-review", effort: "high" },
    { provider: "codex", model: "gpt-test", effort: "medium" },
    { provider: "codex", model: "gpt-review", effort: "xhigh" },
  ]);
  await expect(comparison.getByRole("tab")).toHaveCount(3);
  await comparison.getByRole("tab", { name: designer }).click();
  await expect(comparison.getByRole("tab", { name: designer })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(comparison.getByRole("tabpanel")).toContainText(
    `Profile for ${designer}`,
  );
  await expect(comparison.getByRole("tabpanel")).toContainText(labels[2]);
  await comparison.screenshot({
    path: testInfo.outputPath("comparison-tabs.png"),
    animations: "disabled",
  });
  const scroll = page.locator(".chat-panel:visible .chat-scroll");
  const gapToEnd = () =>
    scroll.evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    );
  await scroll.hover();
  await page.mouse.wheel(0, 20000);
  await expect.poll(gapToEnd).toBeLessThanOrEqual(1);
  await comparison.getByRole("radio", { name: "表格", exact: true }).click();
  await expect.poll(gapToEnd).toBeLessThanOrEqual(1);
  await expect(
    comparison.getByRole("radio", { name: "表格", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  const table = comparison.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(4);
  const columns = comparison.getByRole("radio", { name: "分列对比" });
  await columns.click();
  const names = [owner, reviewer, designer];
  for (const [index, name] of names.entries()) {
    await expect(table.getByRole("columnheader").nth(index)).toContainText(
      name,
    );
    await expect(table.getByRole("cell").nth(index)).toContainText(
      `Profile for ${name}`,
    );
  }
  await page.reload();
  await expect(columns).toHaveAttribute("aria-checked", "true");
  await comparison.getByRole("radio", { name: "表格", exact: true }).click();
  for (const label of labels)
    await expect(
      table.getByRole("rowheader").getByText(label, { exact: true }),
    ).toHaveCount(1);
  await comparison.getByRole("radio", { name: "标签页", exact: true }).click();
  await expect.poll(gapToEnd).toBeLessThanOrEqual(1);
  await comparison.getByRole("radio", { name: "表格", exact: true }).click();
  await expect.poll(gapToEnd).toBeLessThanOrEqual(1);
  await scroll.evaluate((node) => {
    node.scrollTop = 300;
  });
  await comparison.getByRole("radio", { name: "标签页", exact: true }).click();
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .toBeCloseTo(300, 0);
  await comparison.getByRole("radio", { name: "表格", exact: true }).click();
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .toBeCloseTo(300, 0);
  await expect(
    table.getByText(`Profile for ${owner}`, { exact: false }),
  ).toBeVisible();
  await comparison.screenshot({
    path: testInfo.outputPath("comparison-table.png"),
    animations: "disabled",
  });
  await table
    .getByRole("button", { name: `在 ${reviewer} 的话题中继续` })
    .click();

  const topic = page.locator(".topic-conversation:visible");
  await expect(topic).toContainText(prompt);
  const topicComposer = topic.locator(".topic-composer-wrap");
  await topicComposer.getByRole("textbox").fill(`继续审阅 ${suffix}`);
  await topicComposer
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(
    topic.locator('.run-content[data-status="completed"]'),
  ).toHaveCount(2);
  await topic
    .getByRole("button", { name: "返回回复对比", exact: true })
    .click();
  await expect(comparison).toBeVisible();
  const reviewerTopic = page.locator(
    `#agent-sidebar [data-agent-id="${agentIds[1]}"] .agent-activity-item`,
  );
  await reviewerTopic.click({ button: "right" });
  await page.getByRole("menuitem", { name: "在另一栏打开" }).click();
  await expect(topic).toContainText(prompt);
  await reviewerTopic.click({ button: "right" });
  await page.getByRole("menuitem", { name: "返回回复对比" }).click();
  await expect(comparison).toBeVisible();
  await page.reload();
  await expect(comparison).toContainText("3 / 3 已完成");
  await expect(table.getByRole("row")).toHaveCount(4);
  await comparison.getByRole("radio", { name: "标签页", exact: true }).click();
  await expect(comparison.getByRole("tab")).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator('button[aria-controls="agent-sidebar"]:visible');
  if ((await sidebar.getAttribute("aria-expanded")) === "true")
    await sidebar.click();
  await expect
    .poll(() =>
      page
        .locator("#agent-sidebar")
        .evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBeLessThan(1);
  await comparison.getByRole("radio", { name: "表格", exact: true }).click();
  await expect(table.getByRole("rowheader")).toHaveCount(3);
  const fits = await table.evaluate(
    (node) => node.scrollWidth <= node.clientWidth,
  );
  expect(fits).toBe(true);
  await columns.click();
  const columnScroll = comparison.getByRole("region", { name: "分列对比" });
  expect(
    await columnScroll.evaluate((node) => {
      node.scrollLeft = node.scrollWidth;
      return (
        node.scrollLeft > 0 &&
        node.clientWidth <= document.documentElement.clientWidth
      );
    }),
  ).toBe(true);
  await expect(table.getByRole("columnheader").last()).toContainText(designer);
  await comparison.getByRole("radio", { name: "表格", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    comparison.getByRole("radio", { name: "表格", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("comparison-narrow.png"),
    animations: "disabled",
  });
  await textbox.fill("/compare");
  await textbox.press("Enter");
  await picker.getByRole("checkbox", { name: reviewer, exact: false }).click();
  await picker.getByRole("checkbox", { name: designer, exact: false }).click();
  await page.keyboard.press("Escape");
  await expect(compare).toBeInViewport();
  await expect(addAgents).toBeInViewport();
  await expect(
    composer.getByRole("button", { name: modelLabel(reviewer) }),
  ).toContainText("Claude Sonnet");
  await expect(
    composer.getByRole("button", { name: modelLabel(designer) }),
  ).toContainText("GPT Test");
  await composer.screenshot({
    path: testInfo.outputPath("comparison-composer-narrow.png"),
    animations: "disabled",
  });
  await page.route("**/api/comparisons/*", async (route) => {
    const response = await route.fetch();
    const results: ComparisonResult[] = await response.json();
    const [thinking, finished] = results;
    thinking.run = {
      ...thinking.run,
      status: "running",
      items: [],
      finishedAt: undefined,
    };
    finished.run.items.unshift({
      id: "progress",
      kind: "text",
      title: "",
      text: "正在核对接口。",
      status: "completed",
    });
    await route.fulfill({ response, json: results });
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.reload();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await columns.click();
  const replies = table.getByRole("cell");
  await expect(
    replies.nth(0).getByText("正在思考", { exact: true }),
  ).toBeVisible();
  await expect(replies.nth(0).getByText("暂无回复")).toHaveCount(0);
  const finished = replies.nth(1);
  await expect(finished).toContainText(`Profile for ${reviewer}`);
  await expect(finished.getByText("正在核对接口。")).toBeHidden();
  await finished.getByRole("button", { name: /^用时/ }).click();
  await expect(finished.getByText("正在核对接口。")).toBeVisible();
});

test("opening a local comparison Topic from the sidebar reveals the comparison", async ({
  page,
}) => {
  const reviewerName = "对比定位审阅者";
  const ownerName = "对比定位发起者";
  await createAgent(page, reviewerName);
  await createAgent(page, ownerName);
  await send(page, "开始对比会话");
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const owner = overview.agents.find(({ name }) => name === ownerName)!;
  const reviewer = overview.agents.find(({ name }) => name === reviewerName)!;
  const chat = overview.chats.find(({ agentId }) => agentId === owner.id)!;
  const prompt = "比较两个回复";
  const response = await page.request.post("/api/comparisons", {
    data: {
      commandId: randomUUID(),
      chatId: chat.id,
      agentIds: [owner.id, reviewer.id],
      text: prompt,
    },
  });
  expect(response.ok()).toBe(true);
  const { id, sessionIds }: Comparison = await response.json();
  const comparison = page
    .locator(`.tab-panel[data-pane="main"] [data-comparison-id="${id}"]`)
    .getByRole("heading", { name: "回复对比", exact: true });
  await expect(comparison).toBeInViewport();
  await send(
    page,
    Array.from({ length: 32 }, (_, index) => `后续记录 ${index + 1}`).join(
      "\n\n",
    ),
  );
  await expect(comparison).not.toBeInViewport();

  await page
    .locator(`#agent-sidebar [data-session-id="${sessionIds[0]}"]`)
    .click();
  const topic = page.locator(
    '.tab-panel[data-pane="side"] .topic-conversation',
  );
  await expect(topic.locator(".user-message")).toContainText(prompt);
  await expect(comparison).toBeInViewport();
  await expect(topic.getByRole("textbox", { name: "回复话题" })).toBeFocused();
});

test("draft and sent file references open Files opposite the Chat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 900 });
  await createAgent(page, "文件引用 Agent");
  const main = page.locator('.tab-strip[data-pane="main"]');
  const side = page.locator('.tab-strip[data-pane="side"]');
  const mainPanel = page.locator('.tab-panel[data-pane="main"]:visible');
  const sidePanel = page.locator('.tab-panel[data-pane="side"]:visible');
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  const fileName = "hello.go";

  await input.fill("检查 @hello");
  await page.getByRole("option", { name: fileName, exact: true }).click();
  await input.getByRole("button", { name: fileName, exact: true }).click();
  const sideFile = side.getByRole("tab", { name: fileName, selected: true });
  await expect(sideFile).toBeVisible();
  await expect(sidePanel.locator(".monaco-editor")).toContainText(
    "package hello",
  );
  await expect(input).toHaveText("检查 hello.go");
  await expect(page.locator(".user-message")).toHaveCount(0);

  await send(page);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const agent = overview.agents.find(({ name }) => name === "文件引用 Agent")!;
  const updated = await page.request.put(`/api/agents/${agent.id}`, {
    data: {
      ...agent,
      profile: {
        ...agent.profile,
        roots: agent.profile.roots.map((root) => ({
          ...root,
          path: context().otherScope,
        })),
      },
    },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  await page.reload();
  const sentReference = page.locator(".user-message").getByRole("button", {
    name: fileName,
    exact: true,
  });
  const scopedFile = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/file") && url.searchParams.has("sessionId");
  });
  await sentReference.press("Enter");
  expect((await scopedFile).ok()).toBe(true);
  await expect(sideFile).toBeVisible();
  await expect(sidePanel.locator(".monaco-editor")).toContainText(
    "package hello",
  );

  await main.getByRole("tab", { selected: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "移动到右侧面板" }).click();
  await expect(sidePanel.locator(".user-message")).toBeVisible();
  await sentReference.click();
  await expect(
    main.getByRole("tab", { name: fileName, selected: true }),
  ).toBeVisible();
  await expect(mainPanel.locator(".monaco-editor")).toContainText(
    "package hello",
  );
  await expect(sidePanel.locator(".user-message")).toBeVisible();
});

test("chat previews HTML inline, resolves report images and copies the actual file path", async ({
  page,
}) => {
  const { scope } = context();
  const report = "Inline report.html";
  const image = "inline screen.png";
  const html =
    '<h1>对照报告</h1><a href="inline%20screen.png" aria-label="查看原图"><img alt="截图" src="inline%20screen.png"></a>';
  const path = join(realpathSync(scope), report);
  writeFileSync(path, html);
  writeFileSync(
    join(scope, image),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+w2S8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await createAgent(page, "内嵌报告 Agent");
  const composer = page.locator(".chat-composer-wrap");
  await composer.getByLabel("选择附件", { exact: true }).setInputFiles(path);
  await expect(
    composer.getByRole("button", { name: report, exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(composer.locator("iframe")).toHaveCount(0);
  await page.route(
    "**/api/messages",
    async (route) => {
      const response = await route.fetch({
        postData: {
          ...route.request().postDataJSON(),
          text: `请查看[工作区报告](${encodeURIComponent(report)})。`,
        },
      });
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await send(page, "查看报告");
  const turn = page.locator(".run-content").last();
  const response = turn.locator(".chat-response");
  const link = response.getByRole("link", { name: "工作区报告" });
  const panel = response.getByRole("region", { name: report, exact: true });
  await expect(link).toHaveAttribute("aria-expanded", "false");
  await expect(response.locator("iframe")).toHaveCount(0);
  await link.press("Enter");
  await expect(link).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: report })).toHaveCount(0);
  const frame = panel.frameLocator("iframe");
  await expect
    .poll(() =>
      frame
        .getByAltText("截图")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  await frame.getByRole("link", { name: "查看原图" }).click();
  await expect(frame.locator("img")).toBeVisible();
  await panel.getByRole("button", { name: "复制绝对路径" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied", path);
  await panel.getByRole("button", { name: "收起预览" }).click();
  await expect(link).toBeFocused();
  await expect(response.locator("iframe")).toHaveCount(0);
  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "在聊天中预览" }).click();
  await expect(frame.getByRole("heading", { name: "对照报告" })).toBeVisible();
  await link.click();
  await expect(panel).toHaveCount(0);

  const prompt = turn.locator(".user-message");
  const attachment = prompt.getByRole("button", { name: report, exact: true });
  const uploaded = prompt.getByRole("region", { name: report, exact: true });
  await expect(attachment).toHaveAttribute("aria-expanded", "true");
  const uploadedFrame = uploaded.frameLocator("iframe");
  await expect(
    uploadedFrame.getByRole("heading", { name: "对照报告" }),
  ).toBeVisible();
  await expect(uploadedFrame.getByAltText("截图")).toHaveAttribute(
    "src",
    "inline%20screen.png",
  );
  await expect(uploaded.getByRole("note")).toContainText("未随文件上传的图片");
  await expect(prompt.getByRole("link", { name: "下载文件" })).toHaveAttribute(
    "download",
    report,
  );
  await uploaded.getByRole("button", { name: "复制绝对路径" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied",
    /[/\\]attachments[/\\][\w-]+[/\\]Inline report\.html$/,
  );
  await uploaded.getByRole("button", { name: "收起预览" }).click();
  await expect(attachment).toBeFocused();
  await expect(uploaded).toHaveCount(0);
});

test("chat HTML links preview in Lever and hand off the original file", async ({
  page,
  browser,
}) => {
  const { url, scope } = context();
  const name = "Preview #1.html";
  const path = join(realpathSync(scope), name);
  writeFileSync(
    path,
    '<button id="notes" onclick="this.textContent=\'OK\'">Try</button>',
  );
  await createAgent(page, "HTML 预览 Agent");
  const sent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/messages") &&
      response.request().method() === "POST",
  );
  await send(page, "准备预览");
  const run: Run = await (await sent).json();
  const preview = new URL(`/api/runs/${run.id}/preview`, url);
  preview.search = new URLSearchParams({ kind: "html", path }).toString();
  const section = new URL(preview);
  section.hash = "notes";
  const message = await page.request.post("/api/messages", {
    data: {
      operation: "main",
      chatId: run.chatId,
      commandId: randomUUID(),
      text: [
        `[产物](${encodeURIComponent(name)})`,
        `[粘贴的预览链接](${preview.href})`,
        `[指定章节](${section.href})`,
        "[外部网页](https://example.test/foreign.html)",
        "```md\n[示例](example-only.html)\n```",
        `\uE200visualize\uE202${JSON.stringify({ path, title: "内嵌图表" })}\uE201`,
      ].join("\n\n"),
    },
  });
  expect(message.ok()).toBeTruthy();
  const reply: Run = await message.json();
  const turn = page.locator(`[data-run-id="${reply.id}"]`);
  await expect(turn).toHaveAttribute("data-status", "completed");
  const replyLink = turn
    .locator(".chat-response")
    .getByRole("link", { name: "产物", exact: true });
  const pasted = turn
    .locator(".user-message")
    .getByRole("link", { name: "粘贴的预览链接" });
  await expect(replyLink).toHaveAttribute("aria-expanded", "true");
  await expect(pasted).toHaveAttribute("aria-expanded", "true");
  const prompt = turn.locator(".user-message");
  const jump = prompt.getByRole("link", { name: "指定章节" });
  await expect(jump).toHaveAttribute("aria-expanded", "false");
  const previewId = await pasted.getAttribute("aria-controls");
  const pastedPanel = prompt.locator(`[id="${previewId}"]`);
  await expect(
    pastedPanel.frameLocator("iframe").getByRole("button", { name: "Try" }),
  ).toBeVisible();
  await expect(
    turn.locator(
      'iframe[src$="#notes"], iframe[src*="foreign.html"], iframe[src*="example-only.html"]',
    ),
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pastedPanel.getByRole("button", { name: "收起预览" }).click();
  await expect(pasted).toBeFocused();
  await expect(pasted).toHaveAttribute("aria-expanded", "false");
  await expect(pastedPanel).toHaveCount(0);
  await jump.click();
  await expect(
    prompt
      .frameLocator('iframe[src$="#notes"]')
      .getByRole("button", { name: "Try" }),
  ).toBeVisible();
  await jump.click();
  await expect(prompt.locator('iframe[src$="#notes"]')).toHaveCount(0);
  const inline = turn.locator(".chat-visualization");
  await expect(inline.locator("iframe")).toHaveAttribute("title", "内嵌图表");
  await expect(
    inline.getByRole("button", { name: "复制绝对路径" }),
  ).toBeVisible();
  const quick = inline.getByRole("button", { name: "快速预览" });
  await quick.press("Enter");
  const expanded = page.getByRole("dialog", { name: "内嵌图表" });
  await expect(
    expanded.frameLocator("iframe").getByRole("button", { name: "Try" }),
  ).toBeVisible();
  await expect(expanded.getByRole("button", { name: "快速预览" })).toHaveCount(
    0,
  );
  await expanded.press("Escape");
  await expect(quick).toBeFocused();
  const replyPreviewId = await replyLink.getAttribute("aria-controls");
  await turn
    .locator(`[id="${replyPreviewId}"]`)
    .getByRole("button", { name: "在网页标签中打开" })
    .click();
  const panel = page.getByRole("tabpanel", { name, exact: true });
  await expect(panel).toHaveAttribute("data-pane", "side");
  await expect(pasted).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await jump.click({ button: "right" });
  await page.getByRole("menuitem", { name: "在网页标签中打开" }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(1);
  await expect(panel.locator("iframe")).toHaveAttribute("src", /#notes$/);
  await expect(panel.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await panel
    .frameLocator("iframe")
    .getByRole("button", { name: "Try" })
    .click();
  await expect(
    panel.frameLocator("iframe").getByRole("button", { name: "OK" }),
  ).toBeVisible();

  await pasted.click({ button: "right" });
  await page.getByRole("menuitem", { name: "快速预览" }).click();
  const dialog = page.getByRole("dialog", { name });
  await expect(
    dialog.frameLocator("iframe").getByRole("button", { name: "Try" }),
  ).toBeVisible();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /Finder|文件管理器/ }),
  ).toHaveCount(0);
  const downloading = page.waitForEvent("download");
  await panel.getByRole("button", { name: "下载原始 HTML 文件" }).click();
  const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(name);
  expect(readFileSync((await downloaded.path())!)).toEqual(readFileSync(path));
  expect(page.context().pages()).toHaveLength(1);
  const unpaired = await browser.newContext({ locale: "zh-CN" });
  try {
    const viewer = await unpaired.newPage();
    await viewer.goto(section.href.replace("/api/", "/view/"));
    await expect(viewer.getByRole("alert")).toContainText("尚未与 Lever 配对");
    await expect(viewer.locator("iframe")).toHaveCount(0);
    const pairing = await unpaired.newPage();
    await pairing.goto(url);
    await expect(pairing).not.toHaveURL(/#token=/);
    await viewer.getByRole("button", { name: "重试" }).click();
    await expect(
      viewer.frameLocator("iframe").getByRole("button", { name: "Try" }),
    ).toBeVisible();
  } finally {
    await unpaired.close();
  }
  await page.evaluate(() => {
    Reflect.set(window, "mygo", {
      platform: "darwin",
      callWith(method: string, args: unknown[]) {
        if (method === "Dialogs.OpenPreviewInBrowser")
          document.body.dataset.openedHtml = JSON.stringify(args);
        if (method === "Dialogs.ShowItemInFolder")
          document.body.dataset.revealedHtml = JSON.stringify(args);
        return Promise.resolve();
      },
    });
  });
  await jump.click();
  const jumpPreviewId = await jump.getAttribute("aria-controls");
  const header = prompt.locator(`[id="${jumpPreviewId}"] header`);
  const external = header.getByRole("button", { name: "在系统浏览器中打开" });
  await expect(external).toBeEnabled();
  expect(
    await header
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
  ).toEqual([
    "刷新",
    "快速预览",
    "在网页标签中打开",
    "在系统浏览器中打开",
    "复制绝对路径",
    "在 Finder 中显示",
    "收起预览",
  ]);
  await header.getByRole("button", { name: "快速预览" }).hover();
  await expect(page.getByRole("tooltip", { name: "快速预览" })).toBeVisible();
  await prompt.locator(`[id="${jumpPreviewId}"]`).evaluate((element) => {
    element.style.width = "200px";
  });
  expect(
    await header.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await external.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-opened-html",
    JSON.stringify([path, "#notes"]),
  );
  await header.getByRole("button", { name: "在 Finder 中显示" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-revealed-html",
    JSON.stringify([path]),
  );
  expect(page.context().pages()).toHaveLength(1);
});

test("chat file links open in the side pane at the cited line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 900 });
  const { scope, url } = context();
  await createAgent(page, "文件链接 Agent");
  const origin = new URL(url).origin;
  const path = pathToFileURL(
    join(realpathSync(scope), ".agents/skills/fixture-review/SKILL.md"),
  ).pathname;
  const reply = [
    `[技能第 5 行](${origin}${path}:5)`,
    "[技能第 2 行](.agents/skills/fixture-review/SKILL.md:2)",
    "[Go 文件第 3 行](hello.go:3)",
    `[外部网页](https://example.com${path}:5)`,
  ].join("\n\n");
  await page.route(
    "**/api/messages",
    async (route) => {
      const response = await route.fetch({
        postData: { ...route.request().postDataJSON(), text: reply },
      });
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await send(page, "打开技能文件");

  const chat = page.locator(".chat-response");
  const external = chat.getByRole("link", { name: "外部网页" });
  await expect(external).toHaveAttribute(
    "href",
    `https://example.com${path}:5`,
  );
  await expect(external).toHaveAttribute("target", "_blank");

  const appURL = page.url();
  const side = page.locator('.tab-strip[data-pane="side"]');
  const tab = side.getByRole("tab", { name: "SKILL.md", exact: true });
  const panel = page.locator('.tab-panel[data-pane="side"]:visible');
  const directory = panel.getByRole("complementary", { name: "文件目录" });
  const showDirectory = panel.getByRole("button", {
    name: "显示文件目录",
    exact: true,
  });
  const editor = panel.locator(".monaco-editor");
  const line = editor.locator(".line-numbers.active-line-number");
  await chat.getByRole("link", { name: "技能第 5 行" }).click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(editor).toContainText("Review carefully.");
  await expect(showDirectory).toBeVisible();
  await expect(line).toHaveText("5");
  await expect(page).toHaveURL(appURL);
  expect(page.context().pages()).toHaveLength(1);

  await page.keyboard.press("ArrowUp");
  await expect(line).toHaveText("4");
  await chat.getByRole("link", { name: "技能第 5 行" }).click();
  await expect(line).toHaveText("5");

  await chat.getByRole("link", { name: "技能第 2 行" }).press("Enter");
  await expect(line).toHaveText("2");
  await expect(tab).toHaveCount(1);

  await showDirectory.click();
  await expect(directory).toBeVisible();
  await expect(editor).toBeVisible();

  await chat.getByRole("link", { name: "Go 文件第 3 行" }).click();
  await expect(
    side.getByRole("tab", { name: "hello.go", selected: true }),
  ).toBeVisible();
  await expect(line).toHaveText("3");
  await expect(showDirectory).toBeVisible();
  await tab.click();
  await expect(directory).toBeVisible();
});

test("Files opens the directory by default when its pane is wide enough", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("lever:files:sidebar", "false");
  });
  await createAgent(page, "文件目录默认展开");
  const main = page.locator('.tab-strip[data-pane="main"]');
  const openFiles = main.getByRole("button", { name: "文件", exact: true });
  await openFiles.click();

  const files = page.getByRole("tabpanel", { name: "文件", exact: true });
  const directory = files.getByRole("complementary", { name: "文件目录" });
  const file = directory.getByRole("treeitem", {
    name: "hello.go",
    exact: true,
  });
  const editor = files.locator(".monaco-editor");
  const showDirectory = files.getByRole("button", { name: "显示文件目录" });
  const hideDirectory = files.getByRole("button", { name: "隐藏文件目录" });
  await expect(directory).toBeVisible();
  await expect(file.locator('svg[data-icon-token="go"]')).toBeVisible();
  await file.click();
  await expect(editor).toBeVisible();
  await expect(directory).toBeVisible();
  expect((await editor.boundingBox())!.x).toBeLessThan((await directory.boundingBox())!.x);

  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置", exact: true }).click();
  const divider = page.getByRole("separator", { name: "调整分区宽度" });
  await divider.press("Home");
  await expect(directory).toBeHidden();
  await expect(editor).toBeVisible();
  await showDirectory.click();
  await expect(directory).toBeVisible();
  await expect(editor).toBeHidden();
  await file.click();
  await expect(directory).toBeHidden();
  await expect(editor).toBeVisible();

  await divider.press("End");
  await expect(directory).toBeVisible();
  await expect(editor).toBeVisible();
  await hideDirectory.click();
  await expect(directory).toBeHidden();
  await page.getByRole("button", { name: "收起侧边分栏", exact: true }).click();
  await closeTab(main.getByRole("tab", { name: "文件", exact: true }));
  await openFiles.click();
  await expect(directory).toBeVisible();
});

test("Files dims Git-ignored entries and refreshes their status", async ({
  page,
}) => {
  const root = mkdtempSync(
    join(dirname(context().scope), "ignored-workspace-"),
  );
  const ignore = join(root, ".gitignore");
  try {
    mkdirSync(join(root, "build cache"));
    mkdirSync(join(root, "source"));
    writeFileSync(ignore, "/build cache/\n*.log\n");
    writeFileSync(join(root, "build cache", "report.md"), "# Ignored report\n");
    writeFileSync(join(root, "source", "trace.log"), "ignored log\n");
    execFileSync("git", ["-C", root, "init", "-q"]);
    await page.emulateMedia({ colorScheme: "light" });
    await createAgent(page, "Git 忽略样式", root);
    await page.getByRole("button", { name: "文件", exact: true }).click();

    const directory = page.getByRole("complementary", { name: "文件目录" });
    const ignored = directory.getByRole("treeitem", { name: "build cache" });
    const source = directory.getByRole("treeitem", { name: "source" });
    const labelColor = (item: Locator) =>
      item
        .locator('[data-item-section="content"]')
        .evaluate((element) => getComputedStyle(element).color);
    await expect(ignored).toHaveAttribute("data-item-git-status", "ignored");
    expect(await labelColor(ignored)).not.toBe(await labelColor(source));
    await source.click();
    await expect(
      directory.getByRole("treeitem", { name: "trace.log" }),
    ).toHaveAttribute("data-item-git-status", "ignored");
    await expect(source).not.toHaveAttribute("data-item-git-status", "ignored");
    await expect(source.locator('[data-item-section="git"]')).toBeHidden();

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await labelColor(ignored)).not.toBe(await labelColor(source));
    await ignored.press("ArrowRight");
    const report = directory.getByRole("treeitem", { name: "report.md" });
    await expect(report).toHaveAttribute("data-item-git-status", "ignored");
    await report.click();
    await expect(
      page.getByRole("heading", { name: "Ignored report" }),
    ).toBeVisible();

    writeFileSync(ignore, "*.log\n");
    await directory.getByRole("button", { name: "刷新目录" }).click();
    await expect.poll(() => labelColor(ignored)).toBe(await labelColor(source));
    await expect(report).not.toHaveAttribute("data-item-git-status", "ignored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop shortcuts follow the active pane and saved bindings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "mygo", {
      value: {
        platform: "darwin",
        locale: "zh-CN",
        call: async () => undefined,
        on: () => () => {},
      },
    });
  });
  await createAgent(page, "快捷键 Agent");
  const search = page.getByRole("dialog", { name: "搜索 Lever" });
  const searchInput = search.getByRole("combobox", { name: "搜索 Lever" });
  const allResults = search.getByRole("radio", { name: "全部", exact: true });
  const chatResults = search.getByRole("radio", { name: "对话", exact: true });
  const fileResults = search.getByRole("radio", { name: "文件", exact: true });
  await page.keyboard.press("Meta+p");
  await expect(chatResults).toBeChecked();
  await expect(searchInput).toBeFocused();
  await page.keyboard.press("Escape");
  await send(page, "快捷键验证");

  const main = page.locator('.tab-strip[data-pane="main"]');
  const side = page.locator('.tab-strip[data-pane="side"]');
  const chat = main.getByRole("tab");
  await expect(chat).toHaveCount(1);
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "文件", exact: true }).click();
  const file = side.getByRole("tab", { name: "文件", exact: true });
  await expect(file).toBeVisible();
  await page.getByRole("treeitem", { name: "hello.go", exact: true }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await page.keyboard.press("Meta+p");
  await expect(fileResults).toBeChecked();
  await searchInput.fill("docs/design notes");
  const match = search.getByRole("option", { name: /design notes\.md/ });
  await expect(match).toBeVisible();
  await allResults.click();
  await expect(searchInput).toHaveValue("docs/design notes");
  await expect(match).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await expect(allResults).toBeChecked();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+p");
  await expect(fileResults).toBeChecked();
  await searchInput.fill("design notes");
  await expect(match).toBeVisible();
  await searchInput.press("Enter");
  const opened = side.getByRole("tab", {
    name: "design notes.md",
    exact: true,
  });
  await expect(opened).toBeFocused();
  await page.keyboard.press("Meta+w");
  await expect(file).toBeFocused();

  await page.keyboard.press("Meta+f");
  await expect(
    page.locator(".monaco-editor .find-widget.visible"),
  ).toBeVisible();
  await page.keyboard.press("Meta+w");
  await expect(file).toHaveCount(0);
  await expect(chat).toBeFocused();
  await page.keyboard.press("Meta+w");
  await expect(chat).toHaveCount(0);
  await page.keyboard.press("Meta+w");
  await expect(
    page.getByRole("heading", { name: "最近会话", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Meta+Shift+t");
  await expect(chat).toBeVisible();
  await page.keyboard.press("Meta+Shift+t");
  await expect(file).toBeFocused();
  await chat.click();
  const chatTitle = (await chat.innerText()).trim();
  await page.keyboard.press("Meta+p");
  await expect(chatResults).toBeChecked();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+f");
  await expect(
    search.getByRole("button", { name: "搜索范围", exact: true }),
  ).toContainText(chatTitle);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+n");
  await expect(main.getByRole("tab")).toHaveCount(2);
  const first = main.getByRole("tab").first();
  await page.keyboard.press("Meta+1");
  await expect(first).toBeFocused();
  await page.keyboard.press("Meta+Shift+]");
  await expect(main.getByRole("tab").last()).toBeFocused();

  await page.keyboard.press("Meta+,");
  await page.keyboard.press("Meta+p");
  await expect(allResults).toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "键盘快捷键", exact: true }).click();
  const searchBinding = page.getByRole("button", {
    name: /修改「搜索 Lever」/,
  });
  await searchBinding.click();
  await page.keyboard.press("Meta+n");
  await expect(page.getByRole("alert")).toContainText("新建对话");
  await page.keyboard.press("Meta+s");
  await expect(page.getByRole("alert")).toContainText("已被保留");
  await page.keyboard.press("Meta+Shift+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(searchBinding).toContainText("⇧⌘K");

  await page.reload();
  await expect(
    page.locator("#agent-sidebar button[aria-keyshortcuts='Shift+Meta+k']"),
  ).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+k");
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "键盘快捷键", exact: true }).click();
  await searchBinding.click();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(searchBinding).toContainText("⌘K");

  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("lever:preferences")!);
    saved.shortcutOverrides.search = "meta+p";
    localStorage.setItem("lever:preferences", JSON.stringify(saved));
  });
  await page.reload();
  await expect(
    page.locator("#agent-sidebar button[aria-keyshortcuts='Meta+p']"),
  ).toBeVisible();
  await page.keyboard.press("Meta+p");
  await expect(allResults).toBeChecked();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+,");
  await page.getByRole("button", { name: "键盘快捷键", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /修改「按当前标签页搜索」/ }),
  ).toContainText("未设置");
});

test("sidebar search finds Agents, scoped Topics and historical message text", async ({
  page,
}) => {
  await createAgent(page, "搜索测试 Agent A");
  await send(page, "发布计划 A");
  await send(page, "正文检索专用内容");
  await send(page, "更新活动预览");
  await page.getByRole("button", { name: "话题", exact: true }).click();
  await send(page, "发布排查");
  await createAgent(page, "搜索测试 Agent B");
  await send(page, "发布计划 B");
  await page.getByRole("button", { name: "话题", exact: true }).click();
  await send(page, "发布排查");
  const agentId = await page.evaluate(() =>
    localStorage.getItem("lever:agent"),
  );
  const otherChat = await page.request.post("/api/chats", {
    data: { agentId, title: "发布补充计划" },
  });
  expect(otherChat.ok()).toBeTruthy();

  const search = page.getByRole("dialog", { name: "搜索 Lever" });
  const query = search.getByRole("combobox", {
    name: "搜索 Lever",
  });
  const scope = search.getByRole("button", { name: "搜索范围" });
  const options = search.getByRole("option");
  const chatSearch = page.getByRole("button", {
    name: "搜索当前 Agent",
    exact: true,
  });
  const sidebar = page.locator("#agent-sidebar");
  const sidebarSearch = sidebar.getByRole("button", {
    name: "搜索 Lever",
    exact: true,
  });
  const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));

  await expect(
    page.getByRole("button", { name: "搜索 Lever", exact: true }),
  ).toHaveCount(1);
  await expect(sidebarSearch.locator("kbd")).toHaveText(
    isMac ? "⌘K" : "Ctrl+K",
  );
  await expect(chatSearch).toHaveText("");
  await sidebarSearch.click();
  await expect(search.locator("[cmdk-group-heading]")).toHaveText([
    "话题",
    "对话",
    "Agent",
  ]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await search.getByRole("radio", { name: "Agent", exact: true }).click();
  await query.fill("搜索测试 Agent");
  await expect(options).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(sidebarSearch).toBeFocused();

  await expect(sidebar.getByRole("tab")).toHaveCount(2);
  for (const name of ["最近", "全部"]) {
    await sidebar.getByRole("tab", { name, exact: true }).click();
    await sidebarSearch.click();
    await expect(query).toBeFocused();
    await expect(scope).toHaveText("全部范围");
    await page.keyboard.press("Escape");
    await expect(sidebarSearch).toBeFocused();
  }

  await chatSearch.click();
  await expect(query).toBeFocused();
  await expect(scope).toHaveText("搜索测试 Agent B");
  await expect(options).toHaveCount(4);
  await expect(options.filter({ hasText: "发布补充计划" })).toBeVisible();
  await expect(options.filter({ hasText: "发布排查" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chatSearch).toBeFocused();

  await page.keyboard.press(isMac ? "Meta+k" : "Control+k");
  await expect(query).toHaveValue("");
  await expect(options.first()).toHaveAttribute("data-value", /^topic:/);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await query.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await query.fill("发布");
  await search.getByRole("radio", { name: "话题", exact: true }).click();
  await expect(options).toHaveCount(2);
  await scope.click();
  await page
    .getByRole("combobox", { name: "查找 Agent 或对话" })
    .fill("Agent A");
  await page
    .getByRole("option", { name: "搜索测试 Agent A", exact: true })
    .click();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("搜索测试 Agent A › 发布计划 A");
  await scope.click();
  await page
    .getByRole("combobox", { name: "查找 Agent 或对话" })
    .fill("发布计划 A");
  await page
    .getByRole("option", { name: "搜索测试 Agent A › 发布计划 A", exact: true })
    .click();
  await expect(scope).toHaveText("搜索测试 Agent A › 发布计划 A");
  await expect(options).toHaveCount(1);
  await query.press("Enter");
  await expect(search).not.toBeVisible();
  await expect(page.locator(".topic-conversation:visible")).toContainText(
    "发布排查",
  );
  await expect(
    page.getByRole("tab", { name: "发布计划 A", exact: true }),
  ).toBeVisible();
  const topic = page.locator(".topic-conversation:visible");
  const reply = topic.locator(".topic-composer-wrap");
  await reply
    .getByRole("textbox", { name: "回复话题", exact: true })
    .fill("话题回复正文");
  await reply.getByRole("button", { name: "发送", exact: true }).click();
  const replyTurn = topic
    .locator(".run-content")
    .filter({ hasText: "话题回复正文" });
  await expect(replyTurn).toHaveAttribute("data-status", "completed");
  await closeTopic(page);

  await chatSearch.click();
  await search.getByRole("radio", { name: "话题", exact: true }).click();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("发布排查");
  await expect(
    options.first().getByRole("img", { name: "有新结果待查看" }),
  ).toHaveCount(0);
  await search.getByRole("radio", { name: "对话", exact: true }).click();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("发布计划 A");
  await query.press("Enter");
  await expect(
    page.getByRole("tab", { name: "发布计划 A", exact: true }),
  ).toBeFocused();

  await sidebarSearch.click();
  const resultTypesGroup = search.getByRole("radiogroup", { name: "结果类型" });
  await resultTypesGroup.getByRole("radio", { name: "消息", exact: true }).click();
  const messageKinds = search.getByRole("radiogroup", { name: "消息类型" });
  const allMessages = messageKinds.getByRole("radio", {
    name: "全部",
    exact: true,
  });
  const mainMessages = messageKinds.getByRole("radio", {
    name: "主对话",
    exact: true,
  });
  await expect(allMessages).toBeChecked();
  await expect(
    options.filter({ hasText: "发布计划 A" }).filter({ hasText: "主对话" }),
  ).toBeVisible();
  await expect(options.filter({ hasText: "发布排查" }).first()).toBeVisible();
  await mainMessages.click();
  await expect(options.filter({ hasText: "发布计划 A" })).toHaveCount(1);
  await expect(options.filter({ hasText: "发布排查" })).toHaveCount(0);
  await messageKinds.getByRole("radio", { name: "对比", exact: true }).click();
  await expect(search.getByText("当前范围内暂无对比会话")).toBeVisible();
  await search.getByRole("button", { name: "查看全部消息", exact: true }).click();
  await expect(allMessages).toBeChecked();
  await expect(options.filter({ hasText: "发布排查" }).first()).toBeVisible();
  await query.fill("正文检索专用内容");
  await expect(options).toHaveCount(1);
  await messageKinds.getByRole("radio", { name: "话题", exact: true }).click();
  await expect(search.getByText("没有匹配的结果")).toBeVisible();
  await mainMessages.click();
  await expect(options).toHaveCount(1);
  await mainMessages.click();
  await expect(mainMessages).toBeChecked();
  await allMessages.click();
  await expect(allMessages).toBeChecked();
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("发布计划 A");
  await expect(options.first().locator("mark")).toHaveText("正文检索专用内容");
  await query.press("Enter");
  await expect(
    page.locator(".run-content:visible").filter({
      hasText: "正文检索专用内容",
    }),
  ).toBeFocused();

  await chatSearch.click();
  await query.fill("话题回复正文");
  await expect(options).toHaveCount(1);
  await query.press("Enter");
  await expect(replyTurn).toBeFocused();
  await closeTopic(page);

  await sidebarSearch.click();
  await search.getByRole("radio", { name: "Agent", exact: true }).click();
  await query.fill("搜索测试 Agent B");
  await expect(options).toHaveCount(1);
  await query.press("Enter");
  await expect(
    page.getByRole("tab", { name: "发布计划 B", exact: true }),
  ).toBeVisible();
});

test("workspace toolbar keeps chosen tools in the overflow menu", async ({
  page,
}) => {
  await createAgent(page, "工具栏收纳");
  const strip = page.locator('.tab-strip[data-pane="main"]');
  const toolbarButton = (name: string) =>
    strip.getByRole("button", { name, exact: true });
  const more = toolbarButton("更多工具");
  await expect(toolbarButton("文件")).toBeVisible();
  await expect(toolbarButton("变更")).toHaveCount(0);
  await expect(toolbarButton("浏览器")).toHaveCount(0);
  await expect(toolbarButton("配置")).toHaveCount(0);

  await openMoreTool(strip, "浏览器");
  await expect(
    strip.getByRole("tab", { name: "浏览器", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(more).toHaveClass(/bg-accent/);
  // The lazily loaded address field takes focus, which would dismiss a menu.
  await expect(page.getByLabel("输入网址或 localhost:端口")).toBeFocused();

  await more.click();
  await page
    .getByRole("menuitem", { name: "在工具栏显示" })
    .press("ArrowRight");
  const option = (name: string) =>
    page.getByRole("menuitemcheckbox", { name, exact: true });
  await expect(option("变更")).toHaveCount(0);
  await expect(option("浏览器")).toHaveAttribute("aria-checked", "false");
  await option("浏览器").press("Enter");
  await option("文件").press("Enter");
  await expect(option("浏览器")).toHaveAttribute("aria-checked", "true");
  await expect(option("文件")).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(toolbarButton("浏览器")).toBeVisible();
  await expect(toolbarButton("文件")).toHaveCount(0);

  await page.reload();
  await expect(toolbarButton("浏览器")).toBeVisible();
  await expect(toolbarButton("文件")).toHaveCount(0);
  await openMoreTool(strip, "文件");
  await expect(
    strip.getByRole("tab", { name: "文件", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("workspace Search stays in place and Diff uses Git directories in the Scope", async ({
  page,
}) => {
  const { scope, otherScope } = context();
  const gitRoots = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/git-roots"),
  );
  await createAgent(page, "页签栏测试", otherScope);
  expect(await (await gitRoots).json()).toEqual([]);

  await page.setViewportSize({ width: 920, height: 860 });
  const mainStrip = page.locator('.tab-strip[data-pane="main"]');
  const main = page.getByRole("tablist", { name: "Agent 工作区" });
  const searchButton = page.getByRole("button", {
    name: "搜索当前 Agent",
    exact: true,
  });
  const gitButton = page.getByRole("button", { name: "Git 状态", exact: true });
  await expect(searchButton).toBeVisible();
  await expect(gitButton).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "变更", exact: true }),
  ).toHaveCount(0);

  await send(page, "页签栏会话");
  const chat = main.getByRole("tab", { name: "页签栏会话", exact: true });
  const files = main.getByRole("tab", { name: "文件", exact: true });
  const profile = main.getByRole("tab", { name: "配置", exact: true });
  await mainStrip.getByRole("button", { name: "文件", exact: true }).click();
  await openMoreTool(mainStrip);
  await chat.click();
  const tabWidth = await chat.evaluate(
    (element) =>
      element.closest(".workspace-tab")!.getBoundingClientRect().width,
  );
  const searchPosition = (await searchButton.boundingBox())!.x;
  await files.click();
  expect(
    await chat.evaluate(
      (element) =>
        element.closest(".workspace-tab")!.getBoundingClientRect().width,
    ),
  ).toBe(tabWidth);
  await expect(searchButton).toBeVisible();
  expect((await searchButton.boundingBox())!.x).toBe(searchPosition);
  await searchButton.click();
  const search = page.getByRole("dialog", { name: "搜索 Lever" });
  await expect(search.getByRole("button", { name: "搜索范围" })).toHaveText(
    "页签栏测试",
  );
  await page.keyboard.press("Escape");
  await expect(searchButton).toBeFocused();

  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  const diffMenuItem = page.getByRole("menuitem", {
    name: "变更",
    exact: true,
  });
  await expect(diffMenuItem).toHaveCount(0);
  await page.getByRole("menuitem", { name: "终端", exact: true }).click();
  await page
    .locator('.tab-strip[data-pane="side"]')
    .getByRole("button", { name: "打开标签", exact: true })
    .click();
  await expect(diffMenuItem).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "最大化面板", exact: true }).click();
  await expect(searchButton).toBeVisible();
  await page.getByRole("button", { name: "还原面板大小", exact: true }).click();
  await page.getByRole("button", { name: "收起侧边分栏", exact: true }).click();

  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const agent = overview.agents.find((agent) => agent.name === "页签栏测试")!;
  const updateScope = async (
    current: Agent,
    roots: Agent["profile"]["roots"],
  ) => {
    const updated = await page.request.put(`/api/agents/${agent.id}`, {
      data: { ...current, profile: { ...current.profile, roots } },
    });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    return (await updated.json()) as Agent;
  };
  const withGit = await updateScope(agent, [
    ...agent.profile.roots,
    { id: "repo", path: scope },
    { id: "docs", path: join(scope, "docs") },
  ]);
  await gitButton.click();
  const workingDiff = page.waitForResponse((response) => {
    return response.url().includes(`/agents/${agent.id}/diff?`);
  });
  await page.locator(".git-status-popover .git-status-action-row").click();
  const response = await workingDiff;
  expect(new URL(response.url()).searchParams.get("root")).toBe("repo");
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.getByRole("menuitemradio")).toHaveText([
    "workspace",
    "docs",
  ]);
  await page.keyboard.press("Escape");

  await updateScope(withGit, agent.profile.roots);
  await expect(gitButton).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "当前工作范围没有 Git 仓库" }),
  ).toBeVisible();
  await profile.click();
  await expect(searchButton).toBeVisible();
});

test("Last Turn stays in its Chat and pins its patch until refresh", async ({
  page,
}) => {
  await createAgent(page, "本轮变更");
  const first = page.waitForResponse(
    (r) => r.url().endsWith("/api/messages") && r.request().method() === "POST",
  );
  await send(page, "[turn-diff:main.txt]");
  const main = (await (await first).json()) as Run;
  const topicMode = page.getByRole("button", { name: "话题", exact: true });
  await topicMode.click();
  await send(page, "[turn-diff:topic.txt]");

  const openLatest = async () => {
    await page.getByRole("button", { name: "Git 状态", exact: true }).click();
    await page.locator(".git-status-popover .git-status-action-row").click();
    await page.getByRole("button", { name: "变更范围" }).click();
    await page.getByRole("menuitemradio", { name: "最近一轮" }).click();
  };
  await openLatest();
  const file = (name: string) =>
    page.getByRole("treeitem", { name, exact: true });
  await expect(file("main.txt")).toBeVisible();
  await expect(file("topic.txt")).toHaveCount(0);
  await page.getByRole("button", { name: "变更范围" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "最近一轮", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: "执行期间的目录变化" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const next = await page.request.post("/api/messages", {
    data: {
      operation: "main",
      chatId: main.chatId,
      commandId: randomUUID(),
      text: "[turn-diff:next.txt]",
    },
  });
  expect(next.ok()).toBeTruthy();
  const run = (await next.json()) as Run;
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/runs/${run.id}`);
      return ((await response.json()) as Run).status;
    })
    .toBe("completed");
  await expect(file("main.txt")).toBeVisible();
  await page.getByRole("button", { name: "刷新变更" }).click();
  await expect(file("next.txt")).toBeVisible();

  await page
    .locator('.tab-strip[data-pane="main"]')
    .getByRole("button", { name: "打开标签", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "新对话", exact: true }).click();
  await openLatest();
  await expect(
    page.getByRole("heading", { name: "还没有已结束的轮次" }),
  ).toBeVisible();
  await expect(file("next.txt")).toHaveCount(0);
});

test("new Chat reuses a persistent input page and creates nothing until the first send", async ({
  page,
}) => {
  await createAgent(page, "草稿会话");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const chats = async () =>
    (
      (await (await page.request.get("/api/overview")).json()) as Overview
    ).chats.filter((chat) => chat.agentId === agentId);
  expect(await chats()).toHaveLength(0);
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "新对话", exact: true }),
  ).toHaveCount(1);
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await input.fill("keep this new chat draft");
  await composer.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft attachment"),
  });
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  expect(await chats()).toHaveLength(0);
  await page.reload();
  await expect(input).toHaveText("keep this new chat draft");
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await page.screenshot({ path: "../output/e2e/new-chat-draft.png" });
  await page.setViewportSize({ width: 600, height: 800 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  await expect(input).toBeVisible();
  await page.screenshot({ path: "../output/e2e/new-chat-draft-narrow.png" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await send(page);
  await expect(input).toBeFocused();
  const created = await chats();
  expect(created).toHaveLength(1);
  expect(created[0].title).toBe("keep this new chat draft");
  const view = (await (
    await page.request.get(`/api/chats/${created[0].id}`)
  ).json()) as ChatView;
  expect(view.runs).toHaveLength(1);
  expect(view.runs[0].attachments[0].chatId).toBe(created[0].id);
  await expect(
    page.getByRole("tab", { name: "新对话", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(input).toHaveText("");
  expect(await chats()).toHaveLength(1);
});

test("Chat drafts survive switching Agents and reloading, including an upload that finishes after switching", async ({
  page,
}) => {
  await createAgent(page, "草稿 Agent A");
  await send(page, "会话 A");
  await createAgent(page, "草稿 Agent B");
  await send(page, "会话 B");

  const selectAgent = (name: string) =>
    page.locator(".agent-select").filter({ hasText: name }).click();
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await input.fill("会话 B 的草稿");
  await selectAgent("草稿 Agent A");
  await expect(input).toHaveText("");
  await input.fill("会话 A 的草稿");

  const started = Promise.withResolvers<void>();
  const upload = Promise.withResolvers<void>();
  await page.route("**/api/chats/*/attachments", async (route) => {
    started.resolve();
    await upload.promise;
    await route.continue();
  });
  await composer.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("draft attachment"),
  });
  try {
    await started.promise;
    await selectAgent("草稿 Agent B");
    await expect(input).toHaveText("会话 B 的草稿");
    await selectAgent("草稿 Agent A");
    await expect(input).toHaveText("会话 A 的草稿");
    await input.press("End");
    await input.pressSequentially("更新");
  } finally {
    upload.resolve();
  }
  const attachment = composer.getByRole("link", {
    name: "draft.txt",
    exact: true,
  });
  await expect(attachment).toBeVisible();
  await page.reload();
  await expect(input).toHaveText("会话 A 的草稿更新");
  await expect(attachment).toBeVisible();
  await send(page);
  await page.reload();
  await expect(input).toHaveText("");
  await expect(attachment).toHaveCount(0);
  await selectAgent("草稿 Agent B");
  await expect(input).toHaveText("会话 B 的草稿");
});

test("Agent switching loads only the selected Chat and keeps recently opened panels", async ({
  page,
}) => {
  await page.goto(context().url);
  const create = async (name: string) => {
    const response = await page.request.post("/api/agents", {
      data: {
        name,
        profile: {
          provider: "codex",
          permission: "ask",
          roots: [{ path: context().scope }],
          skills: [],
          delegations: [],
        },
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as Agent;
  };
  const createChat = async (agentId: string, title: string) => {
    const response = await page.request.post("/api/chats", {
      data: { agentId, title },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as ChatView["chat"];
  };
  const firstAgent = await create("近期会话 A");
  const secondAgent = await create("近期会话 B");
  const firstChat = await createChat(firstAgent.id, "打开的会话 A");
  const secondChat = await createChat(secondAgent.id, "打开的会话 B");
  const unopened = await createChat(firstAgent.id, "尚未打开的会话");
  await page.evaluate(
    ({ firstAgent, secondAgent, firstChat, secondChat, unopened }) => {
      const tabs = (chats: (typeof firstChat)[]) =>
        chats.map(({ id, title }) => ({ id, kind: "chat", title }));
      localStorage.setItem("lever:agent", secondAgent.id);
      localStorage.setItem(
        "lever:workspaces",
        JSON.stringify({
          [firstAgent.id]: {
            tabs: tabs([firstChat, unopened]),
            selected: firstChat.id,
          },
          [secondAgent.id]: {
            tabs: tabs([secondChat]),
            selected: secondChat.id,
          },
        }),
      );
    },
    { firstAgent, secondAgent, firstChat, secondChat, unopened },
  );
  const requested: string[] = [];
  page.on("request", (request) => {
    const match = new URL(request.url()).pathname.match(
      /^\/api\/chats\/([^/]+)$/,
    );
    if (match) requested.push(match[1]);
  });
  await page.reload();
  const chat = page.locator(".chat-panel:visible");
  await expect(chat).toContainText(secondAgent.name);
  const completed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/chats/${firstChat.id}` &&
      response.ok(),
  );
  const agentA = page.locator(
    `[data-agent-id="${firstAgent.id}"] .agent-select`,
  );
  const agentB = page.locator(
    `[data-agent-id="${secondAgent.id}"] .agent-select`,
  );
  await agentA.hover();
  await completed;
  expect(requested).toEqual([secondChat.id, firstChat.id]);
  await agentA.click();
  await expect(chat).toContainText(firstAgent.name);
  const original = await chat.elementHandle();
  await agentB.click();
  await expect(chat).toContainText(secondAgent.name);
  await agentA.click();
  await expect(chat).toContainText(firstAgent.name);
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  expect(requested).toEqual([secondChat.id, firstChat.id]);
  await page.getByRole("tab", { name: unopened.title, exact: true }).click();
  await expect(chat).toContainText(firstAgent.name);
  expect(requested).toEqual([secondChat.id, firstChat.id, unopened.id]);
});

test("Agent activity stays compact, preserves navigation and supports default collapse", async ({
  page,
}) => {
  await createAgent(page, "活动列表");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const sidebar = page.locator("#agent-sidebar");
  const group = sidebar.locator(`[data-agent-id="${agentId}"]`);
  const summary = group.locator(".agent-contact-status");
  const clear = group.getByRole("button", {
    name: "清除 活动列表 的已读会话",
    exact: true,
  });
  const toggle = group.getByRole("button", {
    name: "展开或收起 活动列表 的活动会话",
    exact: true,
  });
  await expect(toggle).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "清除已读会话", exact: true }),
  ).toHaveCount(0);
  const toggleSlotBox = (await group
    .locator(".agent-activity-toggle-slot")
    .boundingBox())!;
  await expect(group.locator(".agent-activity-item")).toHaveCount(0);
  const nameWidth = (await group.locator(".agent-select").boundingBox())!.width;
  const mainTitle = String.raw`/web/test-results*/ [配置] \[保留]`;
  await send(page, mainTitle);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const agent = overview.agents.find((item) => item.id === agentId)!;
  const chat = overview.chats.find((item) => item.agentId === agentId)!;
  const main = overview.conversations.find(
    (item) => item.chatId === chat.id && item.kind === "main",
  )!;
  const mainRow = group.locator(`[data-session-id="${main.id}"]`);
  await expect(mainRow).toBeVisible();
  await expect(mainRow.locator(".truncate")).toHaveText(mainTitle);
  await expect(mainRow.locator(".agent-unread")).toHaveCount(0);
  await expect(clear).toBeVisible();
  const contact = group.locator(".agent-contact");
  await expect(contact).toHaveCSS("padding", "4px 6px");
  await expect(
    group.getByRole("button", { name: "打开 活动列表 的文件", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(mainRow).toBeVisible();
  await expect(mainRow.locator(".agent-unread")).toHaveCount(0);
  const submit = async (text: string, sessionId?: string) => {
    const response = await page.request.post("/api/messages", {
      data: {
        commandId: randomUUID(),
        chatId: chat.id,
        sessionId,
        operation: sessionId ? "reply" : "topic",
        text,
        selection: {
          provider: agent.profile.provider,
          model: agent.profile.model,
        },
        attachmentIds: [],
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as Run;
  };
  const running = await submit(
    "[hang] 一个很长的运行中话题标题，不能撑宽侧栏，也不能挤掉运行圈",
  );
  const unread = await submit(
    String.raw`[未读话题](https://example.com/${"long/".repeat(32)}) \[链接\] \\server`,
  );
  const runningRow = group.locator(`[data-session-id="${running.sessionId}"]`);
  const unreadRow = group.locator(`[data-session-id="${unread.sessionId}"]`);
  await expect(runningRow.locator(".animate-spin")).toBeVisible();
  await expect(unreadRow.locator(".agent-unread")).toBeVisible();
  await expect(unreadRow.locator(".truncate")).toHaveText(
    String.raw`未读话题 [链接] \server`,
  );
  await expect(summary).toBeHidden();
  await clear.click();
  await expect(mainRow).toHaveCount(0);
  await expect(runningRow.locator(".animate-spin")).toBeVisible();
  await expect(unreadRow.locator(".agent-unread")).toBeVisible();
  await expect(clear).toHaveCount(0);
  await expect(group.locator(".agent-activity-item")).toHaveCount(2);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const toggleBox = (await toggle.boundingBox())!;
  const chatActionBox = (await group
    .getByRole("button", { name: "打开 活动列表 的对话", exact: true })
    .boundingBox())!;
  expect(toggleBox.x).toBe(toggleSlotBox.x);
  expect(toggleBox.x + toggleBox.width).toBe(
    chatActionBox.x + chatActionBox.width,
  );
  expect(toggleBox.y).toBeGreaterThanOrEqual(
    chatActionBox.y + chatActionBox.height,
  );
  expect((await group.locator(".agent-select").boundingBox())!.width).toBe(
    nameWidth,
  );
  await expect(runningRow).toHaveCSS("height", "28px");
  await expect(group.locator(".agent-activity-list")).toHaveCSS(
    "row-gap",
    "4px",
  );
  expect(
    await runningRow
      .locator(".truncate")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  expect(
    (await page.locator(".secondary-sidebar-content").first().boundingBox())!
      .width,
  ).toBe(240);

  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  await input.fill("保留主会话草稿");
  await unreadRow.click();
  await expect(page.locator(".topic-conversation:visible")).toContainText(
    "未读话题",
  );
  await expect(unreadRow).toHaveAttribute("aria-current", "true");
  await expect(unreadRow.locator(".agent-unread")).toHaveCount(0);
  await runningRow.click();
  await expect(runningRow).toHaveClass(/selected/);
  await expect(unreadRow).toBeVisible();
  await clear.click();
  await expect(unreadRow).toHaveCount(0);
  await expect(runningRow).toBeVisible();
  const headerBox = (await contact.boundingBox())!;
  const contentBox = (await group
    .locator(".agent-contact-content")
    .boundingBox())!;
  expect(contentBox.y - headerBox.y).toBeCloseTo(4);
  expect(headerBox.height - contentBox.height).toBeCloseTo(8);
  const highlightBox = (await runningRow.boundingBox())!;
  const itemBox = (await runningRow.locator("..").boundingBox())!;
  expect(highlightBox.x).toBeGreaterThan(headerBox.x);
  expect(highlightBox.x + highlightBox.width).toBe(
    headerBox.x + headerBox.width,
  );
  expect(highlightBox.x).toBe(itemBox.x);
  expect(highlightBox.width).toBe(itemBox.width);
  await expect(page.locator(".topic-conversation:visible")).toContainText(
    running.input,
  );
  await group
    .getByRole("button", { name: "打开 活动列表 的对话", exact: true })
    .click();
  await expect(input).toHaveText("保留主会话草稿");
  await submit("再次回复", unread.sessionId);
  await expect(unreadRow.locator(".agent-unread")).toBeVisible();
  const resumed = await submit("[hang] 带着未读继续运行", unread.sessionId);
  await expect(unreadRow.locator(".animate-spin")).toBeVisible();
  await expect(unreadRow.locator(".agent-unread")).toBeVisible();
  await sidebar
    .getByRole("button", { name: "搜索 Lever", exact: true })
    .click();
  const search = page.getByRole("dialog", { name: "搜索 Lever" });
  await search.getByRole("radio", { name: "未读", exact: true }).click();
  await expect(
    search.locator(`[role="option"][data-value="topic:${unread.sessionId}"]`),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();

  const otherResponse = await page.request.post("/api/agents", {
    data: { name: "其他搭档", profile: agent.profile },
  });
  expect(otherResponse.ok()).toBeTruthy();
  const other = (await otherResponse.json()) as Agent;
  const otherGroup = sidebar.locator(`[data-agent-id="${other.id}"]`);
  await otherGroup.locator(".agent-select").click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(runningRow).not.toBeVisible();
  const count = summary.getByRole("img", {
    name: "2 个任务运行中",
    exact: true,
  });
  await expect(count).toHaveText("2");
  await expect(
    summary.getByRole("img", { name: "有新结果待查看", exact: true }),
  ).toBeVisible();
  const bars = count.locator(".agent-working-bars > span");
  await expect(bars).toHaveCount(3);
  await expect(bars.first()).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(bars.first()).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(bars.first()).not.toHaveCSS("animation-name", "none");
  expect((await group.locator(".agent-select").boundingBox())!.width).toBe(
    nameWidth,
  );
  await expect(otherGroup.locator(".agent-select")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await group.locator(".agent-select").click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveText("保留主会话草稿");
  await toggle.click();
  await expect(runningRow).toBeVisible();
  await expect(summary).toBeHidden();

  const childBox = (await runningRow.boundingBox())!;
  await page.mouse.move(childBox.x + 25, childBox.y + 14);
  await page.mouse.down();
  await page.mouse.move(childBox.x + 25, childBox.y + 24, { steps: 5 });
  await expect(page.locator(".agent-group.dragging")).toHaveCount(0);
  await page.mouse.up();

  // The Agent header still drags its entire group; child rows never activate dragging.
  const groups = page.locator(".agent-group");
  const ids = () =>
    groups.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-agent-id")),
    );
  const before = await ids();
  const first = groups.first().locator(".agent-select");
  await first.focus();
  await first.press("Space");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  const dragStatus = page
    .getByRole("status")
    .filter({ hasText: "Draggable item" });
  await expect(dragStatus).toContainText(
    `was moved over droppable area ${before[0]}`,
  );
  await page.keyboard.press("ArrowDown");
  await expect(dragStatus).toContainText(
    `was moved over droppable area ${before[1]}`,
  );
  await page.keyboard.press("Space");
  await expect.poll(ids).not.toEqual(before);
  const reordered = await ids();

  // Drag the expanded Agent over a shorter group in manual order.
  await expect(group).toHaveCSS("transform", "none");
  await expect(otherGroup).toHaveCSS("transform", "none");
  const expanded = (await group.boundingBox())!;
  const compact = (await otherGroup.boundingBox())!;
  expect(expanded.height).toBeGreaterThan(compact.height);
  const header = (await group.locator(".agent-select").boundingBox())!;
  const x = header.x + header.width / 2;
  const y = header.y + header.height / 2;
  const offsetY =
    compact.y + compact.height / 2 - (expanded.y + expanded.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + offsetY, { steps: 6 });
  await expect(group).toHaveClass(/dragging/);
  await expect(dragStatus).toContainText(
    `was moved over droppable area ${other.id}`,
  );
  expect((await group.boundingBox())!.height).toBeCloseTo(expanded.height);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(group).not.toHaveClass(/dragging/);
  expect(await ids()).toEqual(reordered);
  await page.screenshot({ path: "../output/e2e/agent-activity.png" });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "常规", exact: true })
    .click();
  await page
    .getByRole("radiogroup", { name: "Agent 活动会话默认展开", exact: true })
    .getByRole("radio", { name: "折叠", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(runningRow).not.toBeVisible();
  await page.reload();
  await expect(runningRow).not.toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "常规", exact: true })
    .click();
  await page
    .getByRole("radiogroup", { name: "Agent 活动会话默认展开", exact: true })
    .getByRole("radio", { name: "展开", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(runningRow).toBeVisible();
  await expect(runningRow.locator(".animate-spin")).toBeVisible();
  await runningRow.click();
  await expect(runningRow).toHaveClass(/selected/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page
    .locator("#agent-sidebar")
    .screenshot({ path: "../output/e2e/agent-activity-dark.png" });
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(runningRow).toBeVisible();
  const sidebarBox = (await page.locator("#agent-sidebar").boundingBox())!;
  const rowBox = (await runningRow.boundingBox())!;
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(
    sidebarBox.x + sidebarBox.width,
  );
  await page.screenshot({ path: "../output/e2e/agent-activity-narrow.png" });
  expect(
    (
      await page.request.post(`/api/runs/${running.id}/stop`, { data: {} })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post(`/api/runs/${resumed.id}/stop`, { data: {} })
    ).ok(),
  ).toBeTruthy();
  await expect(runningRow.locator(".animate-spin")).toHaveCount(0);
  await expect(runningRow).toBeVisible();
  await unreadRow.click();
  await expect(unreadRow.locator(".agent-unread")).toHaveCount(0);
  await expect(unreadRow).toBeVisible();
  await page.reload();
  await expect(unreadRow).toBeVisible();
  await expect(unreadRow.locator(".agent-unread")).toHaveCount(0);
  await expect(runningRow).toBeVisible();
  await expect(mainRow).toHaveCount(0);
  await clear.click();
  await expect(toggle).toHaveCount(0);
  await expect(group.locator(".agent-activity-list")).toHaveCount(0);
  await expect(clear).toHaveCount(0);
});

test("Recent shows the generated conversation title when it arrives after the reply", async ({
  page,
}) => {
  const scope = mkdtempSync(
    join(dirname(context().scope), "conversation-title-"),
  );
  const gate = join(scope, "hold-title");
  const title = "会话列表命名";
  const opening = "Title fixture: " + title;
  writeFileSync(gate, "");
  try {
    await createAgent(page, "会话标题", scope);
    await send(page, opening);
    const sidebar = page.locator("#agent-sidebar");
    await sidebar.getByRole("tab", { name: "最近", exact: true }).click();
    const row = sidebar.locator(".recent-conversation").filter({
      has: page.getByText(opening, { exact: true }),
    });
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-session-id");
    const preview = await row.locator(".conversation-origin").innerText();

    rmSync(gate);
    const updated = sidebar.getByRole("tabpanel").locator(`[data-session-id="${id}"]`);
    await expect(updated.getByText(title, { exact: true })).toBeVisible();
    await expect(updated.locator(".conversation-origin")).toHaveText(preview);
    await expect(row).toHaveCount(0);
  } finally {
    rmSync(scope, { recursive: true, force: true });
  }
});

test("switching Topics from the Agents sidebar keeps the side pane maximized", async ({
  page,
}) => {
  await createAgent(page, "话题分栏切换");
  await send(page, "第一个 Chat");
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const agent = overview.agents.find(({ name }) => name === "话题分栏切换")!;
  const firstChat = overview.chats.find(({ agentId }) => agentId === agent.id)!;
  const response = await page.request.post("/api/chats", {
    data: { agentId: agent.id, title: "第二个 Chat" },
  });
  expect(response.ok()).toBe(true);
  const secondChat: { id: string } = await response.json();
  const createTopic = async (chatId: string, text: string): Promise<Run> => {
    const response = await page.request.post("/api/messages", {
      data: { chatId, text, commandId: randomUUID(), operation: "topic" },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const first = await createTopic(firstChat.id, "第一个 Topic");
  const second = await createTopic(secondChat.id, "第二个 Topic");
  const layout = page.locator(".workspace-layout");
  const openTopic = async (topic: Run) => {
    await page
      .locator(`#agent-sidebar [data-session-id="${topic.sessionId}"]`)
      .click();
    await expect(
      page.locator(".topic-conversation:visible .user-message"),
    ).toContainText(topic.input);
  };

  await openTopic(first);
  await expect(layout).toHaveAttribute("data-view", "split");
  await page.getByRole("button", { name: "最大化面板", exact: true }).click();
  await expect(layout).toHaveCSS("--workspace-main", "0fr");

  await openTopic(second);
  await expect(layout).toHaveAttribute("data-view", "side");
  await expect(layout).toHaveCSS("--workspace-main", "0fr");
  await expect(page.locator(".chat-panel:visible")).toHaveCount(0);

  await page.getByRole("button", { name: "还原面板大小", exact: true }).click();
  await expect(layout).toHaveAttribute("data-view", "split");
  await expect(
    page.locator(
      `.chat-panel:visible .topic-thread[data-session-id="${second.sessionId}"]`,
    ),
  ).toBeInViewport();
  await openTopic(first);
  await expect(layout).toHaveAttribute("data-view", "split");
});

for (const [view, sameAgent] of [
  ["全部", true],
  ["全部", false],
  ["最近", false],
] as const) {
  test(`one press opens the intended sidebar Topic across live reordering in ${view} (${sameAgent ? "same Agent" : "across Agents"})`, async ({
    page,
  }) => {
    await page.goto(context().url);
    const overview: Overview = await (
      await page.request.get("/api/overview")
    ).json();
    const seedChat = async (name: string): Promise<string> => {
      const agent = await page.request.post("/api/agents", {
        data: {
          name,
          profile: { ...overview.agents[0].profile, provider: "codex" },
        },
      });
      expect(agent.ok()).toBe(true);
      const chat = await page.request.post("/api/chats", {
        data: { agentId: (await agent.json()).id, title: name },
      });
      expect(chat.ok()).toBe(true);
      return (await chat.json()).id;
    };
    const seedTopic = async (chatId: string, name: string): Promise<Run> => {
      const response = await page.request.post("/api/messages", {
        data: {
          chatId,
          text: name,
          commandId: randomUUID(),
          operation: "topic",
        },
      });
      expect(response.ok()).toBe(true);
      const topic: Run = await response.json();
      await expect
        .poll(async () => {
          const history = await (
            await page.request.get(`/api/sessions/${topic.sessionId}/runs`)
          ).json();
          return history.runs.find((run: Run) => run.id === topic.id)?.status;
        })
        .toBe("completed");
      return topic;
    };
    const firstChat = await seedChat("第一个分组");
    const first = await seedTopic(firstChat, "第一个话题");
    const second = await seedTopic(
      sameAgent ? firstChat : await seedChat("第二个分组"),
      "第二个话题",
    );
    const [target, previous] = sameAgent ? [second, first] : [first, second];
    const sidebar = page.locator("#agent-sidebar");
    await sidebar.getByRole("tab", { name: view, exact: true }).click();
    const list = sidebar.getByRole("tabpanel");
    const row = (topic: Run) =>
      list.locator(`button[data-session-id="${topic.sessionId}"]`);
    await row(previous).click();
    await expect(row(previous)).toHaveAttribute("aria-current", "true");
    if (sameAgent) {
      await row(previous).hover();
      await row(previous)
        .locator("..")
        .locator(".agent-activity-action")
        .click();
      await expect(row(previous)).toHaveCount(0);
    }
    await row(target).scrollIntoViewIfNeeded();
    const box = (await row(target).boundingBox())!;
    if (!sameAgent)
      expect(box.y).toBeGreaterThan((await row(previous).boundingBox())!.y);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      const changing = sameAgent ? previous : target;
      const update = page.waitForResponse(async (response) => {
        if (
          new URL(response.url()).pathname !== "/api/overview" ||
          !response.ok()
        )
          return false;
        const data: Overview | undefined = await response
          .json()
          .catch(() => undefined);
        return !!data?.conversations.some(
          (item) =>
            item.id === changing.sessionId &&
            item.preview?.includes("按住鼠标时的新回复"),
        );
      });
      const reply = await page.request.post("/api/messages", {
        data: {
          chatId: changing.chatId,
          sessionId: changing.sessionId,
          text: "按住鼠标时的新回复",
          commandId: randomUUID(),
          operation: "reply",
        },
      });
      expect(reply.ok()).toBe(true);
      await update;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    } finally {
      await page.mouse.up();
    }
    await expect(row(target)).toHaveAttribute("aria-current", "true");
    await expect(
      page.locator(
        `[id="panel-topic%3A${target.sessionId}"][data-visible=true] .topic-conversation`,
      ),
    ).toContainText(target.input);
    await expect(row(previous)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await row(target).boundingBox())!.y <
          (await row(previous).boundingBox())!.y,
      )
      .toBe(!sameAgent);
    const other = (await row(previous).boundingBox())!;
    await page.mouse.move(
      other.x + other.width / 2,
      other.y + other.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await expect(row(target)).toHaveAttribute("aria-current", "true");
    await row(previous).press("Enter");
    await expect(row(previous)).toHaveAttribute("aria-current", "true");
  });
}

test("a slow Topic cannot take selection back from a sidebar Chat", async ({
  page,
}) => {
  await createAgent(page, "侧栏单击切换");
  await send(page, "主会话");
  const agentId = await page.evaluate(() =>
    localStorage.getItem("lever:agent"),
  );
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const main = overview.conversations.find(
    (item) => item.agentId === agentId && item.kind === "main",
  )!;
  const response = await page.request.post("/api/messages", {
    data: {
      chatId: main.chatId,
      text: "慢速话题",
      commandId: randomUUID(),
      operation: "topic",
    },
  });
  expect(response.ok()).toBe(true);
  const topic: Run = await response.json();
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api/sessions/${topic.sessionId}`, async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  const list = page.locator("#agent-sidebar").getByRole("tabpanel");
  const row = (id: string) => list.locator(`button[data-session-id="${id}"]`);
  try {
    await row(topic.sessionId).click();
    await requested.promise;
    await expect(row(topic.sessionId)).toHaveAttribute("aria-current", "true");
    await row(main.id).click();
    await expect(row(main.id)).toHaveAttribute("aria-current", "true");
  } finally {
    release.resolve();
  }
  const editor = page.locator('.tab-panel[data-pane="side"] .prompt-editor');
  await expect(editor).toBeVisible();
  await editor.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(row(main.id)).toHaveAttribute("aria-current", "true");
  await expect(editor).not.toBeFocused();
});

test("one click switches sidebar views while the sort menu is open", async ({
  page,
}) => {
  await page.goto(context().url);
  const sidebar = page.locator("#agent-sidebar");
  const recent = sidebar.getByRole("tab", { name: "最近", exact: true });
  const box = (await recent.boundingBox())!;
  await sidebar
    .getByRole("button", { name: "Agent 排序", exact: true })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(recent).toHaveAttribute("aria-selected", "true");
});

test("sidebar menus rename the clicked Chat and Topic without switching or reading them", async ({
  page,
}) => {
  await createAgent(page, "菜单当前 Agent");
  const current = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const profile = overview.agents.find(
    (agent) => agent.id === current,
  )!.profile;
  const other = await (
    await page.request.post("/api/agents", {
      data: { name: "菜单目标 Agent", profile },
    })
  ).json();
  const chat = await (
    await page.request.post("/api/chats", {
      data: { agentId: other.id, title: "原 Chat 标题" },
    })
  ).json();
  const sidebar = page.locator("#agent-sidebar");
  const row = (id: string) => sidebar.locator(`[data-session-id="${id}"]`);
  const choose = (name: string) =>
    page.getByRole("menuitem", { name, exact: true }).click();
  let topicId = "";
  for (const [operation, title] of [
    ["main", "New chat"],
    ["topic", "独立话题标题"],
  ]) {
    const result = await page.request.post("/api/messages", {
      data: {
        chatId: chat.id,
        commandId: randomUUID(),
        operation,
        text: operation + " message",
      },
    });
    expect(result.ok()).toBeTruthy();
    const run: Run = await result.json();
    if (operation === "topic") topicId = run.sessionId;
    const target = row(run.sessionId);
    await expect(target.locator(".agent-unread")).toBeVisible();
    await target.click({ button: "right" });
    await choose("重命名会话…");
    const input = page.getByRole("textbox", { name: "会话标题" });
    await expect(input).toBeFocused();
    await input.fill(title);
    await input.press("Enter");
    await expect(target).toHaveAccessibleName(title);
    await expect(target.locator(".agent-unread")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("lever:agent"))).toBe(
      current,
    );
  }
  const topic = row(topicId);
  await topic.focus();
  await topic.press("Shift+F10");
  await choose("置顶话题");
  await sidebar.getByRole("tab", { name: "最近" }).click();
  const pinned = sidebar
    .getByRole("region", { name: "已置顶" })
    .locator(`[data-session-id="${topicId}"]`);
  await expect(pinned).toContainText("独立话题标题");
  await pinned.click({ button: "right" });
  await choose("定位原消息");
  await expect(
    page.locator(`.topic-thread[data-session-id="${topicId}"]:visible`),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "New chat", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(pinned).toContainText("独立话题标题");
  await sidebar.getByRole("button", { name: "搜索 Lever" }).click();
  const search = page.getByRole("dialog", { name: "搜索 Lever" });
  await search.getByRole("combobox").fill("独立话题标题");
  await expect(
    search.getByRole("option").filter({ hasText: "独立话题标题" }).first(),
  ).toBeVisible();
});

test("Agent menu clears only read activity and can archive after a sidebar pause", async ({
  page,
}) => {
  await createAgent(page, "活动菜单");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const sidebar = page.locator("#agent-sidebar");
  const list = sidebar.getByRole("tabpanel");
  const agent = list.locator(`[data-agent-id="${agentId}"] .agent-select`);
  const showCleared = sidebar.getByRole("button", {
    name: "显示已清理会话",
    exact: true,
  });
  const item = (name: string) =>
    page.getByRole("menuitem", { name, exact: true });
  const start = async (text: string) => {
    const response = await page.request.post("/api/messages", {
      data: { agentId, operation: "topic", commandId: randomUUID(), text },
    });
    expect(response.ok()).toBeTruthy();
    const run: Run = await response.json();
    return list.locator(`[data-session-id="${run.sessionId}"]`);
  };
  const done = await start("已完成的话题");
  await expect(done.locator(".agent-unread")).toBeVisible();
  const busy = await start("继续执行 [hang]");
  await expect(busy.locator(".agent-working")).toBeVisible();
  await agent.click({ button: "right" });
  await expect(item("归档 Agent")).toBeDisabled();
  await item("全部标为已读").click();
  await expect(done.locator(".agent-unread")).toHaveCount(0);
  await agent.click({ button: "right" });
  await item("清除已读活动").click();
  await expect(done).toHaveCount(0);
  await expect(busy).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await showCleared.click();
  await expect(showCleared).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar.locator(".agent-cleared-strip")).toHaveCount(0);
  await expect(busy).toBeVisible();
  await expect(done).toHaveAttribute("data-cleared", "true");
  await done.click();
  const topic = page.locator(".topic-conversation:visible");
  await expect(topic).toContainText("已完成的话题");
  await expect(done).toBeVisible();
  await showCleared.click();
  await expect(showCleared).toHaveAttribute("aria-pressed", "false");
  await expect(done).toHaveCount(0);
  await expect(topic).toContainText("已完成的话题");
  await busy.click({ button: "right" });
  await item("暂停回复").click();
  await expect(busy.locator(".agent-unread")).toBeVisible();
  await busy.click({ button: "right" });
  await item("标为已读").click();
  await busy.hover();
  await expect(
    busy.locator("..").getByRole("button", {
      name: "从活动列表清除 继续执行 [hang]",
      exact: true,
    }),
  ).toHaveCSS("opacity", "1");
  await busy.click({ button: "right" });
  await item("从活动列表清除").click();
  await expect(busy).toHaveCount(0);
  await agent.click({ button: "right" });
  await item("归档 Agent").click();
  await expect(agent).toHaveCount(0);

  // Archived Agents are recovered or inspected from Settings -> Archived Agents.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.locator(".settings-page");
  await settings
    .getByRole("button", { name: /已归档 Agent/ })
    .click();
  const archivedRow = settings
    .locator(".settings-row")
    .filter({ hasText: "活动菜单" });
  await expect(archivedRow).toBeVisible();
  await archivedRow
    .getByRole("button", { name: "打开历史对话", exact: true })
    .click();
  await expect(
    page
      .locator(".chat-panel:visible")
      .getByRole("button", { name: "添加附件、命令或引用" }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await archivedRow
    .getByRole("button", { name: "恢复 Agent", exact: true })
    .click();
  await expect(archivedRow).toHaveCount(0);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(agent).toBeVisible();
  await showCleared.click();
  await expect(done).toBeVisible();
});

test("Recent clears read completed conversations and restores priority on a new run", async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await createAgent(page, "最近分组");
  await send(page, "已读的主会话");
  const readOverview = async () =>
    (await (await page.request.get("/api/overview")).json()) as Overview;
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const overview = await readOverview();
  const agent = overview.agents.find((item) => item.id === agentId)!;
  const chat = overview.chats.find((item) => item.agentId === agentId)!;
  const main = overview.conversations.find(
    (item) => item.chatId === chat.id && item.kind === "main",
  )!;
  const submit = async (
    text: string,
    operation: "main" | "topic" = "topic",
  ) => {
    const response = await page.request.post("/api/messages", {
      data: {
        commandId: randomUUID(),
        chatId: chat.id,
        operation,
        text,
        selection: {
          provider: agent.profile.provider,
          model: agent.profile.model,
        },
        attachmentIds: [],
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as Run;
  };
  const running = await submit("[hang] 正在运行的 Topic");
  try {
    const unread = await submit("尚未阅读的 Topic");
    const sidebar = page.locator("#agent-sidebar");
    await sidebar.getByRole("tab", { name: "最近", exact: true }).click();
    const priority = sidebar.getByRole("region", { name: "优先", exact: true });
    const today = sidebar.getByRole("region", { name: "今天", exact: true });
    const pinned = sidebar.getByRole("region", { name: "已置顶", exact: true });
    const clear = priority.getByRole("button", {
      name: "清除已读会话",
      exact: true,
    });
    const mainRow = `[data-session-id="${main.id}"]`;
    const unreadRow = `[data-session-id="${unread.sessionId}"]`;
    const runningRow = `[data-session-id="${running.sessionId}"]`;
    await expect(priority.locator(mainRow)).toBeVisible();
    await expect(
      priority.locator(mainRow).locator(".conversation-origin"),
    ).toContainText(main.preview);
    await expect(
      priority.locator(unreadRow).locator(".agent-unread"),
    ).toBeVisible();
    const runningItem = priority.locator(runningRow);
    const spinner = runningItem.locator(".animate-spin");
    await expect(spinner).toBeVisible();
    await clear.click();
    await expect(today.locator(mainRow)).toBeVisible();
    await expect(priority.locator(mainRow)).toHaveCount(0);
    await expect(priority.locator(unreadRow)).toBeVisible();
    await expect(priority.locator(runningRow)).toBeVisible();
    await expect(clear).toBeDisabled();

    const mainItem = today
      .getByRole("listitem")
      .filter({ has: page.locator(mainRow) });
    const pin = mainItem.getByRole("button", { name: "置顶会话", exact: true });
    await page.mouse.move(0, 0);
    await expect(pin).toHaveCSS("opacity", "0");
    await expect(today.locator(mainRow)).toHaveCSS(
      "padding-inline-end",
      "10px",
    );
    await mainItem.hover();
    await expect(pin).toHaveCSS("opacity", "1");
    await pin.click();
    await expect(pinned.locator(mainRow)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.reload();
    await expect(pinned.locator(mainRow)).toBeVisible();
    const unpin = pinned.getByRole("button", { name: "取消置顶", exact: true });
    await expect(unpin).toHaveCSS("opacity", "0");
    const nextControl =
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab";
    await pinned.locator(mainRow).press(nextControl);
    await expect(unpin).toBeFocused();
    await expect(unpin).toHaveCSS("opacity", "1");
    await unpin.press("Enter");
    await expect(today.locator(mainRow)).toBeVisible();
    await submit("这次执行重新进入优先", "main");
    await expect(priority.locator(mainRow)).toBeVisible();
    await sidebar.getByRole("tab", { name: "全部", exact: true }).click();
    await expect(sidebar.getByRole("tabpanel").locator(mainRow)).toBeVisible();
    await expect(
      sidebar.getByRole("tabpanel").locator(`${mainRow}[data-cleared="true"]`),
    ).toHaveCount(0);
  } finally {
    await page.request.post(`/api/runs/${running.id}/stop`, { data: {} });
  }
});

test("All and Recent share cleared sessions and the cleared lens restores them", async ({
  page,
}) => {
  const sidebar = page.locator("#agent-sidebar");
  const list = sidebar.getByRole("tabpanel");
  const showCleared = sidebar.getByRole("button", {
    name: "显示已清理会话",
    exact: true,
  });
  const all = sidebar.getByRole("tab", { name: "全部", exact: true });
  const recent = sidebar.getByRole("tab", { name: "最近", exact: true });
  const priority = sidebar.getByRole("region", { name: "优先", exact: true });
  const today = sidebar.getByRole("region", { name: "今天", exact: true });
  const clearPriority = priority.getByRole("button", {
    name: "清除已读会话",
    exact: true,
  });
  await createAgent(page, "会话归档甲");
  await expect(showCleared).toBeDisabled();
  await send(page, "第一个 Agent 的原始会话");
  const firstAgentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const firstGroup = list.locator(`[data-agent-id="${firstAgentId}"]`);
  const rows = firstGroup.locator("[data-session-id]");
  await expect(rows).toHaveCount(1);
  const mainSessionId = (await rows.first().getAttribute("data-session-id"))!;
  const mainRow = `[data-session-id="${mainSessionId}"]`;
  for (let index = 1; index <= 6; index++) {
    const response = await page.request.post("/api/messages", {
      data: {
        agentId: firstAgentId,
        operation: "topic",
        commandId: randomUUID(),
        text: `归档话题 ${index}`,
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  await expect(rows).toHaveCount(7);
  await expect(rows.locator(".agent-working")).toHaveCount(0);
  await firstGroup.locator(".agent-select").click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "全部标为已读", exact: true })
    .click();
  await expect(rows.locator(".agent-unread")).toHaveCount(0);
  await firstGroup
    .getByRole("button", { name: "清除 会话归档甲 的已读会话", exact: true })
    .click();
  await expect(rows).toHaveCount(0);

  await createAgent(page, "会话归档乙");
  await send(page, "第二个 Agent 的原始会话");
  const secondAgentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const secondGroup = list.locator(`[data-agent-id="${secondAgentId}"]`);
  const secondSessionId = await secondGroup
    .locator("[data-session-id]")
    .getAttribute("data-session-id");
  const secondSelector = `[data-session-id="${secondSessionId}"]`;
  await recent.click();
  const secondRow = priority.locator(secondSelector);
  await expect(secondRow).toBeVisible();
  await expect(secondRow.locator(".conversation-origin")).toContainText(
    "已完成",
  );
  await expect(secondRow.locator(".agent-unread, svg[aria-label]")).toHaveCount(
    0,
  );
  await expect(today.locator(mainRow)).toBeVisible();
  await expect(priority.locator(mainRow)).toHaveCount(0);
  await clearPriority.click();
  await expect(secondRow).toHaveCount(0);
  await expect(today.locator(secondSelector)).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await all.click();
  await expect(list.locator(secondSelector)).toHaveCount(0);
  await recent.click();

  // Older versions can have a newer Clear cursor in the All view's storage.
  await page.evaluate((id) => {
    const key = "lever:recent-conversations";
    const state = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(
      "lever:dismissed-agent-activity",
      JSON.stringify({ [id]: state.cleared[id] }),
    );
    state.cleared[id] = 0;
    localStorage.setItem(key, JSON.stringify(state));
  }, mainSessionId);
  await page.reload();
  await expect(today.locator(mainRow)).toBeVisible();
  await expect(today.locator(secondSelector)).toBeVisible();

  await all.click();
  await expect(showCleared).toBeEnabled();

  // Keep a lower-ranked selected Agent visible when earlier Agents expand cleared history.
  await page.setViewportSize({ width: 1360, height: 390 });
  await firstGroup.locator(".agent-select").click();
  await expect(firstGroup.locator("> .agent-contact")).toHaveClass(/selected/);
  await showCleared.click();
  await expect(showCleared).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar.locator(".agent-cleared-strip")).toHaveCount(0);
  const [panelBox, selectedHeaderBox, firstClearedBox] = await Promise.all([
    list.boundingBox(),
    firstGroup.locator("> .agent-contact").boundingBox(),
    rows.first().boundingBox(),
  ]);
  expect(panelBox).toBeTruthy();
  expect(selectedHeaderBox).toBeTruthy();
  expect(firstClearedBox).toBeTruthy();
  expect(selectedHeaderBox!.y).toBeGreaterThanOrEqual(panelBox!.y - 1);
  expect(selectedHeaderBox!.y + selectedHeaderBox!.height).toBeLessThanOrEqual(
    panelBox!.y + panelBox!.height + 1,
  );
  expect(firstClearedBox!.y + firstClearedBox!.height).toBeLessThanOrEqual(
    panelBox!.y + panelBox!.height + 1,
  );
  await page.setViewportSize({ width: 1360, height: 900 });

  // Zero-active agents reveal their recent 5 cleared conversations in place.
  await expect(secondGroup.locator(secondSelector)).toContainText(
    "第二个 Agent 的原始会话",
  );
  await expect(rows).toHaveCount(5);
  const [firstRowTop, secondRowTop] = await rows.evaluateAll((items) =>
    items.slice(0, 2).map((item) => item.getBoundingClientRect().top),
  );
  expect(secondRowTop - firstRowTop).toBeLessThan(36);
  const conversation = firstGroup.locator(mainRow);
  await expect(conversation).toHaveCount(0);

  const showMore = firstGroup.getByRole("button", {
    name: "显示更多",
    exact: true,
  });
  await showMore.press("Enter");
  await expect(rows).toHaveCount(7);
  await expect(showMore).toHaveCount(0);
  await expect(rows.nth(5)).toBeFocused();

  // Individual agents can hide their cleared block while keeping the lens active.
  await secondGroup
    .getByRole("button", { name: "隐藏 会话归档乙 的已清理会话", exact: true })
    .click();
  await expect(secondGroup.locator(secondSelector)).toHaveCount(0);
  await expect(rows).toHaveCount(7);
  await secondGroup.getByRole("button", { name: /已隐藏 1 条已清理/ }).click();
  await expect(secondGroup.locator(secondSelector)).toBeVisible();

  await expect(conversation).toContainText("第一个 Agent 的原始会话");
  await conversation.click();
  await expect(page.locator(".chat-panel:visible")).toContainText(
    "第一个 Agent 的原始会话",
  );
  await expect(conversation).toHaveAttribute("aria-current", "true");
  const restore = conversation
    .locator("..")
    .getByRole("button", { name: "恢复会话", exact: true });
  await page.mouse.move(0, 0);
  await expect(restore).toHaveCSS("opacity", "0");
  await conversation.hover();
  await expect(restore).toHaveCSS("opacity", "1");
  await restore.click();
  await expect(conversation).not.toHaveAttribute("data-cleared", "true");
  await expect(firstGroup.locator('[data-cleared="true"]')).toHaveCount(6);

  // Escape dismisses the cleared lens globally while keeping restored items active.
  await page.keyboard.press("Escape");
  await expect(showCleared).toHaveAttribute("aria-pressed", "false");
  await expect(list.locator('[data-cleared="true"]')).toHaveCount(0);
  await expect(conversation).toBeVisible();

  await recent.click();
  await expect(priority.locator(mainRow)).toBeVisible();
  await page.reload();
  await expect(priority.locator(mainRow)).toBeVisible();
});

test("unsent drafts surface cleared conversations and new-chat drafts in the Agents sidebar", async ({
  page,
}) => {
  const sidebar = page.locator("#agent-sidebar");
  const list = sidebar.getByRole("tabpanel");
  const showCleared = sidebar.getByRole("button", {
    name: "显示已清理会话",
    exact: true,
  });
  const all = sidebar.getByRole("tab", { name: "全部", exact: true });
  const recent = sidebar.getByRole("tab", { name: "最近", exact: true });
  const priority = sidebar.getByRole("region", { name: "优先", exact: true });
  const menuItem = (name: string) =>
    page.getByRole("menuitem", { name, exact: true });

  await createAgent(page, "草稿回溯甲");
  await send(page, "主会话历史消息");
  const firstAgentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const topicRes = await page.request.post("/api/messages", {
    data: {
      agentId: firstAgentId,
      operation: "topic",
      commandId: randomUUID(),
      text: "独立话题历史消息",
    },
  });
  expect(topicRes.ok()).toBeTruthy();
  const topicRun: Run = await topicRes.json();

  const firstGroup = list.locator(`[data-agent-id="${firstAgentId}"]`);
  const firstRows = firstGroup.locator("[data-session-id]");
  await expect(firstRows).toHaveCount(2);
  await expect(firstRows.locator(".agent-working")).toHaveCount(0);
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const mainSessionId = overview.conversations.find(
    (item) => item.agentId === firstAgentId && item.kind === "main",
  )!.id;
  const mainSelector = `[data-session-id="${mainSessionId}"]`;
  const topicSelector = `[data-session-id="${topicRun.sessionId}"]`;

  // Mark read and clear both conversations of Agent A.
  await firstGroup.locator(".agent-select").click({ button: "right" });
  await menuItem("全部标为已读").click();
  await expect(firstRows.locator(".agent-unread")).toHaveCount(0);
  await firstGroup
    .getByRole("button", { name: "清除 草稿回溯甲 的已读会话", exact: true })
    .click();
  await expect(firstRows).toHaveCount(0);

  // Create Agent B so we can switch away after drafting.
  await createAgent(page, "草稿回溯乙");
  await send(page, "另一个 Agent 的会话");
  const secondAgentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const secondGroup = list.locator(`[data-agent-id="${secondAgentId}"]`);

  // Reveal cleared history, open Agent A's cleared Main Chat and type a draft.
  await showCleared.click();
  await expect(firstGroup.locator(`${mainSelector}[data-cleared="true"]`)).toBeVisible();
  await firstGroup.locator(mainSelector).click();
  const mainComposer = page
    .locator(".chat-composer-wrap:visible")
    .getByRole("textbox", { name: "发送消息", exact: true });
  await mainComposer.fill("继续排查主会话草稿");

  const mainRow = firstGroup.locator(mainSelector);
  await expect(mainRow).toHaveCount(1);
  await expect(mainRow).not.toHaveAttribute("data-cleared", "true");
  await expect(mainRow).toHaveAttribute("data-draft", "true");
  await expect(mainRow.locator(".agent-draft")).toBeVisible();
  await expect(mainRow).toHaveAttribute("title", /草稿：继续排查主会话草稿/);

  // Also open Agent A's cleared Topic and type a reply draft.
  const topicRow = firstGroup.locator(topicSelector);
  await expect(topicRow).toHaveAttribute("data-cleared", "true");
  await topicRow.click();
  const topicComposer = page
    .locator(".topic-composer-wrap:visible")
    .getByRole("textbox", { name: "回复话题", exact: true });
  await topicComposer.fill("继续排查话题草稿");
  await expect(topicRow).toHaveCount(1);
  await expect(topicRow).not.toHaveAttribute("data-cleared", "true");
  await expect(topicRow).toHaveAttribute("data-draft", "true");
  await expect(topicRow.locator(".agent-draft")).toBeVisible();

  // Switch away to Agent B; cleared lens has no cleared items left and both drafts stay visible.
  await secondGroup.locator(".agent-select").click();
  await expect(mainRow).toBeVisible();
  await expect(topicRow).toBeVisible();
  await expect(
    firstGroup.getByRole("button", {
      name: "清除 草稿回溯甲 的已读会话",
      exact: true,
    }),
  ).toHaveCount(0);

  // Collapsing Agent A surfaces the aggregated draft indicator on the Agent row.
  const toggleA = firstGroup.getByRole("button", {
    name: "展开或收起 草稿回溯甲 的活动会话",
    exact: true,
  });
  await toggleA.click();
  const draftBadge = firstGroup.locator(".agent-draft-count");
  await expect(draftBadge).toBeVisible();
  await expect(draftBadge).toHaveAttribute("aria-label", "2 条未发送草稿");
  await expect(draftBadge).toHaveText("2");
  await toggleA.click();
  await expect(draftBadge).toBeHidden();

  // Recent view elevates both drafted conversations into Priority with draft previews.
  await recent.click();
  const recentMain = priority.locator(mainSelector);
  const recentTopic = priority.locator(topicSelector);
  await expect(recentMain).toBeVisible();
  await expect(recentMain.locator(".recent-draft-label")).toHaveText("草稿");
  await expect(recentMain.locator(".conversation-origin")).toContainText(
    "继续排查主会话草稿",
  );
  await expect(recentTopic).toBeVisible();
  await expect(recentTopic.locator(".recent-draft-label")).toHaveText("草稿");
  await expect(recentTopic.locator(".conversation-origin")).toContainText(
    "继续排查话题草稿",
  );

  // Clearing read chats in Priority clears Agent B's read chat but keeps drafted conversations.
  await priority
    .getByRole("button", { name: "清除已读会话", exact: true })
    .click();
  await expect(recentMain).toBeVisible();
  await expect(recentTopic).toBeVisible();

  // Discarding a cleared Topic's draft from the context menu folds it back into cleared.
  await all.click();
  await topicRow.click({ button: "right" });
  await menuItem("清空草稿").click();
  await expect(topicRow).toHaveCount(0);
  await expect(showCleared).toBeEnabled();

  // Clicking the surfaced Main Chat restores the draft; clearing the input folds it back too.
  await mainRow.click();
  const restoredComposer = page
    .locator(".chat-composer-wrap:visible")
    .getByRole("textbox", { name: "发送消息", exact: true });
  await expect(restoredComposer).toHaveText("继续排查主会话草稿");
  await restoredComposer.click();
  await restoredComposer.press("ControlOrMeta+a");
  await restoredComposer.press("Backspace");
  await expect(restoredComposer).toHaveText("");
  await expect(mainRow).toHaveCount(0);

  // A new unsent chat draft also appears under its Agent and can be reopened or discarded.
  await firstGroup.locator(".agent-select").click({ button: "right" });
  await menuItem("新建对话").click();
  const newChatInput = page
    .locator(".new-chat-panel:visible")
    .getByRole("textbox", { name: "发送消息", exact: true });
  await newChatInput.fill("新对话未发送内容");
  await secondGroup.locator(".agent-select").click();
  const newDraftRow = firstGroup.locator(
    `[data-draft-key="draft:${firstAgentId}"]`,
  );
  await expect(newDraftRow).toBeVisible();
  await expect(newDraftRow.locator(".agent-draft")).toBeVisible();
  await expect(newDraftRow).toHaveAccessibleName("草稿：新对话");
  await expect(newDraftRow).toHaveAttribute("title", /草稿：新对话未发送内容/);
  await newDraftRow.click();
  await expect(
    page
      .locator(".new-chat-panel:visible")
      .getByRole("textbox", { name: "发送消息", exact: true }),
  ).toHaveText("新对话未发送内容");
  await newDraftRow.click({ button: "right" });
  await menuItem("清空草稿").click();
  await expect(newDraftRow).toHaveCount(0);
  await expect(
    page
      .locator(".new-chat-panel:visible")
      .getByRole("textbox", { name: "发送消息", exact: true }),
  ).toHaveText("");
});

test("first-send rejection leaves no Chat and a lost response retries exactly once", async ({
  page,
}) => {
  await createAgent(page, "首次发送重试");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const chats = async () =>
    (
      (await (await page.request.get("/api/overview")).json()) as Overview
    ).chats.filter((chat) => chat.agentId === agentId);
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await input.fill("retry the first message");
  await composer.locator('input[type="file"]').setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("preserve this upload on rollback"),
  });
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await page.route("**/api/messages", async (route) => {
    const response = await route.fetch({
      postData: {
        ...route.request().postDataJSON(),
        attachmentIds: [
          ...route.request().postDataJSON().attachmentIds,
          "missing-attachment",
        ],
      },
    });
    expect(response.ok()).toBe(false);
    await route.fulfill({ response });
  });
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.getByRole("alert")).toBeVisible();
  expect(await chats()).toHaveLength(0);
  await expect(input).toHaveText("retry the first message");
  await page.unroute("**/api/messages");
  await page.route("**/api/messages", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.getByRole("alert")).toBeVisible();
  expect(await chats()).toHaveLength(1);
  await page.unroute("**/api/messages");
  await page.reload();
  await expect(input).toHaveText("retry the first message");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".run-content:visible")).toHaveAttribute(
    "data-status",
    "completed",
  );
  const created = await chats();
  expect(created).toHaveLength(1);
  const view = (await (
    await page.request.get(`/api/chats/${created[0].id}`)
  ).json()) as ChatView;
  expect(view.runs).toHaveLength(1);
});

test("tab menus move the clicked tab between panes and preserve its draft", async ({
  page,
}) => {
  await createAgent(page, "标签页跨栏");
  const main = page.locator('.tab-strip[data-pane="main"]');
  const side = page.locator('.tab-strip[data-pane="side"]');
  const mainDraft = main.getByRole("tab", { name: "新对话", exact: true });
  const sideDraft = side.getByRole("tab", { name: "新对话", exact: true });
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  const moveRight = page.getByRole("menuitem", { name: "移动到右侧面板" });
  const moveLeft = page.getByRole("menuitem", { name: "移动到左侧面板" });

  await input.fill("跨栏保留草稿");
  await openMoreTool(main);
  await expect(mainDraft).toHaveAttribute("aria-selected", "false");
  await mainDraft.click({ button: "right" });
  await expect(moveLeft).toHaveCount(0);
  await moveRight.click();
  await expect(mainDraft).toHaveCount(0);
  await expect(sideDraft).toHaveAttribute("aria-selected", "true");
  await expect(sideDraft).toBeFocused();
  await expect(
    main.getByRole("tab", { name: "配置", selected: true }),
  ).toBeVisible();
  await expect(input).toHaveText("跨栏保留草稿");

  await page.reload();
  await expect(sideDraft).toBeVisible();
  await expect(input).toHaveText("跨栏保留草稿");
  await sideDraft.press("Shift+F10");
  await expect(moveRight).toHaveCount(0);
  await moveLeft.press("Enter");
  await expect(mainDraft).toHaveAttribute("aria-selected", "true");
  await expect(mainDraft).toBeFocused();
  await expect(side).toHaveCount(0);
  await expect(input).toHaveText("跨栏保留草稿");
});

test("a new Chat moves between panes and accepts a Topic as its first message", async ({
  page,
}) => {
  await createAgent(page, "双栏新会话");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "新对话", exact: true }).click();
  const draft = page.locator(
    '.tab-panel[data-visible="true"]:has(.new-chat-panel)',
  );
  await expect(draft).toHaveAttribute("data-pane", "side");
  await expect(
    page.getByRole("tab", { name: "新对话", exact: true }),
  ).toHaveCount(1);
  const input = draft.getByRole("textbox", { name: "发送消息", exact: true });
  await input.fill("@hello");
  await page.getByRole("option", { name: "hello.go", exact: true }).click();
  await input.pressSequentially(" 先开启一个话题");
  await draft.getByRole("button", { name: "话题", exact: true }).click();
  await draft.getByRole("button", { name: "发送", exact: true }).click();
  const chat = page.locator('.tab-panel[data-visible="true"]:has(.chat-panel)');
  await expect(chat).toHaveAttribute("data-pane", "side");
  await expect(chat.locator(".topic-thread")).toHaveAttribute(
    "data-status",
    "completed",
  );
  await expect(
    chat.getByRole("button", { name: "话题", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const chats = overview.chats.filter((item) => item.agentId === agentId);
  expect(chats).toHaveLength(1);
  const view = (await (
    await page.request.get(`/api/chats/${chats[0].id}`)
  ).json()) as ChatView;
  expect(view.sessions.map((session) => session.kind)).toEqual(["topic"]);
  expect(view.runs[0].references?.[0].name).toBe("hello.go");

  const parentTab = page.locator(`[role="tab"][id="tab-${chats[0].id}"]`);
  const rename = async (tab: Locator, title: string) => {
    await tab.click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名会话…" }).click();
    const field = page.getByRole("textbox", { name: "会话标题" });
    await field.fill(title);
    await field.press("Enter");
    await expect(tab).toHaveText(title);
  };
  await rename(parentTab, "只有话题的 Chat");
  await chat
    .locator(".topic-thread")
    .getByRole("button", { name: "回复", exact: true })
    .click();
  const topicTab = page.locator(
    `[role="tab"][id="tab-topic%3A${view.sessions[0].id}"]`,
  );
  await rename(topicTab, "子话题独立标题");
  await page.reload();
  await expect(parentTab).toHaveText("只有话题的 Chat");
  await expect(topicTab).toHaveText("子话题独立标题");
});

test("profile pickers keep the active panel visible and save model and permission choices", async ({
  page,
}) => {
  await createAgent(page, "下拉菜单回归");
  await send(page, "```js\nconsole.log('keep the profile visible');\n```");
  const chat = page.locator(".tab-panel:has(.chat-panel)");
  await expect(chat.locator("[aria-live]").first()).toBeAttached();
  await openMoreTool(page);
  const profile = page.locator('[id="panel-profile"]');
  await expect(profile.getByText("任务队列", { exact: true })).toHaveCount(0);

  const runtime = profile.getByRole("combobox", {
    name: "运行时",
    exact: true,
  });
  await runtime.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  // Radix suppresses background accessibility without hiding it visually.
  await expect(profile).toHaveAttribute("data-aria-hidden", "true");
  await expect(profile).toHaveCSS("visibility", "visible");
  await expect(profile).toHaveCSS("opacity", "1");
  await expect(chat).toHaveCSS("visibility", "hidden");
  await expect(chat).toHaveCSS("opacity", "0");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(runtime).toBeFocused();

  const model = profile.getByRole("button", { name: "模型", exact: true });
  const models = page.getByRole("dialog", { name: "模型", exact: true });
  const search = models.getByRole("combobox", { name: "搜索模型…" });
  await model.click();
  await expect(search).toBeFocused();
  await expect(profile).toBeVisible();
  await expect(chat).toHaveCSS("visibility", "hidden");
  await page.screenshot({
    path: test.info().outputPath("profile-model-picker.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(models).toBeHidden();
  await expect(model).toBeFocused();

  await model.click();
  await search.fill("gpt-review");
  await expect(models.getByRole("option")).toHaveCount(1);
  await expect(
    models.getByRole("option", { name: "GPT Review" }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(models).toBeHidden();
  await expect(model).toHaveText("GPT Review");

  const permissions = profile.getByRole("radiogroup", { name: "权限" });
  const fullAccess = permissions.getByRole("radio", { name: "完全访问" });
  await expect(fullAccess).toHaveAccessibleDescription(/脱离沙箱运行/);
  const save = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.startsWith("/api/agents/") &&
      response.request().postDataJSON()?.profile?.permission === "full_access",
  );
  await fullAccess.click();
  await expect(fullAccess).toBeChecked();
  await expect(
    profile.getByRole("button", { name: "保存 Agent", exact: true }),
  ).toHaveCount(0);
  expect(await (await save).json()).toMatchObject({
    profile: { model: "gpt-review", permission: "full_access" },
  });
});

for (const runtime of ["Antigravity", "Pi", "DeepSeek Harness"]) {
  test(`running ${runtime} shows only the follow-ups the turn accepts`, async ({
    page,
  }) => {
    await createAgent(page, `运行中追加 ${runtime}`);
    await page.getByRole("button", { name: "选择模型和运行时" }).click();
    await page.getByRole("radio", { name: runtime, exact: true }).click();
    await page.keyboard.press("Escape");
    const composer = page.locator(".chat-composer-wrap:visible");
    const input = composer.getByRole("textbox", {
      name: "发送消息",
      exact: true,
    });
    await input.fill("[steer-open]");
    await composer.getByRole("button", { name: "发送", exact: true }).click();
    const turn = page
      .locator(".chat-panel .conversation > .run-content")
      .last();
    await expect(turn).toContainText("before steer");
    await input.fill("change direction");
    const steer = composer
      .locator(".composer-actions")
      .getByRole("button", { name: "发送到当前执行", exact: true });
    if (runtime === "DeepSeek Harness") {
      await expect(steer).toHaveCount(0);
      await expect(
        composer.getByRole("button", { name: "加入队列", exact: true }),
      ).toBeEnabled();
      await input.fill("");
      await composer.getByRole("button", { name: "停止执行", exact: true }).click();
      return;
    }
    await steer.click();
    await expect(turn).toHaveAttribute("data-status", "completed");
    await expect(turn).toContainText("before steer");
    await expect(turn).toContainText("after: change direction");
  });
}

test("Antigravity delivers a startup Steer to the original turn", async ({ page }) => {
  const scope = mkdtempSync(join(context().scope, "pending-agy-"));
  try {
    await createAgent(page, "等待本轮就绪", scope);
    await page.getByRole("button", { name: "选择模型和运行时" }).click();
    await page.getByRole("radio", { name: "Antigravity", exact: true }).click();
    await page.keyboard.press("Escape");
    const composer = page.locator(".chat-composer-wrap:visible");
    const input = composer.getByRole("textbox", { name: "发送消息", exact: true });
    await input.fill("[defer-steer] [steer-open]");
    await composer.getByRole("button", { name: "发送", exact: true }).click();
    await input.fill("follow before ready");
    await composer.getByRole("button", { name: "当前执行就绪后追加", exact: true }).click();
    const queued = page.locator("[data-queued-id]", { hasText: "follow before ready" });
    await expect(queued.getByRole("status")).toHaveText("当前执行就绪后追加");
    writeFileSync(join(scope, "allow-steer"), "");
    const turn = page.locator(".chat-panel .conversation > .run-content");
    await expect(turn).toHaveCount(1);
    await expect(turn).toHaveAttribute("data-status", "completed");
    await expect(turn).toContainText("after: follow before ready");
    await expect(queued).toHaveCount(0);
  } finally {
    rmSync(scope, { force: true, recursive: true });
  }
});

test("running sends default to Steer and honor the saved action and shortcut", async ({
  page,
}) => {
  await createAgent(page, "运行中发送偏好");
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const controls = composer.locator(".composer-actions");
  const queueButton = controls.getByRole("button", {
    name: "加入队列",
    exact: true,
  });
  const steerButton = controls.getByRole("button", {
    name: "发送到当前执行",
    exact: true,
  });
  const queue = composer.getByRole("region", { name: "消息队列" });
  const turn = page.locator(".chat-panel .conversation > .run-content");
  await input.fill("[hang] check follow-ups");
  await input.press("Enter");
  await expect(turn).toHaveAttribute("data-status", "running");

  await input.fill("[hang] steered by the primary button");
  await expect(steerButton).toHaveText("追加");
  await steerButton.click();
  await expect(turn.locator(".user-message").last()).toContainText(
    "steered by the primary button",
  );
  await input.fill("queued by the other button");
  await queueButton.click();
  await expect(queue).toContainText("queued by the other button");

  const navigation = page.getByRole("navigation", { name: "主导航" });
  await navigation.getByRole("button", { name: "设置", exact: true }).click();
  const followUp = page.getByRole("radiogroup", {
    name: "运行中发送",
    exact: true,
  });
  await expect(followUp.getByRole("radio", { name: "追加" })).toBeChecked();
  await followUp.getByRole("radio", { name: "排队" }).click();
  await page
    .getByRole("radiogroup", { name: "发送消息快捷键", exact: true })
    .getByRole("radio", { name: /\+ Enter$/ })
    .click();
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await page.reload();

  await input.fill("queued by the configured send key");
  await expect(queueButton).toHaveText("排队");
  await expect(steerButton).toHaveAttribute("title", /\+ Shift \+ Enter$/);
  await input.press("End");
  await input.press("Enter");
  await expect(input.locator("p")).toHaveCount(2);
  await input.press("ControlOrMeta+Enter");
  await expect(queue).toContainText("queued by the configured send key");
  await input.fill("[hang] steered by the shifted send key");
  await input.press("ControlOrMeta+Shift+Enter");
  await expect(turn.locator(".user-message").last()).toContainText(
    "steered by the shifted send key",
  );
  await expect(queue).toContainText("queued by the other button");
  await controls.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(turn).toHaveAttribute("data-status", "paused");
});

test("Topic steering uses the active model and saves the selected model for the next turn", async ({
  page,
}) => {
  await createAgent(page, "追加消息的模型提示");
  const mainComposer = page.locator(".chat-composer-wrap:visible");
  await mainComposer
    .getByRole("button", { name: "话题", exact: true })
    .click();
  await mainComposer
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("[hang] Topic with a running turn");
  await mainComposer.getByRole("button", { name: "发送", exact: true }).click();
  const topic = page.locator(".topic-thread");
  await expect(topic).toHaveAttribute("data-status", "running");
  await topic.getByRole("button", { name: "回复", exact: true }).click();

  const composer = page.locator(".topic-composer-wrap:visible");
  const model = composer.getByRole("button", { name: "选择模型和运行时" });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  await model.click();
  await picker.getByRole("button", { name: "GPT Review", exact: true }).click();
  await page.keyboard.press("Escape");
  const input = composer.getByRole("textbox", {
    name: "回复话题",
    exact: true,
  });
  await expect(input).toBeFocused();
  const turn = page.locator(".topic-conversation:visible .run-content");
  const direct = composer.locator(".composer-actions").getByRole("button", {
    name: "发送到当前执行",
    exact: true,
  });
  const hint = /追加时使用 GPT Test，下一轮默认使用 GPT Review/;
  await input.fill("[hang] Direct follow-up with a different model");
  await expect(direct).toBeEnabled();
  await expect(direct).toHaveAttribute("title", hint);
  await direct.click();
  await expect(turn.locator(".user-message").last()).toContainText(
    "Direct follow-up with a different model",
  );
  await expect(turn).toHaveAttribute("data-status", "running");
  await expect(model).toContainText("GPT Review");

  const message = "Queued follow-up with a different model";
  await input.fill(message);
  await composer.getByRole("button", { name: "加入队列", exact: true }).click();
  const queue = composer.getByRole("region", { name: "消息队列" });
  const steer = queue.getByRole("button", { name: "发送到当前执行" });
  await expect(steer).toBeEnabled();
  await expect(steer).toHaveAccessibleDescription(hint);
  await expect(queue.getByText(hint)).toBeVisible();

  const differentPermissions = "Queued with a different permission";
  await composer.getByRole("button", { name: /^权限 · / }).click();
  await page.getByRole("menuitemradio", { name: /^完全访问/ }).click();
  await input.fill(differentPermissions);
  await composer.getByRole("button", { name: "加入队列", exact: true }).click();
  const restricted = queue.locator("[data-queued-id]").filter({
    hasText: differentPermissions,
  });
  const restrictedSteer = restricted.getByRole("button", {
    name: "发送到当前执行",
  });
  await expect(restrictedSteer).toBeDisabled();
  await expect(restrictedSteer).toHaveAccessibleDescription(
    /相同的运行时和权限/,
  );
  await restricted.getByRole("button", { name: "移除排队消息" }).click();
  await expect(restricted).toHaveCount(0);

  await steer.click();
  await expect(queue).toHaveCount(0);
  await expect(turn).toHaveAttribute("data-status", "completed");
  await expect(turn.locator(".user-message").last()).toContainText(message);

  await page.reload();
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  await expect(model).toContainText("GPT Review");
  await input.fill("[wire] Next turn after steering");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(turn).toHaveCount(2);
  await expect(turn.last()).toHaveAttribute("data-status", "completed");
  await expect(turn.last()).toContainText('"model":"gpt-review"');
});

test("main and Topics execute independently with isolated queues, approvals and pause controls", async ({
  page,
}) => {
  await createAgent(page, "并行搭档");
  const composer = page.locator(".chat-composer-wrap");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const mode = composer.getByRole("button", { name: "话题", exact: true });
  const mainRuns = page.locator(".chat-panel .conversation > .run-content");
  await input.fill("[hang] main keeps running");
  await input.press("Enter");
  await expect(mainRuns).toHaveAttribute("data-status", "running");
  await input.fill("first queued message");
  await input.press("ControlOrMeta+Enter");
  const queue = composer.getByRole("region", { name: "消息队列" });
  const rows = queue.locator("[data-queued-id]");
  await expect(rows).toHaveCount(1);
  const firstID = await rows.first().getAttribute("data-queued-id");
  await input.fill("keep my draft");
  await rows
    .first()
    .getByRole("button", { name: "编辑排队消息", exact: true })
    .click();
  await expect(input).toBeFocused();
  await input.fill("edited independent task");
  await composer.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(input).toHaveText("keep my draft");
  await expect(rows.first()).toContainText("edited independent task");

  await mode.click();
  await expect(queue).not.toBeVisible();
  await expect(
    composer.getByRole("button", { name: "暂停回复", exact: true }),
  ).toHaveCount(0);
  await input.fill("[approval] Topic A");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  const topicA = page.locator(".topic-thread").filter({ hasText: "Topic A" });
  await expect(topicA).toHaveAttribute("data-status", "waiting_user");
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await input.fill("[hang] Topic B");
  await input.press("Enter");
  const topicB = page.locator(".topic-thread").filter({ hasText: "Topic B" });
  await expect(topicB).toHaveAttribute("data-status", "running");
  await expect(mainRuns).toHaveAttribute("data-status", "running");
  await expect(topicA).toHaveAttribute("data-status", "waiting_user");
  await expect(
    page.locator(".agent-contact.selected .pending-mark"),
  ).toHaveText("待处理 1");
  await expect(
    page.locator(".agent-contact.selected .agent-contact-status"),
  ).toContainText("2");

  await topicB.getByRole("button", { name: "回复", exact: true }).click();
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  await reply.fill("queued only in Topic B");
  await reply.press("ControlOrMeta+Enter");
  const topicQueue = page
    .locator(".topic-composer-wrap:visible")
    .getByRole("region", { name: "消息队列" });
  await expect(topicQueue).toContainText("queued only in Topic B");
  await expect(queue).not.toBeVisible();
  await expect(
    page
      .locator(".topic-conversation:visible")
      .getByRole("button", { name: "话题", exact: true }),
  ).toHaveCount(0);
  await reply.fill("/");
  await expect(page.getByRole("option", { name: /\/model/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /\/topic/ })).toHaveCount(0);
  await reply.press("Escape");
  await expect(page.locator(".topic-conversation:visible")).toBeVisible();
  await reply.fill("Topic B draft");
  await topicQueue
    .getByRole("button", { name: "编辑排队消息", exact: true })
    .click();
  await reply.fill("edited queue only in Topic B");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "保存修改", exact: true })
    .click();
  await expect(reply).toHaveText("Topic B draft");
  await expect(topicQueue).toContainText("edited queue only in Topic B");
  await topicA.getByRole("button", { name: "回复", exact: true }).click();
  await expect(reply).toHaveText("");
  await expect(topicQueue).not.toBeVisible();
  await reply.fill("Topic A draft");
  await expect(
    page.locator(".topic-composer-wrap:visible").getByRole("button", {
      name: "发送到当前执行",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.reload();
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await topicB.getByRole("button", { name: "回复", exact: true }).click();
  await expect(reply).toHaveText("Topic B draft");
  await expect(topicQueue).toContainText("edited queue only in Topic B");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "暂停回复", exact: true })
    .click();
  await expect(topicB).toHaveAttribute("data-status", "completed");
  await expect(topicQueue).not.toBeVisible();
  await expect(mainRuns).toHaveAttribute("data-status", "running");
  await expect(topicA).toHaveAttribute("data-status", "waiting_user");
  await mode.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("edited independent task");

  // Turning a queued main message into a Topic immediately starts its own session.
  await rows
    .first()
    .getByRole("button", { name: "将排队消息改为话题", exact: true })
    .click();
  await expect(
    page
      .locator(".topic-thread")
      .filter({ hasText: "edited independent task" }),
  ).toHaveAttribute("data-status", "completed");
  await expect(mainRuns).toHaveAttribute("data-status", "running");
  await input.fill("main follow-up");
  await input.press("ControlOrMeta+Enter");
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("main follow-up");
  await expect(topicA).toHaveAttribute("data-status", "waiting_user");
  await expect(topicB).toHaveAttribute("data-status", "completed");
  await input.fill("finish main");
  await input.press("Enter");
  await expect(queue).not.toBeVisible();
  await expect(mainRuns).toHaveCount(2);
  await expect(mainRuns.last()).toHaveAttribute("data-status", "completed");
  await expect(topicA).toHaveAttribute("data-status", "waiting_user");

  await topicA.getByRole("button", { name: "回复", exact: true }).click();
  const sidebar = page.locator(".topic-conversation:visible");
  await expect(sidebar).not.toContainText("queued only in Topic B");
  await sidebar
    .getByRole("button", { name: "仅允许此操作", exact: true })
    .click();
  await expect(topicA).toHaveAttribute("data-status", "completed");
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const view = (await (
    await page.request.get(`/api/chats/${overview.chats[0].id}`)
  ).json()) as ChatView;
  expect(view.entries.map((entry) => entry.kind)).toEqual([
    "main",
    "topic",
    "topic",
    "topic",
    "main",
  ]);
  expect(view.runs[1].id).toBe(firstID);
  expect(view.runs[1].input).toBe("edited independent task");
  expect(new Set(view.sessions.map((session) => session.nativeId)).size).toBe(
    4,
  );
  await page.screenshot({ path: "../output/e2e/parallel-topics.png" });
});

test("message actions preserve drafts and forward to an Agent with a note exactly once", async ({
  page,
}) => {
  await createAgent(page, "消息操作");
  await send(page, "请检查这段 **原始内容**。");
  const run = page.locator(".run-content").first();
  const answer = run.locator(".agent-message");
  await expect(answer.locator(".run-status")).toHaveCount(0);
  await expect(run.locator(".message-actions time")).toHaveCount(2);
  await expect(answer.locator("time")).toHaveAttribute("title", /\d/);
  const initial = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const sourceId = await run.getAttribute("data-run-id");
  const sourceView = (await (
    await page.request.get(`/api/chats/${initial.chats[0].id}`)
  ).json()) as ChatView;
  const source = sourceView.runs.find((item) => item.id === sourceId)!;
  const output = source.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("\n\n");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  await answer.getByRole("button", { name: "复制消息", exact: true }).click();
  await expect(
    answer.getByRole("button", { name: "已复制", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { copied: string }).copied),
  ).toBe(output);

  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  await input.fill("保留我的草稿 @hello");
  await page.getByRole("option", { name: "hello.go", exact: true }).click();
  const originalDraft = await input.textContent();
  const composer = page.locator(".chat-composer-wrap");
  await answer.getByRole("button", { name: "引用消息", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveText(originalDraft!);
  await expect(input.locator("[data-reference]")).toHaveText("hello.go");
  await expect(composer.locator(".message-quote")).toContainText(
    "回复 消息操作",
  );
  await expect(composer.locator(".message-quote")).toContainText(output);
  await composer.getByRole("button", { name: "取消引用", exact: true }).click();
  await expect(composer.locator(".message-quote")).toHaveCount(0);
  await expect(input).toHaveText(originalDraft!);
  await page.reload();
  await expect(composer.locator(".message-quote")).toHaveCount(0);
  await answer.getByRole("button", { name: "引用消息", exact: true }).click();
  await expect(composer.locator(".message-quote")).toHaveCount(1);
  await expect(input).toBeFocused();
  await page.reload();
  await expect(input.locator("[data-reference]")).toHaveText("hello.go");
  await expect(input).toHaveText(originalDraft!);
  await expect(composer.locator(".message-quote")).toHaveCount(1);
  await composer.screenshot({
    path: "../output/e2e/message-quote-composer.png",
    animations: "disabled",
  });

  const targetResponse = await page.request.post("/api/agents", {
    data: {
      name: "转发接收者",
      profile: initial.agents.find((agent) => agent.id === source.agentId)!
        .profile,
    },
  });
  expect(targetResponse.ok()).toBeTruthy();
  const target = (await targetResponse.json()) as Agent;
  await answer.getByRole("button", { name: "转发消息", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
  await expect(
    dialog.getByRole("button", { name: "转发", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("combobox", { name: "转发给", exact: true }).click();
  await page.getByRole("option", { name: target.name, exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "留言（可选）", exact: true })
    .fill("请从维护成本的角度复核。\n保留原文上下文。");
  await dialog.screenshot({ path: "../output/e2e/message-forward-light.png" });
  await page.route("**/api/messages", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await dialog.getByRole("button", { name: "转发", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "留言（可选）", exact: true }),
  ).toContainText("请从维护成本");
  await page.unroute("**/api/messages");
  await dialog.getByRole("button", { name: "转发", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const forwarded = page.locator(".run-content:visible");
  await expect(forwarded).toHaveCount(1);
  await expect(forwarded).toHaveAttribute("data-status", "completed");
  const after = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const targetChats = after.chats.filter((chat) => chat.agentId === target.id);
  expect(targetChats).toHaveLength(1);
  const targetView = (await (
    await page.request.get(`/api/chats/${targetChats[0].id}`)
  ).json()) as ChatView;
  expect(targetView.runs).toHaveLength(1);
  expect(targetView.runs[0].input).toBe(
    "请从维护成本的角度复核。\n保留原文上下文。",
  );
  expect(targetView.runs[0].quote).toEqual({
    runId: source.id,
    role: "assistant",
    author: "消息操作",
    text: output,
  });
  await expect(forwarded.locator(".user-message .message-quote")).toContainText(
    "回复 消息操作",
  );
  const savedDraft = await page.evaluate(
    (chatId) => localStorage.getItem(`lever:composer:${chatId}`),
    source.chatId,
  );
  expect(savedDraft).toContain("保留我的草稿");
});

test("quoting a topic message targets its reply and preserves the main draft", async ({
  page,
}) => {
  await createAgent(page, "话题引用");
  const main = page.getByRole("textbox", { name: "发送消息", exact: true });
  const mode = page
    .locator(".chat-composer-wrap")
    .getByRole("button", { name: "话题", exact: true });
  await mode.click();
  await send(page, "这个话题需要独立讨论。");
  await mode.click();
  await main.fill("主聊天草稿");
  const topic = page.locator(".topic-thread");
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  await reply.fill("已有的话题回复");
  const sidebar = page.getByRole("region", {
    name: "话题",
    exact: true,
  });
  await sidebar
    .locator(".user-message")
    .getByRole("button", { name: "引用消息", exact: true })
    .click();
  await expect(sidebar).toBeVisible();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("已有的话题回复");
  await expect(
    page.locator(".topic-composer-wrap:visible .message-quote"),
  ).toContainText("这个话题需要独立讨论。");
  await expect(main).toHaveText("主聊天草稿");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic).toHaveAttribute("data-status", "completed");
  await expect(reply).toHaveText("");
  const sessionId = await topic.getAttribute("data-session-id");
  const replies = (
    await (await page.request.get(`/api/sessions/${sessionId}/runs`)).json()
  ).runs as Run[];
  expect(replies).toHaveLength(2);
  expect(replies[0].input).toBe("已有的话题回复");
  expect(replies[0].quote).toEqual({
    runId: replies[1].id,
    role: "user",
    author: "User",
    text: "这个话题需要独立讨论。",
  });
  await expect(
    page.locator(".topic-composer-wrap:visible .message-quote"),
  ).toHaveCount(0);
  await page.reload();
  await topic.locator(".topic-open").click();
  await expect(sidebar.locator(".user-message .message-quote")).toContainText(
    "这个话题需要独立讨论。",
  );
  await sidebar.locator(".user-message").last().screenshot({
    path: "../output/e2e/message-quote-sent.png",
    animations: "disabled",
  });
});

test("cross-session quotes open the chosen composer and only send on submit", async ({
  page,
}) => {
  await createAgent(page, "跨会话引用");
  await send(page, "主线确定了接口约定。");
  const main = page.locator(".chat-composer-wrap:visible");
  const input = main.getByRole("textbox", { name: "发送消息", exact: true });
  const mode = main.getByRole("button", { name: "话题", exact: true });
  const dialog = page.getByRole("dialog", { name: "引用到…" });
  const quoteAction = { name: "引用到…", exact: true };
  const source = page
    .locator(".chat-panel:visible .run-content .user-message")
    .first();
  await input.fill("请在话题里复核这项约定");
  await source.getByRole("button", quoteAction).click();
  await dialog.getByRole("button", { name: "新话题", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveText("请在话题里复核这项约定");
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await expect(main.locator(".message-quote")).toContainText(
    "主线确定了接口约定。",
  );
  const topic = page.locator(".topic-thread");
  await expect(topic).toHaveCount(0);
  await send(page);

  await topic.locator(".topic-open").click();
  const panel = page.getByRole("region", { name: "话题", exact: true });
  const topicComposer = panel.locator(".topic-composer-wrap");
  const reply = topicComposer.getByRole("textbox", {
    name: "回复话题",
    exact: true,
  });
  await reply.fill("保留话题草稿");
  await input.fill("在主线继续");
  await panel
    .locator(".agent-message")
    .getByRole("button", quoteAction)
    .click();
  await dialog.getByRole("button", { name: "主对话", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(mode).toHaveAttribute("aria-pressed", "false");
  await expect(main.locator(".message-quote")).toContainText(
    "请在话题里复核这项约定",
  );
  await expect(reply).toHaveText("保留话题草稿");
  await expect(input).toHaveText("在主线继续");
  await send(page);

  await source.getByRole("button", quoteAction).click();
  await dialog
    .getByRole("button", { name: "请在话题里复核这项约定", exact: true })
    .click();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("保留话题草稿");
  await expect(topicComposer.locator(".message-quote")).toContainText(
    "主线确定了接口约定。",
  );
  const sessionId = await topic.getAttribute("data-session-id");
  const before = await page.request.get(`/api/sessions/${sessionId}/runs`);
  expect((await before.json()).runs).toHaveLength(1);
  await topicComposer
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic).toHaveAttribute("data-status", "completed");
  await expect(reply).toHaveText("");
  const after = await page.request.get(`/api/sessions/${sessionId}/runs`);
  const { runs } = (await after.json()) as { runs: Run[] };
  expect(runs[0].input).toBe("保留话题草稿");
  expect(runs[0].quote?.text).toBe("主线确定了接口约定。");
});

test("work duration uses persisted times and expands activity before the final answer", async ({
  page,
}) => {
  await createAgent(page, "工作时间");
  await send(page, "梳理项目结构。");
  await page.route("**/api/chats/*?before=*", async (route) => {
    const response = await route.fetch();
    const view = (await response.json()) as ChatView;
    const activity = Array.from({ length: 24 }, (_, index) => ({
      id: `activity-${index}`,
      kind: index % 2 === 0 ? "reasoning" : "tool",
      title: index % 2 === 0 ? "" : `读取模块 ${index + 1}`,
      text: index % 2 === 0 ? `检查模块 ${index + 1}。` : "",
      status: "completed",
    }));
    view.runs[0] = {
      ...view.runs[0],
      createdAt: "2026-11-06T05:00:00Z",
      startedAt: "2026-11-06T06:00:00Z",
      finishedAt: "2026-11-06T06:01:09Z",
      items: [
        {
          id: "progress",
          kind: "text",
          text: "先检查目录结构。",
          title: "",
          status: "completed",
        },
        {
          id: "tool",
          kind: "tool",
          title: "查看项目文件",
          text: "README.md\nweb/src",
          status: "completed",
        },
        {
          id: "update",
          kind: "text",
          text: "接着核对各模块。",
          title: "",
          status: "completed",
        },
        ...activity.slice(0, 12),
        {
          id: "empty-progress",
          kind: "text",
          text: "",
          title: "",
          status: "completed",
        },
        ...activity.slice(12),
        {
          id: "answer",
          kind: "text",
          text: "已确认入口与模块边界，接下来可以逐步梳理。",
          title: "",
          status: "completed",
        },
      ],
    };
    await route.fulfill({ response, json: view });
  });
  await page.reload();
  const message = page.locator(".agent-message");
  const work = message.getByRole("button", {
    name: "用时 1 分 9 秒",
    exact: true,
  });
  await expect(work).toHaveAttribute("aria-expanded", "false");
  await expect(
    message.getByText("先检查目录结构。", { exact: true }),
  ).not.toBeVisible();
  await expect(
    message.getByText("已确认入口与模块边界，接下来可以逐步梳理。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(message.locator("time")).toHaveAttribute(
    "datetime",
    "2026-11-06T06:01:09Z",
  );
  await expect(message.locator(".run-status")).toHaveCount(0);
  await page.screenshot({ path: "../output/e2e/message-actions-light.png" });
  await work.click();
  await expect(work).toHaveAttribute("aria-expanded", "true");
  await expect(
    message.getByText("先检查目录结构。", { exact: true }),
  ).toBeVisible();
  const tools = message.getByRole("button", {
    name: "1 次工具调用",
    exact: true,
  });
  await expect(tools).toHaveAttribute("aria-expanded", "false");
  await tools.click();
  await expect(
    message.getByText("查看项目文件", { exact: true }),
  ).toBeVisible();
  await expect(
    message.getByText("接着核对各模块。", { exact: true }),
  ).toBeVisible();
  const activity = message.locator(".run-activity").last();
  const summary = activity.getByRole("button", {
    name: "12 次工具调用",
    exact: true,
  });
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await summary.click();
  const details = activity.getByRole("region", { name: "执行过程" });
  await expect
    .poll(() =>
      details.evaluate((list) => list.scrollHeight - list.clientHeight),
    )
    .toBeGreaterThan(0);
  await details.press("End");
  await expect
    .poll(() => details.evaluate((list) => list.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    details.getByText("读取模块 24", { exact: true }),
  ).toBeInViewport();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await page.screenshot({
    path: "../output/e2e/message-work-dark.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await work.click();
  const footer = message.locator(".message-actions");
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  const box = (await footer.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(640);
  await page.screenshot({
    path: "../output/e2e/message-actions-narrow.png",
    animations: "disabled",
  });
  await page.reload();
  await expect(work).toHaveText("用时 1 分 9 秒");
});

test("same Chat mixes main messages and topic replies, survives reload, previews files and diff", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createAgent(page, "代码搭档");
  await send(page, "先梳理这个项目的结构。");
  const mode = page
    .locator(".chat-composer-wrap")
    .getByRole("button", { name: "话题", exact: true });
  await mode.click();
  await send(page, "单独讨论一下 API 的错误处理。");
  const topic = page.locator(".topic-thread");
  await expect(topic).toHaveCount(1);
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  await page
    .getByRole("textbox", { name: "回复话题", exact: true })
    .fill("给出一个可复用的方案。");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic.locator(".topic-preview")).toHaveCount(3);
  await expect(topic).toHaveAttribute("data-status", "completed");
  await mode.click();
  await send(page, "继续刚才的项目结构。");
  const data = (await page.evaluate(async () => {
    const overview = await (await fetch("/api/overview")).json();
    return (await fetch(`/api/chats/${overview.chats[0].id}`)).json();
  })) as ChatView;
  expect(data.entries.map((entry) => entry.kind)).toEqual([
    "main",
    "topic",
    "main",
  ]);
  expect(data.entries[0].sessionId).toBe(data.entries[2].sessionId);
  expect(data.entries[1].sessionId).not.toBe(data.entries[0].sessionId);
  expect(data.entries[1].replyCount).toBe(1);
  await page.reload();
  await expect(page.locator(".topic-thread")).toHaveCount(1);
  await expect(
    page.locator(".chat-panel .conversation > .run-content"),
  ).toHaveCount(2);
  await page.screenshot({
    path: "../output/e2e/mixed-chat-light.png",
    fullPage: true,
  });
  await topic.locator(".topic-open").click();
  const sidebar = page.getByRole("region", {
    name: "话题",
    exact: true,
  });
  await expect(sidebar.locator(".run-content")).toHaveCount(2);
  await expect(sidebar).toContainText("给出一个可复用的方案。");
  await page.screenshot({
    path: "../output/e2e/topic-sidebar-light.png",
    animations: "disabled",
  });
  await sidebar
    .getByRole("button", { name: "定位原消息", exact: true })
    .click();
  await expect(topic.locator(".topic-open")).toBeFocused();
  await closeTopic(page);
  await expect(sidebar).not.toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: "../output/e2e/mixed-chat-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await topic.locator(".topic-open").click();
  await page.screenshot({
    path: "../output/e2e/topic-sidebar-dark.png",
    animations: "disabled",
  });
  await closeTopic(page);
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("treeitem", { name: "hello.go", exact: true }).click();
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await expect(page.locator(".monaco-editor")).toContainText("hello Lever");
  await page.getByRole("button", { name: "Git 状态", exact: true }).click();
  await page.locator(".git-status-popover .git-status-action-row").click();
  await expect(page.locator("diffs-container")).toBeVisible();
  await page.screenshot({
    path: "../output/e2e/diff-dark.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "收起侧边分栏", exact: true }).click();
  await openMoreTool(page);
  await expect(page.getByLabel("系统指令", { exact: true })).toHaveValue(
    "Keep changes small and explain the result.",
  );
  await page.setViewportSize({ width: 720, height: 900 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "归档 Agent", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存 Agent", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "../output/e2e/profile-narrow.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("workspace Notes creates from the toolbar and animates its list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 900 });
  await createAgent(page, "笔记工具栏");
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "笔记", exact: true }).click();
  const notes = page.locator(".workspace-notes");
  const list = notes.getByRole("complementary", { name: "笔记" });
  const toggle = notes.locator(".workspace-notes-toggle");
  const add = notes.getByRole("button", { name: "新建笔记", exact: true });
  await expect(add).toHaveCount(1);
  await expect(list.getByRole("button", { name: "新建笔记" })).toHaveCount(0);
  const labelBox = (await list
    .getByText("笔记", { exact: true })
    .boundingBox())!;
  const toggleBox = (await toggle.boundingBox())!;
  expect(
    Math.abs(
      labelBox.y + labelBox.height / 2 - toggleBox.y - toggleBox.height / 2,
    ),
  ).toBeLessThan(1);

  const wide = await list.evaluate((node) => node.clientWidth);
  function toggleWidths(target: number) {
    return toggle.evaluate(async (button: HTMLButtonElement, target) => {
      const list = document.getElementById(
        button.getAttribute("aria-controls")!,
      )!;
      const widths = [list.clientWidth];
      button.click();
      do {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        widths.push(list.clientWidth);
      } while (widths.at(-1) !== target && widths.length < 90);
      return widths;
    }, target);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const target of [0, wide]) {
    const widths = await toggleWidths(target);
    expect(widths.some((w) => w > 0 && w < wide)).toBe(true);
    expect(widths.at(-1)).toBe(target);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const widths = await toggleWidths(0);
  expect(widths.every((w) => w === 0 || w === wide)).toBe(true);
  expect(widths.at(-1)).toBe(0);

  await add.click();
  const dialog = page.getByRole("dialog", { name: "新建笔记", exact: true });
  const title = "宽窄分栏笔记";
  await dialog.getByRole("textbox").fill(title);
  await dialog.getByRole("button", { name: "创建笔记", exact: true }).click();
  await expect(notes.getByRole("textbox", { name: "笔记名称" })).toHaveValue(
    title,
  );
  await page.setViewportSize({ width: 1120, height: 800 });
  await expect(notes).toHaveAttribute("data-compact", "true");
  await toggle.click();
  const editor = notes.getByRole("textbox", { name: "工作笔记", exact: true });
  await expect(editor).toBeHidden();
  await expect
    .poll(() => list.evaluate((node) => node.clientWidth))
    .toBe(await notes.evaluate((node) => node.clientWidth));
  const selected = list.getByRole("button", { name: title, exact: true });
  await expect(selected).toHaveAttribute("aria-current", "page");
  await selected.click();
  await expect(editor).toBeVisible();
  await expect(toggle).toBeFocused();
});

test("one Chat expands, switches and creates independent Topics beside Notes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1680, height: 900 });
  await createAgent(page, "分栏讨论");
  await send(page, "发布总览");
  const mode = page.getByRole("button", { name: "话题", exact: true });
  await mode.click();
  await send(page, "确认发布时间");
  await send(page, "核对回滚步骤");
  await mode.click();
  const mainDraft = page.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await mainDraft.fill("主对话草稿");
  const cards = page.locator(".topic-thread");
  const ids = await cards.evaluateAll((items) =>
    items.map((item) => item.getAttribute("data-session-id")!),
  );
  const { session } = (await (
    await page.request.get(`/api/sessions/${ids[0]}`)
  ).json()) as SessionView;
  const chat = (await (
    await page.request.get(`/api/chats/${session.chatId}`)
  ).json()) as ChatView;
  const main = chat.sessions.find((item) => item.kind === "main")!;
  const readTopics = async () =>
    (await (
      await page.request.get(`/api/chats/${session.chatId}/topics`)
    ).json()) as TopicSummary[];
  const summaries = await readTopics();
  const titles = ids.map(
    (id) => summaries.find((item) => item.id === id)!.title,
  );
  const noteId = randomUUID();
  expect(
    (
      await page.request.post("/api/tasks/notes", {
        data: { id: noteId, title: "发布检查清单" },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "笔记", exact: true }).click();
  const side = page.locator('.tab-strip[data-pane="side"]');
  const noteTab = side.getByRole("tab", { name: "笔记", exact: true });
  await expect(noteTab).toHaveAttribute("aria-selected", "true");
  const notes = page.locator(".workspace-notes");
  const directory = notes.getByRole("complementary", { name: "笔记" });
  await expect(directory).toBeVisible();
  const selectRelease = directory.getByRole("button", {
    name: "发布检查清单",
    exact: true,
  });
  await selectRelease.click();
  const note = notes.getByRole("textbox", { name: "工作笔记", exact: true });
  await note.fill("这是同一份发布笔记。");
  await notes.getByRole("button", { name: "新建笔记", exact: true }).click();
  const newNote = page.getByRole("dialog", { name: "新建笔记", exact: true });
  await newNote.getByRole("textbox").fill("回滚手册");
  await newNote.getByRole("button", { name: "创建笔记", exact: true }).click();
  await expect(note).toHaveText("");
  await note.fill("保留回滚快照。");
  await selectRelease.click();
  await expect(note).toContainText("这是同一份发布笔记。");
  await page.screenshot({
    path: testInfo.outputPath("notes-sidebar.png"),
    animations: "disabled",
  });
  await notes.getByRole("button", { name: "收起笔记列表" }).click();
  await expect(directory).toBeHidden();
  const settings = notes.getByRole("button", { name: "交接设置" });
  await expect(settings).toHaveText("");
  await settings.click();
  await expect(page.getByRole("dialog", { name: "交接设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  const totalTabs = await page.locator(".tab-strip [role=tab]").count();
  const expand = cards
    .first()
    .getByRole("button", { name: "在当前对话展开话题" });
  await expand.click();
  const sidebar = page.locator("#agent-sidebar");
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  const create = page.getByRole("textbox", { name: "新话题", exact: true });
  const detail = page.locator(".chat-topic-detail");
  const footer = page.locator(".chat-topic-view > .chat-composer-wrap");
  const collapse = footer.getByRole("button", { name: "收起并返回消息列表" });
  const headerCollapse = detail
    .locator("header")
    .getByRole("button", { name: "收起并返回消息列表" });
  await expect(page.locator(".chat-topic-view nav")).toHaveCount(0);
  await expect(detail.locator(".run-content").first()).toContainText(
    "确认发布时间",
  );
  await reply.fill("话题 A 的草稿");
  await expect(create).toHaveText("主对话草稿");
  await collapse.focus();
  await expect(collapse).toBeFocused();
  await expect(footer.locator("[data-composer-compact]")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(expand).toBeFocused();
  await expect(mainDraft).toHaveText("主对话草稿");
  await expect(mode).toHaveAttribute("aria-pressed", "false");
  await expect(cards).toHaveCount(2);
  await expand.click();
  await expect(reply).toHaveText("话题 A 的草稿");
  const sampleFocusMotion = () =>
    page.locator(".chat-topic-view").evaluate(async (panel) => {
      const reply = panel.querySelector<HTMLElement>(
        ".topic-composer-wrap .prompt-editor",
      )!;
      const chat = panel.querySelector<HTMLElement>(
        ".chat-composer-wrap .prompt-editor",
      )!;
      const history = panel.querySelector<HTMLElement>(
        ".topic-conversation .chat-scroll",
      )!;
      const frames: number[] = [];
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const view = panel.querySelector<HTMLElement>(".chat-view-content")!;
      await nextFrame();
      await Promise.all(
        [
          view,
          ...panel.querySelectorAll<HTMLElement>(
            ".composer-action-space, .prompt-root, .prompt-editor",
          ),
        ]
          .flatMap((el) => el.getAnimations())
          .map((animation) => animation.finished.catch(() => {})),
      );
      for (let i = 0; i < 30; i++) {
        if (i < 18 && i % 3 === 0)
          (i % 6 === 0 ? chat : reply).focus({ preventScroll: true });
        await nextFrame();
        frames.push(history.getBoundingClientRect().bottom);
      }
      return {
        drift: Math.max(...frames) - Math.min(...frames),
        focus: document.activeElement === reply,
      };
    });
  const singleLine = await sampleFocusMotion();
  expect(singleLine.focus).toBe(true);
  expect(singleLine.drift).toBeLessThanOrEqual(2);
  await create.fill("主对话草稿\n第二行");
  await reply.fill("话题 A 的草稿\n第二行");
  const multiLine = await sampleFocusMotion();
  expect(multiLine.focus).toBe(true);
  // Reply and Chat have slightly different line heights.
  expect(multiLine.drift).toBeLessThanOrEqual(3);
  await reply.fill("话题 A 的草稿");
  await create.fill("独立话题的草稿");
  await expect(
    footer.locator(".composer-actions-trigger + .topic-collapse"),
  ).toBeVisible();
  await footer.screenshot({
    path: testInfo.outputPath("return-in-chat-toolbar.png"),
    animations: "disabled",
  });
  await headerCollapse.focus();
  await expect(footer.locator("[data-composer-compact]")).toHaveCount(0);
  await headerCollapse.press("Enter");
  await expect(expand).toBeFocused();
  await expect(mainDraft).toHaveText("独立话题的草稿");
  await mainDraft.fill("列表里补充的草稿");
  await expand.click();
  await expect(reply).toHaveText("话题 A 的草稿");
  await expect(create).toHaveText("列表里补充的草稿");
  const secondRow = sidebar.locator(`[data-session-id="${ids[1]}"]`);
  await secondRow.click();
  await expect(secondRow).toHaveAttribute("aria-current", "true");
  await expect(detail.locator(".run-content").first()).toContainText(
    "核对回滚步骤",
  );
  await expect(reply).toHaveText("");
  await expect(create).toHaveText("列表里补充的草稿");
  await reply.fill("回滚前先保存清单");
  const replyResult = page.waitForResponse(
    (r) => r.url().endsWith("/api/messages") && r.request().method() === "POST",
  );
  await reply.press("Enter");
  expect(((await (await replyResult).json()) as Run).sessionId).toBe(ids[1]);
  await expect(detail.locator(".run-content").last()).toHaveAttribute(
    "data-status",
    "completed",
  );
  await create.fill("复测冷启动");
  const newResult = page.waitForResponse(
    (r) => r.url().endsWith("/api/messages") && r.request().method() === "POST",
  );
  await create.press("Enter");
  const newRun = (await (await newResult).json()) as Run;
  expect(newRun.operation).toBe("topic");
  expect(newRun.chatId).toBe(session.chatId);
  expect(ids).not.toContain(newRun.sessionId);
  await expect(
    sidebar.locator(`[data-session-id="${newRun.sessionId}"]`),
  ).toHaveAttribute("aria-current", "true");
  await expect(detail.locator(".run-content").first()).toContainText(
    "复测冷启动",
  );
  await expect(note).toContainText("这是同一份发布笔记。");
  await expect(noteTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tab-strip [role=tab]")).toHaveCount(totalTabs);
  await expect(reply).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("expanded-with-notes.png"),
    animations: "disabled",
  });

  await page.setViewportSize({ width: 1120, height: 800 });
  const showDirectory = notes.getByRole("button", { name: "展开笔记列表" });
  await showDirectory.click();
  await expect(note).toBeHidden();
  await directory
    .getByRole("button", { name: "回滚手册", exact: true })
    .click();
  await expect(note).toHaveText("保留回滚快照。");
  await expect(showDirectory).toBeFocused();
  await showDirectory.click();
  await selectRelease.click();
  await expect(note).toHaveText("这是同一份发布笔记。");
  const picker = detail.getByRole("button", { name: "切换话题" });
  await picker.click();
  await page
    .getByRole("menuitemradio", { name: titles[0], exact: true })
    .click();
  await expect(reply).toHaveText("话题 A 的草稿");
  await expect(create).toHaveText("");
  await create.fill("两个视图共用的草稿");
  await page.reload();
  await expect(reply).toHaveText("话题 A 的草稿");
  await expect(note).toContainText("这是同一份发布笔记。");
  await page.screenshot({
    path: testInfo.outputPath("compact-with-notes.png"),
    animations: "disabled",
  });
  await collapse.click();
  await expect(mainDraft).toHaveText("两个视图共用的草稿");
  await expect(cards).toHaveCount(3);
  await expect(page.locator(".chat-topic-view")).toHaveCount(0);
  await expect(noteTab).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: testInfo.outputPath("message-list-with-notes.png"),
    animations: "disabled",
  });

  await expand.click();
  await expect(page.locator(".chat-topic-view")).toHaveCount(1);
  await sidebar.locator(`[data-session-id="${main.id}"]`).click();
  await expect(page.locator(".chat-topic-view")).toHaveCount(0);
  await expect(mainDraft).toHaveText("两个视图共用的草稿");
  await expect(noteTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tab-strip [role=tab]")).toHaveCount(totalTabs);

  await secondRow.click();
  const secondTopicTab = side.getByRole("tab", {
    name: titles[1],
    exact: true,
  });
  await expect(secondTopicTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".chat-topic-view")).toHaveCount(0);
  await expect(
    page.locator(".topic-conversation:visible .run-content").first(),
  ).toContainText("核对回滚步骤");

  await side.getByRole("button", { name: "打开标签", exact: true }).click();
  await page.getByRole("menuitem", { name: "浏览器", exact: true }).click();
  const browser = side.getByRole("tab", { name: "浏览器", exact: true });
  await expect(browser).toHaveAttribute("aria-selected", "true");
  await cards
    .first()
    .getByRole("button", { name: "回复", exact: true })
    .click();
  const firstTopicTab = side.getByRole("tab", {
    name: titles[0],
    exact: true,
  });
  await expect(firstTopicTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".chat-topic-view")).toHaveCount(0);
  await expect(reply).toHaveText("话题 A 的草稿");
  await expect(mainDraft).toHaveText("两个视图共用的草稿");

  await browser.click();
  await expect(browser).toHaveAttribute("aria-selected", "true");
  await cards.first().locator(".topic-open").click();
  await expect(firstTopicTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".chat-topic-view")).toHaveCount(0);

  await browser.click();
  await expect(browser).toHaveAttribute("aria-selected", "true");
  await expand.click();
  await expect(page.locator(".chat-topic-view")).toHaveCount(1);
  await expect(reply).toHaveText("话题 A 的草稿");
  await expect(browser).toHaveAttribute("aria-selected", "true");
  await collapse.click();
  await expect(expand).toBeFocused();
  await expect(mainDraft).toHaveText("两个视图共用的草稿");

  const oldDraftKey = `lever:composer:new-topic:${session.chatId}`;
  await page.evaluate(
    (key) =>
      localStorage.setItem(key, JSON.stringify({ text: "旧版展开草稿" })),
    oldDraftKey,
  );
  await page.reload();
  await expect(mainDraft).toHaveText("两个视图共用的草稿");
  await mainDraft.press("Enter");
  await expect(mainDraft).toHaveText("旧版展开草稿");
  expect(
    await page.evaluate((key) => localStorage.getItem(key), oldDraftKey),
  ).toBeNull();
});

test("disabling automatic Topic opening persists and keeps the current Topic", async ({
  page,
}) => {
  await createAgent(page, "话题打开偏好");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await navigation.getByRole("button", { name: "设置", exact: true }).click();
  const preference = page.getByRole("switch", { name: "创建后打开新话题" });
  await expect(preference).toBeChecked();
  await preference.press("Space");
  await expect(preference).not.toBeChecked();
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  await page.reload();

  await send(page, "工作总览");
  await page.getByRole("button", { name: "话题", exact: true }).click();
  await send(page, "当前话题");
  await page.getByRole("button", { name: "在当前对话展开话题" }).click();
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  await reply.fill("留在当前话题的草稿");
  const launcher = page.getByRole("textbox", { name: "新话题", exact: true });
  await launcher.fill("稍后再看");
  await launcher.press("Enter");

  await expect(page.getByText("已创建新话题", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-topic-detail .run-content")).toContainText(
    "当前话题",
  );
  await expect(reply).toHaveText("留在当前话题的草稿");
  await expect(launcher).toHaveText("");
});

test("a pending Topic creation does not replace a Topic selected while waiting", async ({
  page,
}) => {
  await createAgent(page, "话题切换保护");
  await send(page, "工作总览");
  await page.getByRole("button", { name: "话题", exact: true }).click();
  await send(page, "出发话题");
  await send(page, "随后切换到的话题");
  const cards = page.locator(".topic-thread");
  const selectedId = await cards.nth(1).getAttribute("data-session-id");
  await cards
    .first()
    .getByRole("button", { name: "在当前对话展开话题" })
    .click();

  const submitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    "**/api/messages",
    async (route) => {
      submitted.resolve();
      await release.promise;
      await route.continue();
    },
    { times: 1 },
  );
  const launcher = page.getByRole("textbox", { name: "新话题", exact: true });
  const selected = page.locator(
    `#agent-sidebar [data-session-id="${selectedId}"]`,
  );
  await launcher.fill("等待创建的话题");
  await launcher.press("Enter");
  try {
    await submitted.promise;
    await selected.click();
    await expect(selected).toHaveAttribute("aria-current", "true");
  } finally {
    release.resolve();
  }
  await expect(page.getByText("已创建新话题", { exact: true })).toBeVisible();
  await expect(selected).toHaveAttribute("aria-current", "true");
});

test("a long Topic title keeps Back visible and scrolls older choices into the short menu", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1120, height: 800 });
  await createAgent(page, "话题导航");
  await page.getByRole("button", { name: "话题", exact: true }).click();
  const rootTitle =
    "@docs/remote-devices.md 基于这个方案重新 review，看看交互能否更优雅通用。".repeat(
      4,
    );
  await send(page, rootTitle);
  const card = page.locator(".topic-thread").first();
  const id = await card.getAttribute("data-session-id");
  const { session, root } = (await (
    await page.request.get(`/api/sessions/${id}`)
  ).json()) as SessionView;
  await card.getByRole("button", { name: "在当前对话展开话题" }).click();
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "笔记", exact: true }).click();
  const header = page.locator(".chat-topic-header");
  const picker = header.getByRole("button", { name: "切换话题" });
  const headerBack = header.getByRole("button", { name: "收起并返回消息列表" });
  const composer = page.locator(
    ".chat-topic-view > .chat-composer-wrap .composer",
  );
  const back = composer.getByRole("button", { name: "收起并返回消息列表" });
  await expect(picker).toContainText("remote-devices.md");
  await expect(
    page.getByRole("button", { name: "收起并返回消息列表" }),
  ).toHaveCount(2);
  await expect(headerBack).toBeVisible();
  await expect(back).toBeVisible();
  const box = await composer.boundingBox();
  const backBox = await back.boundingBox();
  expect(backBox!.x).toBeGreaterThanOrEqual(box!.x);
  expect(backBox!.x + backBox!.width).toBeLessThanOrEqual(box!.x + box!.width);
  expect(backBox!.y).toBeGreaterThanOrEqual(box!.y);
  expect(backBox!.y + backBox!.height).toBeLessThanOrEqual(
    box!.y + box!.height,
  );
  await composer.screenshot({
    path: testInfo.outputPath("return-in-compact-chat.png"),
    animations: "disabled",
  });
  const pickerBox = await picker.boundingBox();
  const headerBackBox = await headerBack.boundingBox();
  expect(headerBackBox!.x).toBeGreaterThan(pickerBox!.x + pickerBox!.width);
  expect(
    await picker
      .locator("span")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true);
  const pageRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(`/chats/${session.chatId}/topics`))
      pageRequests.push(req.url());
  });
  const titles = Array.from(
    { length: 16 },
    (_, i) => `验证设备接入步骤 ${i + 1}`,
  );
  for (const text of titles) {
    const result = await page.request.post("/api/messages", {
      data: {
        chatId: session.chatId,
        commandId: randomUUID(),
        operation: "topic",
        text,
        selection: root!.selection,
        attachmentIds: [],
      },
    });
    expect(result.ok()).toBe(true);
  }
  expect(pageRequests).toHaveLength(0);
  await picker.click();
  const menu = page.getByRole("menu", { name: "切换话题" });
  const options = menu.getByRole("menuitemradio");
  await expect(options).toHaveCount(12);
  expect(await menu.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(192);
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  expect(
    pageRequests.every((url) => new URL(url).pathname.endsWith("/topics/page")),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("topic-menu.png"),
    animations: "disabled",
  });
  await menu.hover();
  await page.mouse.wheel(0, 500);
  await expect(options).toHaveCount(17);
  expect(new Set(await options.allTextContents()).size).toBe(17);
  await menu
    .getByRole("menuitemradio", { name: titles[0], exact: true })
    .click();
  await expect(picker).toContainText(titles[0]);
  await expect(
    page.locator(".chat-topic-detail .run-content").first(),
  ).toContainText(titles[0]);
  await headerBack.click();
  await expect(header).toHaveCount(0);
});

test("topic previews stay recent while its tab loads full history and preserves drafts", async ({
  page,
}) => {
  await createAgent(page, "话题记录");
  await page
    .locator(".chat-composer-wrap")
    .getByRole("button", { name: "话题", exact: true })
    .click();
  await send(page, "完整保留这个话题的讨论记录。");
  const topic = page.locator(".topic-thread");
  const sessionId = await topic.getAttribute("data-session-id");
  const initial = (
    await (await page.request.get(`/api/sessions/${sessionId}/runs`)).json()
  ).runs as Run[];
  for (let i = 1; i <= 41; i++) {
    const response = await page.request.post("/api/messages", {
      data: {
        commandId: crypto.randomUUID(),
        chatId: initial[0].chatId,
        sessionId,
        operation: "reply",
        text: `第 ${i} 次补充`,
        selection: initial[0].selection,
        attachmentIds: [],
      },
    });
    expect(response.ok()).toBeTruthy();
    const run = (await response.json()) as Run;
    await expect
      .poll(
        async () => {
          const rows = (
            await (
              await page.request.get(`/api/sessions/${sessionId}/runs`)
            ).json()
          ).runs as Run[];
          return `${rows[0].id}:${rows[0].status}`;
        },
        { intervals: [50, 100] },
      )
      .toBe(`${run.id}:completed`);
  }
  await expect(topic.locator(".topic-preview")).toHaveCount(3);
  await expect(topic.locator(".topic-previews")).toContainText("第 41 次补充");
  await expect(topic.locator(".topic-previews")).not.toContainText(
    "第 1 次补充",
  );
  // Mark the topic read so opening it does not page back to the first unread reply.
  const activity = page.locator(
    `#agent-sidebar [data-session-id="${sessionId}"]`,
  );
  await expect(activity.locator(".agent-unread")).toBeVisible();
  await activity.click({ button: "right" });
  await page.getByRole("menuitem", { name: "标为已读", exact: true }).click();
  await expect(activity.locator(".agent-unread")).toHaveCount(0);
  let earlierRequests = 0;
  await page.route(
    `**/api/sessions/${sessionId}/runs?before=*`,
    async (route) => {
      const before = new URL(route.request().url()).searchParams.get("before");
      if (before === "0") return route.continue();
      earlierRequests++;
      await route.fulfill({
        status: 503,
        body: "History temporarily unavailable",
      });
    },
  );
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "回复话题", exact: true });
  await draft.fill("尚未发送的补充意见");
  await closeTopic(page);
  await topic.locator(".topic-open").click();
  await expect(draft).toHaveText("尚未发送的补充意见");
  const sidebar = page.getByRole("region", {
    name: "话题",
    exact: true,
  });
  const scroll = sidebar.locator(".chat-scroll");
  await expect(sidebar.locator(".run-content").last()).toContainText(
    "第 41 次补充",
  );
  expect(earlierRequests).toBe(0);
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(sidebar.getByRole("alert")).toContainText(
    "History temporarily unavailable",
  );
  await expect(sidebar.locator(".run-content").first()).toContainText(
    "完整保留这个话题的讨论记录。",
  );
  await page.unroute(`**/api/sessions/${sessionId}/runs?before=*`);
  await sidebar.getByRole("alert").getByRole("button").click();
  await expect(sidebar.locator('[data-index="1"]')).toContainText(
    "第 1 次补充",
  );
  await expect(sidebar.getByRole("alert")).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "加载较早回复" }),
  ).toHaveCount(0);
  await expect(topic.locator(".topic-preview")).toHaveCount(3);
  await expect(topic.locator(".topic-previews")).toContainText("第 41 次补充");
  await page.setViewportSize({ width: 560, height: 900 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  await expect(page.locator(".chat-panel")).not.toBeVisible();
  await expect(sidebar).toBeVisible();
  const panel = await sidebar.boundingBox();
  expect(panel!.width).toBeLessThanOrEqual(560);
  await page.screenshot({
    path: "../output/e2e/topic-sidebar-narrow.png",
    animations: "disabled",
  });
  await sidebar.getByRole("textbox", { name: "回复话题", exact: true }).click();
  await expect(sidebar).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveText("尚未发送的补充意见");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic).toHaveAttribute("data-status", "completed");
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(topic.locator(".topic-previews")).toContainText(
    "尚未发送的补充意见",
  );
  await page.reload();
  await expect(topic.locator(".topic-previews")).toContainText(
    "尚未发送的补充意见",
  );
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  await expect(draft).toHaveText("");
  await send(page, "另一个独立的话题。");
  const topics = page.locator(".topic-thread");
  await topics.first().locator(".topic-open").click();
  await expect(sidebar.locator(".run-content").last()).toContainText(
    "尚未发送的补充意见",
  );
  await scroll.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(sidebar.locator('[data-index="1"]')).toContainText(
    "第 1 次补充",
  );
  await draft.fill("第一个话题的草稿");
  await topics.last().locator(".topic-open").click();
  await expect(draft).toHaveText("");
  await expect(sidebar.locator(".run-content")).toHaveCount(1);
  await expect(sidebar).toContainText("另一个独立的话题。");
  await expect(sidebar).not.toContainText("第 41 次补充");
  await draft.fill("第二个话题的草稿");
  await topics.first().locator(".topic-open").click();
  await expect(draft).toHaveText("第一个话题的草稿");
  await topics.last().locator(".topic-open").click();
  await expect(draft).toHaveText("第二个话题的草稿");
});

test("a delegation opens its Agent's Chat while native subagents stay in the Topic", async ({
  page,
}) => {
  await createAgent(page, "供应商评审 Agent");
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const sender = overview.agents.find(
    ({ name }) => name === "供应商评审 Agent",
  )!;
  const buyerResponse = await page.request.post("/api/agents", {
    data: { name: "采购 Agent", profile: sender.profile },
  });
  expect(buyerResponse.ok()).toBe(true);
  const buyer = (await buyerResponse.json()) as Agent;
  const updated = await page.request.put(`/api/agents/${sender.id}`, {
    data: {
      ...sender,
      profile: {
        ...sender.profile,
        delegations: [{ agentId: buyer.id, confirm: true }],
      },
    },
  });
  expect(updated.ok()).toBe(true);

  const composer = page.locator(".chat-composer-wrap");
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await composer
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill(`[delegate:${buyer.id}] [subagents]`);
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  const thread = page.locator(".topic-thread");
  await thread.getByRole("button", { name: "回复", exact: true }).click();
  const topic = page.locator(".topic-conversation:visible");
  const nativeApproval = topic.getByRole("group", {
    name: /来自子代理 · check sources/,
  });
  await nativeApproval.getByRole("button", { name: "仅允许此操作" }).click();
  await topic
    .getByRole("group", { name: "委派给 采购 Agent" })
    .getByRole("button", { name: "仅允许此操作" })
    .click();
  await expect(topic.locator(".run-content")).toHaveAttribute(
    "data-status",
    "completed",
  );

  const activity = topic.getByRole("button", { name: /执行过程.*2 个子代理/ });
  if ((await activity.getAttribute("aria-expanded")) === "false")
    await activity.click();
  await expect(
    topic.getByText("Compare schedules", { exact: true }).locator(".."),
  ).toContainText("结果待确认");
  await topic.getByRole("button", { name: /check sources.*已完成/ }).click();
  await expect(
    topic.getByText("Checked both source references.", { exact: false }),
  ).toBeVisible();

  const handoff = topic.getByRole("button", {
    name: /采购 Agent.*已完成.*打开会话/,
  });
  await page.screenshot({
    path: test.info().outputPath("delegation-and-subagents.png"),
    animations: "disabled",
  });
  await handoff.click();
  const receiver = page.locator(".chat-panel:visible");
  await expect(
    receiver.getByText("Review the implementation", { exact: true }).first(),
  ).toBeVisible();
  await receiver
    .getByRole("button", { name: "返回 供应商评审 Agent 的委派消息" })
    .click();
  await expect(handoff).toBeVisible();
  await page.reload();
  await expect(handoff).toBeVisible();
  await page.setViewportSize({ width: 430, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(handoff).toBeVisible();
  expect(
    await handoff.evaluate(
      (button) => button.scrollWidth <= button.clientWidth,
    ),
  ).toBe(true);
});

test("approval and pause controls operate on the owning run", async ({
  page,
}) => {
  await createAgent(page, "审阅搭档");
  await page
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("[approval]");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "仅允许此操作", exact: true }).click();
  await expect(page.locator(".run-content").last()).toHaveAttribute(
    "data-status",
    "completed",
  );
  await page
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("[pausable] Main reply");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const running = page.locator(".run-content").last();
  await expect(
    running.getByText("Partial reply before the pause", { exact: true }),
  ).toHaveCount(1);
  const mainRunId = await running.getAttribute("data-run-id");
  await expect(running).toHaveAttribute("data-status", "running");
  await expect(running.locator(".run-status")).toHaveCount(0);
  await expect(
    running.getByRole("button", { name: "暂停回复", exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".chat-composer-wrap")
    .getByRole("button", { name: "暂停回复", exact: true })
    .click();
  await expect(page.locator(".run-content").last()).toHaveAttribute(
    "data-status",
    "paused",
  );
  await expect(
    running.getByRole("status").filter({ hasText: "已暂停" }),
  ).toBeVisible();
  await expect(
    running.getByRole("button", { name: "重试", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  const resume = running.getByRole("button", { name: "继续", exact: true });
  await expect(resume).toBeEnabled();
  await resume.focus();
  await resume.press("Enter");
  await expect(running).toHaveAttribute("data-status", "completed");
  await expect(running).toHaveAttribute("data-run-id", mainRunId!);
  await expect(
    running.getByText("Partial reply before the pause", { exact: true }),
  ).toHaveCount(1);
  await expect(running).toContainText("Continued from the saved native turn");
  await expect(page.locator(".run-content")).toHaveCount(2);
  const composer = page.locator(".chat-composer-wrap");
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await composer
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("[approval] 话题内审批");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  const topic = page.locator(".topic-thread");
  await expect(topic).toHaveAttribute("data-status", "waiting_user");
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  const sidebar = page.getByRole("region", {
    name: "话题",
    exact: true,
  });
  await sidebar
    .getByRole("button", { name: "仅允许此操作", exact: true })
    .click();
  await expect(sidebar.locator(".run-content")).toHaveAttribute(
    "data-status",
    "completed",
  );
  await sidebar.getByRole("textbox", { name: "回复话题", exact: true }).click();
  await page
    .getByRole("textbox", { name: "回复话题", exact: true })
    .fill("[hang]");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic).toHaveAttribute("data-status", "running");
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  const topicRun = sidebar.locator(".run-content").last();
  await expect(topicRun).toHaveAttribute("data-status", "running");
  await expect(topicRun.locator(".run-status")).toHaveCount(0);
  await expect(
    topicRun.getByRole("button", { name: "暂停回复", exact: true }),
  ).toHaveCount(0);
  await sidebar
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "暂停回复", exact: true })
    .click();
  await expect(sidebar.locator(".run-content").last()).toHaveAttribute(
    "data-status",
    "paused",
  );
  await expect(sidebar.locator(".run-content").first()).toHaveAttribute(
    "data-status",
    "completed",
  );
  await topic.getByRole("button", { name: "继续", exact: true }).click();
  await expect(topicRun).toHaveAttribute("data-status", "completed");
  await expect(topicRun).toContainText("Continued from the saved native turn");
  await expect(sidebar.locator(".run-content")).toHaveCount(2);
});

test("Claude Code continues a paused reply after reload", async ({ page }) => {
  await createAgent(page, "Claude 续接");
  const composer = page.locator(".chat-composer-wrap");
  await composer.getByRole("button", { name: "选择模型和运行时" }).click();
  await page.getByRole("radio", { name: "Claude Code", exact: true }).click();
  await page.keyboard.press("Escape");
  await composer
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("[pausable] Claude reply");
  await composer.getByRole("button", { name: "发送", exact: true }).click();

  const run = page.locator(".chat-panel .conversation > .run-content");
  await expect(run).toContainText("Partial reply before the pause");
  const runId = (await run.getAttribute("data-run-id"))!;
  await composer.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(run).toHaveAttribute("data-status", "paused");
  await page.reload();
  await run.getByRole("button", { name: "继续", exact: true }).click();
  await expect(run).toHaveAttribute("data-status", "completed");
  await expect(run).toHaveAttribute("data-run-id", runId);
  await expect(
    run.getByText("Partial reply before the pause", { exact: true }),
  ).toHaveCount(1);
  await expect(run).toContainText("Continued from the saved native turn");
});

test("sending and editing a paused reply start new executions", async ({
  page,
}) => {
  await createAgent(page, "暂停后发送");
  const composer = page.locator(".chat-composer-wrap");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const runs = page.locator(".chat-panel .conversation > .run-content");
  await input.fill("[pausable] First prompt");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(runs.first()).toContainText("Partial reply before the pause");
  await composer.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(runs.first()).toHaveAttribute("data-status", "paused");

  await input.fill("[pausable] New prompt");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(runs).toHaveCount(2);
  await expect(runs.first()).toHaveAttribute("data-status", "interrupted");
  await expect(runs.last()).toContainText("New prompt");

  await composer.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "paused");
  const replacedId = await runs.last().getAttribute("data-run-id");
  await runs.last().getByRole("button", { name: "从这里编辑" }).click();
  await input.fill("Revised prompt");
  await composer.getByRole("button", { name: "修改并重发" }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  await expect(runs.last()).not.toHaveAttribute("data-run-id", replacedId!);
  await expect(runs.last()).toContainText("Revised prompt");
});

test("editing a sent Chat message restores the draft and resends once after a lost response", async ({
  page,
}) => {
  await createAgent(page, "Edit sent Chat");
  await send(page, "Retained Chat prompt");
  const composer = page.locator(".chat-composer-wrap");
  const input = composer.getByRole("textbox", { name: "发送消息" });
  const runs = page.locator(".chat-panel .conversation > .run-content");
  await runs
    .first()
    .locator(".user-message")
    .getByRole("button", {
      name: "引用消息",
      exact: true,
    })
    .click();
  await composer.getByLabel("选择附件", { exact: true }).setInputFiles({
    name: "edit-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Attached notes"),
  });
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await input.fill("Original prompt @hello");
  await page.getByRole("option", { name: "hello.go", exact: true }).click();
  await send(page);
  const original = runs.nth(1);
  const originalId = (await original.getAttribute("data-run-id"))!;
  await send(page, "Superseded Chat follow-up");
  await input.fill("Independent composer draft");

  const edit = original
    .locator(".user-message")
    .getByRole("button", { name: "从这里编辑" });
  await edit.focus();
  await edit.press("Enter");
  await expect(input).toBeFocused();
  await expect(input.locator("[data-reference]")).toHaveText("hello.go");
  await expect(composer.locator(".prompt-placeholder")).toHaveCount(0);
  await expect(composer.locator(".composer-quote")).toContainText(
    "Retained Chat prompt",
  );
  await expect(composer.locator(".attachment-chip")).toContainText(
    "edit-notes.txt",
  );
  await expect(runs).toHaveCount(3);
  await composer.getByRole("button", { name: "取消编辑已发送消息" }).click();
  await expect(input).toHaveText("Independent composer draft");
  await expect(runs).toHaveCount(3);

  await edit.click();
  await expect(input).toContainText("Original prompt");
  await input.press("End");
  await page.keyboard.insertText(" revised");
  await page.reload();
  await expect(input).toContainText("revised");
  const resend = composer.getByRole("button", { name: "修改并重发" });
  let accepted: Run | undefined;
  let commandId = "";
  await page.route(
    "**/api/messages",
    async (route) => {
      const payload = route.request().postDataJSON();
      commandId = payload.commandId;
      expect(payload.replaceRunId).toBe(originalId);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      accepted = await response.json();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await resend.click();
  await expect(composer.getByRole("alert")).toBeVisible();
  await expect(runs).toHaveCount(2);
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  const replay = page.waitForResponse((response) =>
    response.url().endsWith("/api/messages"),
  );
  await resend.click();
  const response = await replay;
  expect(response.request().postDataJSON().commandId).toBe(commandId);
  expect((await response.json()).id).toBe(accepted!.id);
  await expect(input).toHaveText("Independent composer draft");
  await expect(runs.last().locator(".user-message")).toContainText("revised");
  await expect(
    runs.last().locator(".user-message .attachment-chip"),
  ).toContainText("edit-notes.txt");
  await expect(runs).toHaveCount(2);
});

test("editing a Topic root from its preview keeps its place in the Chat", async ({
  page,
}) => {
  await createAgent(page, "Edit sent Topic");
  await send(page, "Main before Topic");
  const mainComposer = page.locator(".chat-composer-wrap");
  await mainComposer
    .getByRole("button", { name: "话题", exact: true })
    .click();
  await send(page, "Original Topic root");
  const topic = page.locator(".topic-thread");
  const sessionId = await topic.getAttribute("data-session-id");
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  const panel = page.locator(".topic-conversation:visible");
  const composer = panel.locator(".topic-composer-wrap");
  const input = composer.getByRole("textbox", {
    name: "回复话题",
    exact: true,
  });
  const runs = panel.locator(".run-content");
  await input.fill("Topic follow-up to replace");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(runs).toHaveCount(2);
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  await input.fill("Unsent Topic draft");
  await closeTopic(page);
  const mode = mainComposer.getByRole("button", { name: "话题", exact: true });
  if ((await mode.getAttribute("aria-pressed")) === "true") await mode.click();
  await send(page, "Main after Topic");

  await topic.getByRole("button", { name: "从这里编辑" }).click();
  await expect(input).toHaveText("Original Topic root");
  await input.fill("Revised Topic root");
  await composer.getByRole("button", { name: "修改并重发" }).click();
  await expect(runs).toHaveCount(1);
  await expect(runs.first()).toHaveAttribute("data-status", "completed");
  await expect(input).toHaveText("Unsent Topic draft");
  await expect(topic).toHaveAttribute("data-session-id", sessionId!);
  await expect(topic.locator(".user-message")).toContainText(
    "Revised Topic root",
  );
  await expect(
    page.getByRole("tab", { name: "Revised Topic root", exact: true }),
  ).toBeVisible();
  const entries = page.locator(
    ".chat-panel .conversation > :is(.run-content, .topic-thread)",
  );
  await expect(entries).toHaveCount(3);
  await expect(entries.first()).toContainText("Main before Topic");
  await expect(entries.nth(1)).toHaveClass(/topic-thread/);
  await expect(entries.nth(2)).toContainText("Main after Topic");
});

test("retrying a failed Chat message reuses its payload and leaves the queue paused", async ({
  page,
}) => {
  await createAgent(page, "消息重试");
  await send(page, "供后续消息引用的内容");
  const runs = page.locator(".chat-panel .conversation > .run-content");
  const composer = page.locator(".chat-composer-wrap");
  const input = composer.getByRole("textbox", { name: "发送消息" });
  await runs
    .first()
    .locator(".user-message")
    .getByRole("button", { name: "引用消息", exact: true })
    .click();
  await composer.getByLabel("选择附件", { exact: true }).setInputFiles({
    name: "retry.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQmcAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await input.fill("[fail-once] [wire] 请检查附件与引用");
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/messages") &&
      response.request().method() === "POST",
  );
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  const failed = (await (await accepted).json()) as Run;
  const original = page.locator(`[data-run-id="${failed.id}"]`);
  const allow = original.getByRole("button", {
    name: "仅允许此操作",
    exact: true,
  });
  await expect(allow).toBeVisible();
  const readChat = async () =>
    (await (
      await page.request.get(`/api/chats/${failed.chatId}`)
    ).json()) as ChatView;
  const queued = await page.request.post("/api/messages", {
    data: {
      commandId: randomUUID(),
      chatId: failed.chatId,
      operation: "main",
      text: "等我继续队列后再执行",
      delivery: "queue",
    },
  });
  await expect(queued).toBeOK();
  const queuedRun = (await queued.json()) as Run;
  await allow.click();
  await expect(original).toHaveAttribute("data-status", "failed");
  const session = (await readChat()).sessions.find(
    (session) => session.id === failed.sessionId,
  )!;
  await input.fill("我的当前草稿");
  await page.reload();

  const retryPath = `/api/runs/${failed.id}/retry`;
  let commandId = "";
  await page.route(
    retryPath,
    async (route) => {
      commandId = route.request().postDataJSON().commandId;
      await route.fetch();
      await route.abort("failed");
    },
    { times: 1 },
  );
  const retry = original.getByRole("button", { name: "重试", exact: true });
  await retry.click();
  await expect(runs).toHaveCount(3);
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  await expect(runs.last().locator(".message-body")).toContainText(
    '"images":1',
  );
  await expect(runs.last().locator(".message-body")).toContainText(
    `"native":"${session.nativeId}"`,
  );
  await expect(input).toHaveText("我的当前草稿");
  await expect(original).toHaveAttribute("data-status", "failed");
  await expect(original.locator(".message-body")).toContainText(
    "Partial reply",
  );
  await expect(
    page.locator(`[data-queued-id="${queuedRun.id}"]`),
  ).toBeVisible();

  const view = await readChat();
  const retried = view.runs.at(-1)!;
  expect(retried).toMatchObject({
    sessionId: failed.sessionId,
    input: failed.input,
    attachments: failed.attachments,
    quote: failed.quote,
    selection: failed.selection,
  });
  expect(retried.quote?.text).toBe("供后续消息引用的内容");
  expect(
    view.sessions.find((session) => session.id === failed.sessionId)
      ?.queuePaused,
  ).toBe(true);
  const replay = page.waitForResponse((response) =>
    response.url().endsWith(retryPath),
  );
  await retry.click();
  const duplicate = await replay;
  expect(duplicate.status()).toBe(200);
  expect(duplicate.request().postDataJSON().commandId).toBe(commandId);
  expect((await duplicate.json()).id).toBe(retried.id);
  await composer.getByRole("button", { name: "继续队列", exact: true }).click();
  await expect(page.locator(`[data-run-id="${queuedRun.id}"]`)).toHaveAttribute(
    "data-status",
    "completed",
  );
});

test("retrying a Topic stopped before runtime binding starts it in the same Topic", async ({
  page,
}) => {
  const scope = join(context().otherScope, "slow-native-binding");
  mkdirSync(scope, { recursive: true });
  await createAgent(page, "话题重试", scope);
  const main = page.locator(".chat-composer-wrap");
  await main.getByRole("button", { name: "话题", exact: true }).click();
  await main.getByRole("textbox", { name: "发送消息" }).fill("[hang] 话题请求");
  await main.getByRole("button", { name: "发送", exact: true }).click();
  const topic = page.locator(".topic-thread");
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  const panel = page.locator(".topic-conversation:visible");
  const composer = panel.locator(".topic-composer-wrap");
  const runs = panel.locator(".run-content");
  const sessionId = (await topic.getAttribute("data-session-id"))!;
  const readSession = async () =>
    (await (
      await page.request.get(`/api/sessions/${sessionId}`)
    ).json()) as SessionView;
  await expect(runs.first()).toHaveAttribute("data-status", "running");
  await composer.getByRole("button", { name: "停止执行", exact: true }).click();
  const retry = runs.first().getByRole("button", { name: "重试", exact: true });
  await expect(topic).toHaveAttribute("data-status", "interrupted");
  expect((await readSession()).session.nativeId).toBe("");
  await expect(retry).toBeEnabled();
  await topic.getByRole("button", { name: "重试", exact: true }).click();
  await expect(topic).toHaveCount(1);
  await expect(runs).toHaveCount(2);
  await expect(runs.last()).toHaveAttribute("data-status", "running");
  await expect(retry).toBeDisabled();
  const oldId = (await runs.first().getAttribute("data-run-id"))!;
  const conflict = await page.request.post(`/api/runs/${oldId}/retry`, {
    data: { commandId: randomUUID() },
  });
  expect(conflict.status()).toBe(409);
  await expect
    .poll(async () => (await readSession()).session.nativeId)
    .not.toBe("");
  await composer.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "paused");
});

test("topic submission stays pending across closing and reopening its tab", async ({
  page,
}) => {
  await createAgent(page, "话题发送");
  await page
    .locator(".chat-composer-wrap")
    .getByRole("button", { name: "话题", exact: true })
    .click();
  await send(page, "测试话题发送过程。");
  const topic = page.locator(".topic-thread");
  const open = topic.getByRole("button", { name: "回复", exact: true });
  await open.click();
  const sidebar = page.locator(".topic-conversation:visible");
  const reply = sidebar.getByRole("textbox", { name: "回复话题", exact: true });
  let release!: () => void;
  let received!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const accepted = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route("**/api/messages", async (route) => {
    const response = await route.fetch();
    received();
    await responseGate;
    await route.fulfill({ response });
  });
  await reply.fill("这条回复只发送一次。");
  await sidebar.getByRole("button", { name: "发送", exact: true }).click();
  await accepted;
  try {
    await closeTopic(page);
    await open.click();
    await expect(reply).toHaveAttribute("aria-disabled", "true");
  } finally {
    release();
  }
  await expect(reply).toHaveText("");
  await expect(reply).toHaveAttribute("aria-disabled", "false");
  await expect(sidebar.locator(".run-content")).toHaveCount(2);
  await closeTopic(page);
  await page.reload();
  await open.click();
  await expect(reply).toHaveText("");
  await expect(sidebar.locator(".run-content")).toHaveCount(2);
});

test("lost submit response remains idempotent after a browser reload", async ({
  page,
}) => {
  await createAgent(page, "可靠发送");
  await send(page, "先建立主对话。");
  await page.route("**/api/messages", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  const text = "这条消息只能执行一次。";
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".run-content")).toHaveCount(2);
  await expect(page.locator(".run-content").last()).toHaveAttribute(
    "data-status",
    "completed",
  );
  const originalId = await page
    .locator(".run-content")
    .last()
    .getAttribute("data-run-id");
  await page.unroute("**/api/messages");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toHaveText(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toHaveText("");
  await expect(page.locator(".run-content")).toHaveCount(2);
  await expect(page.locator(".run-content").last()).toHaveAttribute(
    "data-run-id",
    originalId!,
  );
});

test("navigation snaps, remembers width and cancels an unfinished drag", async ({
  page,
}) => {
  await page.goto(context().url);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const agents = navigation.getByRole("button", {
    name: "Agents",
    exact: true,
  });
  const handle = page.getByRole("separator", { name: "调整导航宽度" });
  const drag = async (targetX: number, release = true) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX, box.y + box.height / 2, { steps: 10 });
    if (release) await page.mouse.up();
  };
  await expect(navigation).toHaveCSS("width", "160px");
  await expect(agents).toHaveCSS("height", "36px");
  await drag(240);
  await expect(navigation).toHaveCSS("width", "240px");
  await drag(24, false);
  await expect(navigation).toHaveCSS("width", "52px");
  await expect(agents).toHaveCSS("width", "36px");
  await expect(agents).toHaveCSS("height", "36px");
  await page.mouse.up();
  await expect(navigation).toHaveAttribute("data-expanded", "false");
  await page.reload();
  await expect(navigation).toHaveCSS("width", "52px");
  await handle.dblclick();
  await expect(navigation).toHaveCSS("width", "240px");
  await drag(280, false);
  await expect(navigation).toHaveCSS("width", "280px");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(navigation).toHaveCSS("width", "240px");
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(navigation).toHaveCSS("width", "52px");
  await page.keyboard.press("ArrowRight");
  await expect(navigation).toHaveCSS("width", "240px");
  await page.reload();
  await expect(navigation).toHaveCSS("width", "240px");
  const frame = page.locator(".workspace-frame:visible");
  await expect(frame).toHaveCSS("border-radius", "12px");
  await expect(frame.locator(":scope > .secondary-sidebar")).toBeVisible();
  await expect(frame.locator(":scope > .workbench")).toBeVisible();
  const frameBox = (await frame.boundingBox())!;
  expect(frameBox.x).toBe(240);
  expect(frameBox.y).toBe(8);
  await page.screenshot({ path: "../output/e2e/workbench-expanded.png" });
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(navigation).toHaveCSS("width", "52px");
  await expect(agents).toHaveCSS("width", "36px");
  await expect(agents).toHaveCSS("height", "36px");
});

test("secondary sidebars resize and share the saved width across pages", async ({
  page,
}) => {
  await page.goto(context().url);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const sidebar = page.locator("#agent-sidebar");
  const handle = page.getByRole("separator", { name: "调整二级侧栏宽度" });
  const drag = async (delta: number) => {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 8 });
  };

  await expect(sidebar).toHaveCSS("width", "240px");
  await drag(120);
  await expect(sidebar).toHaveCSS("width", "360px");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "240px");

  await drag(120);
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "360");
  const toggle = page.locator('button[aria-controls="agent-sidebar"]');
  await toggle.click();
  await expect(sidebar).toHaveCSS("width", "0px");
  await expect(handle).toHaveCount(0);
  await toggle.click();
  await expect(sidebar).toHaveCSS("width", "360px");

  for (const [tab, id] of [
    ["工作", "task-sidebar"],
    ["技能", "skills-sidebar"],
    ["插件", "plugin-sidebar"],
    ["设置", "settings-sidebar"],
  ]) {
    await navigation.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.locator(`#${id}`)).toHaveCSS("width", "360px");
    await expect(handle).toHaveAttribute("aria-controls", id);
  }

  await page.reload();
  await expect(sidebar).toHaveCSS("width", "360px");
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(sidebar).toHaveCSS("width", "325px");
  await expect(handle).toHaveAttribute("aria-valuemax", "325");
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(sidebar).toHaveCSS("position", "absolute");
  await expect(handle).toHaveAttribute("aria-valuenow", "315");
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(sidebar).toHaveCSS("width", "360px");
  await handle.press("ArrowRight");
  await expect(sidebar).toHaveCSS("width", "368px");
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "216px");
  await handle.press("End");
  await expect(sidebar).toHaveCSS("width", "440px");
  await handle.dblclick();
  await expect(sidebar).toHaveCSS("width", "240px");
});

test("language switches live, preserves drafts and tab overflow stays usable", async ({
  page,
}) => {
  await createAgent(page, "语言验证");
  await send(page, "保留用户的中文消息。");
  await page
    .getByRole("textbox", { name: "发送消息", exact: true })
    .fill("尚未发送的草稿");
  await expect(
    page.getByRole("button", { name: "话题", exact: true }),
  ).toHaveText("对话");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const settingsNav = page.getByRole("navigation", { name: "设置分类" });
  await expect(settingsNav).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agent 配置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("配置", { exact: true }).first(),
  ).toBeVisible();
  const zhNav = page.getByRole("navigation", { name: "主导航" });
  await expect(
    zhNav.getByRole("button", { name: "工作", exact: true }),
  ).toBeVisible();
  await expect(
    zhNav.getByRole("button", { name: "技能", exact: true }),
  ).toBeVisible();
  await expect(
    zhNav.getByRole("button", { name: "设置", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("radiogroup", { name: "语言", exact: true })
    .getByRole("radio", { name: "English", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const enNav = page.getByRole("navigation", {
    name: "Main navigation",
    exact: true,
  });
  await expect(
    enNav.getByRole("button", { name: "Works", exact: true }),
  ).toBeVisible();
  await expect(
    enNav.getByRole("button", { name: "Skills", exact: true }),
  ).toBeVisible();
  await enNav.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Topic", exact: true }),
  ).toHaveText("Chat");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("尚未发送的草稿");
  await expect(page.locator(".user-message")).toContainText(
    "保留用户的中文消息。",
  );
  await expect(page.locator(".run-status")).toHaveCount(0);
  await expect(page.locator(".run-work")).toContainText("Elapsed");
  await expect(page.getByRole("button", { name: "Quote message" })).toHaveCount(
    2,
  );
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "hello.go", exact: true }).click();
  await expect(
    page.locator(".file-bar").getByRole("button", {
      name: "Disable word wrap",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Git status", exact: true }).click();
  await page.locator(".git-status-popover .git-status-action-row").click();
  await expect(
    page.getByRole("button", { name: "Diff scope", exact: true }),
  ).toContainText("Uncommitted");
  await page
    .getByRole("button", { name: "Hide side pane", exact: true })
    .click();
  await openMoreTool(page, "Profile", "More tools");
  await expect(page.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Keep changes small and explain the result.",
  );
  await expect(
    page.getByRole("button", { name: "Archive Agent", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save Agent", exact: true }),
  ).toHaveCount(0);
  const workspaceTabs = page
    .getByRole("tablist", { name: "Agent workspace", exact: true })
    .getByRole("tab");
  for (let i = 0; i < 8; i++) {
    await page.getByRole("button", { name: "New Chat", exact: true }).click();
    await expect(workspaceTabs).toHaveCount(4 + i);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill(`Conversation ${i + 1}`);
    await input.press("Enter");
    await expect(page.locator(".run-content:visible")).toHaveAttribute(
      "data-status",
      "completed",
    );
  }
  const scroll = page.getByRole("tablist", {
    name: "Agent workspace",
    exact: true,
  });
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  const last = workspaceTabs.last();
  await expect(last).toHaveAttribute("aria-selected", "true");
  const viewport = (await scroll.boundingBox())!;
  const active = (await last.boundingBox())!;
  expect(active.x).toBeGreaterThanOrEqual(viewport.x - 1);
  expect(active.x + active.width).toBeLessThanOrEqual(
    viewport.x + viewport.width + 1,
  );
  await last.focus();
  await page.keyboard.press("Home");
  await expect(workspaceTabs.first()).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("尚未发送的草稿");
  await page.screenshot({ path: "../output/e2e/workbench-english.png" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("尚未发送的草稿");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Language", exact: true })
    .getByRole("radio", { name: "简体中文", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "文件", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.getByRole("tab", { name: "文件", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("composer uploads, pastes and drops files, persists choices, switches runtimes without crossing topics", async ({
  page,
}) => {
  await createAgent(page, "界面搭档");
  const composer = page.locator(".chat-composer-wrap");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await composer.getByLabel("选择附件", { exact: true }).setInputFiles([
    { name: "reference.png", mimeType: "image/png", buffer: png },
    {
      name: "brief.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Build a compact, clear composer."),
    },
  ]);
  await expect(composer.locator(".attachment-chip")).toHaveCount(2);
  await composer
    .getByRole("button", { name: "选择模型和运行时", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "选择模型和运行时",
    exact: true,
  });
  const list = picker.locator(".model-list-scroll");
  expect(
    await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const listBox = (await list.boundingBox())!;
  const footerBox = (await picker
    .locator(".model-picker-footer")
    .boundingBox())!;
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(footerBox.y);
  const search = picker.getByRole("textbox", { name: "搜索模型…" });
  await search.fill("review");
  await expect(picker.locator(".model-choice")).toHaveCount(1);
  await expect(
    picker.getByRole("radiogroup", { name: "推理强度", exact: true }),
  ).toHaveCount(0);
  await picker.getByRole("button", { name: "GPT Review", exact: true }).click();
  await picker.getByRole("radio", { name: "快速", exact: true }).click();
  await page.screenshot({ path: "../output/e2e/composer-model-picker.png" });
  await picker
    .getByRole("radiogroup", { name: "推理强度", exact: true })
    .getByRole("radio", { name: "高", exact: true })
    .click();
  await expect(picker).toBeHidden();
  await expect(
    composer.getByRole("textbox", { name: "发送消息" }),
  ).toBeFocused();
  await page.keyboard.insertText("请结合这两个附件完善输入框。");
  await page.reload();
  await expect(composer.locator(".attachment-chip")).toHaveCount(2);
  await expect(
    composer.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toHaveText("请结合这两个附件完善输入框。");
  await expect(composer.locator(".model-trigger")).toContainText("GPT Review");
  await expect(composer.locator(".fast-icon")).toBeVisible();
  await composer
    .getByRole("button", { name: "reference.png", exact: true })
    .click();
  await expect(page.locator(".attachment-preview img")).toBeVisible();
  await page.keyboard.press("Escape");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".run-content")).toHaveAttribute(
    "data-status",
    "completed",
  );
  await expect(page.locator(".user-message .attachment-chip")).toHaveCount(2);
  await expect(composer.locator(".attachment-chip")).toHaveCount(0);

  // The OS file chooser, dropping and pasting share one upload path.
  const editor = composer.getByRole("textbox", { name: "发送消息", exact: true });
  await editor.evaluate((element) => {
    const nonFile = new DataTransfer();
    nonFile.setData("text/plain", "dragged text");
    element.dispatchEvent(
      new DragEvent("dragleave", { bubbles: true, dataTransfer: nonFile }),
    );
    const enter = new DataTransfer();
    enter.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
    element.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: enter,
      }),
    );
    element.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: enter,
      }),
    );
  });
  await expect(composer.locator(".attachment-drop")).toBeVisible();
  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["dropped"], "dropped.txt", { type: "text/plain" }),
    );
    transfer.setData("text/uri-list", "file:///tmp/dropped.txt");
    transfer.setData("text/plain", "/tmp/dropped.txt");
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(composer.locator(".attachment-drop")).toHaveCount(0);
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await expect(editor).toHaveText("");
  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["pasted"], "pasted.txt", { type: "text/plain" }),
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(composer.locator(".attachment-chip")).toHaveCount(2);
  await composer
    .getByRole("button", { name: "移除 dropped.txt", exact: true })
    .click();
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await composer
    .getByRole("button", { name: "选择模型和运行时", exact: true })
    .click();
  await picker.getByRole("radio", { name: "Claude Code", exact: true }).click();
  await expect(picker.getByText("default", { exact: true })).toHaveCount(0);
  await picker
    .getByRole("button", { name: "Claude Sonnet", exact: true })
    .press("ArrowRight");
  await picker
    .getByRole("radiogroup", { name: "推理强度", exact: true })
    .getByRole("radio", { name: "最大", exact: true })
    .click();
  await expect(picker).toBeHidden();
  await send(page, "换一个运行时继续刚才的设计。");
  await expect(page.locator(".runtime-handoff")).toHaveCount(1);
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await send(page, "独立讨论附件的边界。");
  const topic = page.locator(".topic-thread");
  await topic.getByRole("button", { name: "回复", exact: true }).click();
  await page
    .getByRole("textbox", { name: "回复话题", exact: true })
    .fill("这个回复仍在同一个话题。");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic.locator(".topic-preview")).toHaveCount(3);
  await expect(topic).toHaveAttribute("data-status", "completed");
  await closeTopic(page);
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await send(page, "回到主对话。");
  const chatId = await page.evaluate(async () => {
    const data = await (await fetch("/api/overview")).json();
    return data.chats.find(
      (entry: { title: string }) =>
        entry.title === "请结合这两个附件完善输入框。",
    ).id as string;
  });
  const view = await page.evaluate(
    async (id) => (await fetch(`/api/chats/${id}`)).json() as Promise<ChatView>,
    chatId,
  );
  expect(view.sessions).toHaveLength(2);
  const main = view.sessions.find((session) => session.kind === "main")!;
  const runs = view.runs.filter((run) => run.sessionId === main.id);
  expect(runs[0].selection).toEqual({
    provider: "codex",
    model: "gpt-review",
    permission: "auto_review",
    effort: "high",
    fast: true,
  });
  expect(runs[1].selection.provider).toBe("claude");
  expect(runs[1].handoff).toBe(true);
  expect(runs[2].handoff).toBe(false);
  await page.emulateMedia({ colorScheme: "dark" });
  await composer
    .getByRole("button", { name: "选择模型和运行时", exact: true })
    .click();
  await page.screenshot({ path: "../output/e2e/composer-dark.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 640, height: 850 });
  await composer
    .getByRole("button", { name: "选择模型和运行时", exact: true })
    .click();
  const box = (await picker.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(640);
  await page.screenshot({ path: "../output/e2e/composer-narrow.png" });
});

test("reasoning follows the selected model and returns to the draft", async ({
  page,
}) => {
  await createAgent(page, "模型级联选择");
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", { name: "发送消息" });
  const trigger = composer.getByRole("button", { name: "选择模型和运行时" });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  const rail = picker.getByRole("radiogroup", { name: "运行时", exact: true });
  const efforts = picker.getByRole("radiogroup", { name: "推理强度" });
  const review = picker.getByRole("button", {
    name: "GPT Review",
    exact: true,
  });
  await input.fill("AB");
  await input.press("End");
  await input.press("ArrowLeft");
  await trigger.click();
  await expect(rail).toHaveText("");
  await rail.getByRole("radio", { name: "Claude Code" }).hover();
  await expect(
    page.getByRole("tooltip", { name: "Claude Code" }),
  ).toBeVisible();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveAttribute(
    "data-side",
    "left",
  );
  const low = efforts.getByRole("radio", { name: "低", exact: true });
  const high = efforts.getByRole("radio", { name: "高", exact: true });
  await expect(low).toBeChecked();
  await expect(efforts).toHaveAccessibleDescription("GPT Test");
  await expect(
    picker.locator(".model-efforts").getByText("GPT Test", { exact: true }),
  ).toBeHidden();
  await expect(picker.locator(".model-runtime-name")).toHaveText("Codex");
  const search = picker.getByRole("textbox", { name: "搜索模型…" });
  const lowOnly = picker.getByRole("button", {
    name: "GPT Fixture 0",
    exact: true,
  });
  await lowOnly.hover();
  await expect(efforts).toHaveAccessibleDescription("GPT Test");
  await expect(low).toBeChecked();
  await expect(efforts.getByRole("radio")).toHaveText([
    "低",
    "中",
    "高",
    "更高",
  ]);
  await expect(search).toBeFocused();
  await expect(trigger).toContainText("GPT Test");
  await review.click();
  await expect(review).toHaveAttribute("aria-current", "true");
  await expect(efforts).toHaveAccessibleDescription("GPT Review");
  await expect(low).toBeChecked();
  await high.click();
  await expect(picker).toBeHidden();
  await expect(input).toBeFocused();
  await page.keyboard.insertText("+");
  await expect(input).toHaveText("A+B");
  await expect(trigger).toContainText("GPT Review高");

  await trigger.click();
  await expect(high).toBeChecked();
  await search.press("ArrowDown");
  const first = picker.getByRole("button", { name: "GPT Test", exact: true });
  await expect(first).toBeFocused();
  await expect(efforts).toHaveAccessibleDescription("GPT Review");
  await first.press("ArrowRight");
  await expect(high).toBeFocused();
  await expect(efforts).toHaveAccessibleDescription("GPT Test");
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  await expect(trigger).toContainText("GPT Test高");
  await first.press("ArrowDown");
  await expect(review).toBeFocused();
  await review.press("Enter");
  await expect(high).toBeFocused();
  await expect(efforts).toHaveAccessibleDescription("GPT Review");
  await high.press("Enter");
  await expect(input).toBeFocused();
  await expect(picker).toBeHidden();

  await trigger.click();
  await lowOnly.click();
  await expect(efforts).toHaveAccessibleDescription("GPT Fixture 0");
  await expect(efforts.getByRole("radio")).toHaveText(["低"]);
  await expect(low).toBeChecked();
  await expect(trigger).toContainText("GPT Fixture 0低");
  await low.click();
  await expect(picker).toBeHidden();
  await expect(trigger).toContainText("GPT Fixture 0低");
  await expect(input).toBeFocused();

  await trigger.click();
  await rail.getByRole("radio", { name: "Pi", exact: true }).click();
  const plain = picker.getByRole("button", { name: "Plain", exact: true });
  await plain.click();
  await expect(picker).toBeHidden();
  await expect(input).toBeFocused();
  await expect(trigger).toHaveText("Plain");
});

test("sending in an existing Chat closes an open draft image preview", async ({
  page,
}) => {
  await createAgent(page, "发送时关闭图片预览");
  await send(page, "开始对话");
  const composer = page.locator(".chat-composer-wrap");
  await composer.getByLabel("选择附件", { exact: true }).setInputFiles({
    name: "draft.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await composer
    .getByRole("button", { name: "draft.png", exact: true })
    .click();
  const preview = page.getByRole("region", { name: "图片预览", exact: true });
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await input.fill("查看这张图片");

  await page.route(
    "**/api/messages",
    (route) => route.fulfill({ status: 503, body: "Fixture send failed" }),
    { times: 1 },
  );
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer.getByText("Fixture send failed")).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(input).toHaveText("查看这张图片");

  await send(page);
  await expect(preview).toBeHidden();
  await expect(
    page.locator(".user-message").getByRole("button", { name: "draft.png" }),
  ).toBeVisible();
});

test("model picker switches between favorites across runtimes", async ({
  page,
}) => {
  await createAgent(page, "跨运行时模型收藏");
  await page.evaluate(() => {
    localStorage.setItem("lever:starred-models:codex", '["gpt-review"]');
    localStorage.setItem("lever:starred-models:claude", '["claude-review"]');
  });
  await page.reload();
  const trigger = page.getByRole("button", { name: "选择模型和运行时" });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  const rail = picker.getByRole("radiogroup", { name: "运行时", exact: true });
  const favorites = rail.getByRole("radio", { name: "收藏", exact: true });
  const opus = picker.getByRole("button", {
    name: "Claude Opus · Claude Code",
    exact: true,
  });
  const review = picker.getByRole("button", {
    name: "GPT Review · Codex",
    exact: true,
  });
  const efforts = picker.getByRole("radiogroup", {
    name: "推理强度",
    exact: true,
  });
  const search = picker.getByRole("textbox", { name: "搜索模型…" });
  await trigger.click();
  await expect(rail.getByRole("radio").first()).toHaveAccessibleName("收藏");
  await favorites.click();
  await expect(review).toBeVisible();
  await expect(opus).toBeVisible();
  await expect(trigger).toContainText("GPT Test");
  await expect(efforts).toHaveCount(0);

  await opus.click();
  await expect(opus).toHaveAttribute("aria-current", "true");
  await expect(efforts).toHaveAccessibleDescription("Claude Opus");
  await expect(picker.locator(".model-runtime-name")).toHaveText("Claude Code");
  await efforts.getByRole("radio", { name: "最大", exact: true }).click();
  await expect(picker).toBeHidden();
  await trigger.click();
  await expect(favorites).toBeChecked();
  await page.keyboard.press("Escape");
  const response = page.waitForResponse(
    (result) =>
      result.url().endsWith("/api/messages") &&
      result.request().method() === "POST",
  );
  await send(page, "使用跨运行时收藏");
  expect(await (await response).json()).toMatchObject({
    selection: { provider: "claude", model: "claude-review", effort: "max" },
  });

  await trigger.click();
  await expect(favorites).toBeChecked();
  await expect(opus).toHaveAttribute("aria-current", "true");
  await search.fill("codex");
  await expect(opus).toHaveCount(0);
  await expect(efforts).toHaveCount(0);
  await review.press("ArrowRight");
  await expect(efforts).toHaveAccessibleDescription("GPT Review");
  await expect(picker.locator(".model-runtime-name")).toHaveText("Codex");
  await picker
    .getByRole("button", { name: "收藏 GPT Review · Codex", exact: true })
    .click();
  await expect(search).toBeFocused();
  await expect(review).toHaveCount(0);
  await expect(trigger).toContainText("GPT Review");

  await page.reload();
  await trigger.click();
  await favorites.click();
  await expect(opus).toBeVisible();
  await expect(review).toHaveCount(0);

  const claude = rail.getByRole("radio", { name: "Claude Code", exact: true });
  await claude.click();
  await picker
    .getByRole("button", { name: "Claude Opus", exact: true })
    .click();
  await efforts.getByRole("radio", { name: "最大", exact: true }).click();
  await page.reload();
  await trigger.click();
  await expect(claude).toBeChecked();
});

test("model picker hides unready providers and opens connection settings", async ({
  page,
}) => {
  await createAgent(page, "模型运行时配置");
  let claudeReady = true;
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const providers: ProviderInfo[] = await response.json();
    await route.fulfill({
      response,
      json: providers.map((p) => ({
        ...p,
        name: p.id === "claude" ? "Claude Team" : p.name,
        available:
          ["codex", "pi"].includes(p.id) || (p.id === "claude" && claudeReady),
        installed: p.id !== "codex",
        error: p.id === "pi" ? "Probe failed" : undefined,
      })),
    });
  });
  await page.route("**/api/providers/claude/models?*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), models: [] },
    });
  });
  const trigger = page.getByRole("button", { name: "选择模型和运行时" });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  const rail = picker.getByRole("radiogroup", { name: "运行时", exact: true });
  const setup = picker.getByRole("button", { name: "管理连接" });
  await page.reload();
  await trigger.click();
  await expect(rail.getByRole("radio")).toHaveText(["收藏", "Claude Team"]);
  await expect(picker.getByText("Codex 尚未就绪。")).toBeVisible();
  await rail.getByRole("radio", { name: "Claude Team" }).click();
  await expect(picker.getByText("运行时尚未返回模型。")).toBeVisible();
  await setup.click();
  await expect(
    page
      .getByRole("navigation", { name: "我的连接" })
      .getByRole("button", { name: /Claude Code/ }),
  ).toHaveAttribute("aria-pressed", "true");

  claudeReady = false;
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.reload();
  await trigger.click();
  await expect(rail).toBeHidden();
  await expect(picker.getByText("暂无可用的运行时。")).toBeVisible();
  await expect(setup).toBeVisible();
});

test("new Chats and Topics remember each Agent’s model and permission choices", async ({
  page,
}) => {
  const name = "模型偏好搭档";
  await createAgent(page, name);
  const composer = page.locator(".chat-composer-wrap:visible");
  const model = composer.getByRole("button", { name: "选择模型和运行时" });
  const permission = composer.getByRole("button", { name: /^权限 · / });
  const choosePermission = async (name: RegExp) => {
    await permission.click();
    await page.getByRole("menuitemradio", { name }).click();
  };
  const topic = composer.getByRole("button", { name: "话题", exact: true });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  const pick = (name: string) =>
    picker.getByRole("radio", { name, exact: true }).click();
  const newChat = page.getByRole("button", { name: "新对话", exact: true });
  const profile = page.locator('[id="panel-profile"]');
  const profilePermissions = profile.getByRole("radiogroup", { name: "权限" });
  const waitProfileSave = () =>
    page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname.startsWith("/api/agents/"),
    );

  await openMoreTool(page);
  const saveAsk = waitProfileSave();
  await profilePermissions.getByRole("radio", { name: "按需审批" }).click();
  expect((await saveAsk).ok()).toBeTruthy();
  await newChat.click();
  await send(page, "Main session uses GPT Test");
  await topic.click();
  await expect(permission).toHaveAccessibleName("权限 · 按需审批");
  await choosePermission(/^代我审批/);
  const topicRun = page.waitForResponse((response) =>
    response.url().endsWith("/api/messages"),
  );
  await send(page, "Topic overrides the Agent permission");
  expect(await (await topicRun).json()).toMatchObject({
    selection: { permission: "auto_review" },
  });
  await expect(composer.getByRole("textbox", { name: "发送消息" })).toBeEmpty();
  await page.reload();
  await expect(permission).toHaveAccessibleName("权限 · 代我审批");
  await model.click();
  await picker
    .getByRole("button", { name: "GPT Review", exact: true })
    .press("ArrowRight");
  await pick("快速");
  await pick("高");
  await model.click();
  await pick("Claude Code");
  await picker
    .getByRole("button", { name: "Claude Opus", exact: true })
    .press("ArrowRight");
  await pick("低");
  await expect(permission).toHaveAccessibleName("权限 · 自动");
  await choosePermission(/^完全访问/);
  await topic.click();
  await expect(model).toContainText("GPT Test");
  await expect(permission).toHaveAccessibleName("权限 · 按需审批");
  await page.reload();
  await expect(model).toContainText("GPT Test");
  await topic.click();
  await expect(model).toContainText("Claude Opus");
  await expect(permission).toHaveAccessibleName("权限 · 完全访问");
  await send(page, "Independent Topic uses Claude Opus");

  await newChat.click();
  await expect(model).toContainText("Claude Opus");
  await expect(permission).toHaveAccessibleName("权限 · 完全访问");
  await model.click();
  await pick("Codex");
  const review = picker.getByRole("button", {
    name: "GPT Review",
    exact: true,
  });
  await expect(review).toHaveAttribute("aria-current", "true");
  await review.click();
  await expect(
    picker.getByRole("radio", { name: "高", exact: true }),
  ).toBeChecked();
  await expect(
    picker.getByRole("radio", { name: "快速", exact: true }),
  ).toBeChecked();
  await pick("高");
  await expect(permission).toHaveAccessibleName("权限 · 完全访问");
  await send(page, "New Chat uses remembered Codex settings");

  await createAgent(page, "独立模型偏好");
  await expect(permission).toHaveAccessibleName("权限 · 代我审批");
  await page.getByRole("button", { name, exact: true }).click();
  await openMoreTool(page);
  const saveAutoReview = waitProfileSave();
  await profilePermissions.getByRole("radio", { name: "代我审批" }).click();
  expect((await saveAutoReview).ok()).toBeTruthy();
  await newChat.click();
  await expect(model).toContainText("GPT Review");
  await expect(permission).toHaveAccessibleName("权限 · 代我审批");

  await openMoreTool(page);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const saveModel = waitProfileSave();
  await page.getByRole("option", { name: "GPT Test", exact: true }).click();
  expect((await saveModel).ok()).toBeTruthy();
  await newChat.click();
  await expect(model).toContainText("GPT Test");
  await expect(composer.locator(".fast-icon")).toHaveCount(0);
});

test("only a new conversation falls back when its remembered model disappears", async ({
  page,
}) => {
  await createAgent(page, "模型下架搭档");
  const composer = page.locator(".chat-composer-wrap:visible");
  const model = composer.getByRole("button", { name: "选择模型和运行时" });
  await model.click();
  await page.getByRole("radio", { name: "Claude Code", exact: true }).click();
  await page
    .getByRole("button", { name: "Claude Opus", exact: true })
    .press("ArrowRight");
  await page.getByRole("radio", { name: "低", exact: true }).click();
  await send(page, "Existing Claude Opus session");
  const newChat = page.getByRole("button", { name: "新对话", exact: true });
  await newChat.click();
  const catalog = "**/api/providers/claude/models?*";
  await page.route(catalog, (route) => route.fulfill({ status: 503 }));
  await page.reload();
  await expect(model).toContainText("claude-review");

  await page.unroute(catalog);
  await page.route(catalog, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        models: data.models.filter(
          (model: { id: string }) => model.id !== "claude-review",
        ),
      },
    });
  });
  await page.reload();
  await expect(model).toContainText("GPT Test");
  await page
    .getByRole("tab", { name: "Existing Claude Opus session", exact: true })
    .click();
  await expect(model).toContainText("claude-review");
  await expect(composer.getByRole("alert")).toContainText("所选模型不可用");
  await page.unroute(catalog);
  await page.reload();
  await newChat.click();
  await expect(model).toContainText("Claude Opus");
});

test("legacy drafts and pending first sends restore their own selections", async ({
  page,
}) => {
  await createAgent(page, "模型草稿恢复");
  const composer = page.locator(".chat-composer-wrap:visible");
  const model = composer.getByRole("button", { name: "选择模型和运行时" });
  const input = composer.getByRole("textbox", { name: "发送消息" });
  const sendButton = composer.getByRole("button", {
    name: "发送",
    exact: true,
  });
  const newChat = page.getByRole("button", { name: "新对话", exact: true });
  async function chooseModel(name: string) {
    await model.click();
    await page.getByRole("button", { name, exact: true }).press("ArrowRight");
    await page.getByRole("radio", { name: "低", exact: true }).click();
  }
  await chooseModel("GPT Review");
  await send(page, "Preferences seed session");
  await newChat.click();

  const restoreLegacyDraft = (text: string) =>
    page.evaluate((text) => {
      const agentId = localStorage.getItem("lever:agent");
      localStorage.setItem(
        `lever:composer:draft:${agentId}`,
        JSON.stringify({
          text,
          selection: {
            provider: "codex",
            model: "gpt-test",
            effort: "low",
            fast: false,
          },
        }),
      );
    }, text);
  await restoreLegacyDraft("Draft from an older version");
  await page.reload();
  await expect(input).toHaveText("Draft from an older version");
  await expect(model).toContainText("GPT Test");
  await restoreLegacyDraft("");
  await page.reload();
  await expect(model).toContainText("GPT Review");

  let commandId = "";
  let runId = "";
  await page.route(
    "**/api/messages",
    async (route) => {
      const request = route.request().postDataJSON();
      commandId = request.commandId;
      expect(request.selection.model).toBe("gpt-review");
      const result = await route.fetch();
      await expect(result).toBeOK();
      runId = (await result.json()).id;
      await route.abort("failed");
    },
    { times: 1 },
  );
  await input.fill("Accepted before the response was lost");
  await sendButton.click();
  await expect(composer.getByRole("alert")).toBeVisible();
  await page
    .getByRole("tab", { name: "Preferences seed session", exact: true })
    .click();
  await chooseModel("GPT Test");
  await newChat.click();
  await page.reload();
  await expect(model).toContainText("GPT Review");
  const replay = page.waitForResponse((response) =>
    response.url().endsWith("/api/messages"),
  );
  await sendButton.click();
  const result = await replay;
  expect(result.request().postDataJSON().commandId).toBe(commandId);
  expect((await result.json()).id).toBe(runId);
  await expect(
    page.getByRole("tab", { name: "Accepted before the response was lost" }),
  ).toBeVisible();
  await newChat.click();
  await expect(model).toContainText("GPT Test");
});

test("composer permissions follow the selected provider and apply to the next run", async ({
  page,
}) => {
  await createAgent(page, "权限搭档");
  const plugin = await page.request.post("/api/plugins", {
    data: { directory: context().pluginDirectory },
  });
  await expect(plugin).toBeOK();
  const { id } = await plugin.json();
  await expect(
    await page.request.post(`/api/provider-candidates/${id}/agent`),
  ).toBeOK();
  const composer = page.locator(".chat-composer-wrap");
  const trigger = composer.getByRole("button", { name: /^权限 · / });
  const input = composer.getByRole("textbox", { name: "发送消息" });
  const menu = page.getByRole("menu", { name: "权限" });
  const option = (name: RegExp) => menu.getByRole("menuitemradio", { name });
  const menuItems = menu.locator('[role^="menuitem"]');
  const codexPresets = [/^按需审批/, /^代我审批/, /^完全访问/];
  const agyPresets = [/^请求审查/, /^默认/, /^自动/, /^极速/];
  const model = composer.getByRole("button", { name: "选择模型和运行时" });
  const runs = page.locator(".chat-panel .conversation > .run-content");
  const receipt = () => runs.last().locator(".message-body:visible");
  const switchProvider = async (name: string) => {
    await model.click();
    const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
    await expect(picker.getByRole("combobox", { name: "权限" })).toHaveCount(0);
    await picker.getByRole("radio", { name, exact: true }).click();
    await page.keyboard.press("Escape");
  };

  await expect(trigger).toHaveAccessibleName("权限 · 代我审批");
  await send(page, "[wire] Codex uses its native reviewer");
  await expect(receipt()).toContainText('"reviewer":"auto_review"');
  await expect(receipt()).toContainText('"sandbox":"workspace-write"');
  await trigger.click();
  await expect(menuItems).toHaveText(codexPresets);
  await option(/^按需审批/).click();
  await input.fill("[approval-chain]");
  await input.press("Enter");
  await page.getByRole("button", { name: "本轮自动批准", exact: true }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  await expect(receipt()).toHaveText("Approvals accepted: 2");
  await input.fill("[approval] Requires approval on the next run");
  await input.press("Enter");
  await page.getByRole("button", { name: "仅允许此操作", exact: true }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "completed");

  await input.fill("[hang] Codex keeps its current permissions");
  await input.press("Enter");
  await expect(runs.last()).toHaveAttribute("data-status", "running");
  const actions = composer.getByRole("button", {
    name: "添加附件、命令或引用",
  });
  await actions.click();
  await page.getByRole("option", { name: /^本轮自动批准/ }).click();
  await expect(trigger).toHaveAccessibleName("权限 · 按需审批 · 本轮自动批准");
  await trigger.click();
  await expect(menuItems).toHaveText(codexPresets);
  await page.keyboard.press("Escape");
  await actions.click();
  await page.getByRole("option", { name: "本次运行恢复询问" }).click();
  await expect(trigger).toHaveAccessibleName("权限 · 按需审批");
  await trigger.press("Enter");
  await expect(menuItems).toHaveText(codexPresets);
  await expect(option(/^按需审批/)).toHaveAttribute("aria-checked", "true");
  await expect(menu).toContainText("这条消息执行时生效。");
  await expect(option(/^自动接受编辑/)).toHaveCount(0);
  await option(/^代我审批/).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAccessibleName("权限 · 按需审批");
  await trigger.click();
  await expect(option(/^代我审批/)).toHaveAttribute("aria-checked", "true");
  await expect(menu).toContainText("本轮使用按需审批");
  await page.keyboard.press("Escape");
  await input.fill("[wire] Codex automatic review");
  await expect(
    composer.getByRole("button", { name: "加入队列" }),
  ).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "发送到当前执行" }),
  ).toHaveCount(0);
  await composer.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "paused");
  await page.reload();
  await expect(trigger).toHaveAccessibleName("权限 · 代我审批");
  await send(page);
  await expect(receipt()).toContainText('"reviewer":"auto_review"');
  await expect(receipt()).toContainText('"sandbox":"workspace-write"');

  await switchProvider("Claude Code");
  await expect(trigger).toHaveAccessibleName("权限 · 自动");
  await trigger.click();
  await option(/^自动接受编辑/).click();
  await input.fill("[wire] Claude auto-accept edits");
  await input.press("Enter");
  await expect(receipt()).toContainText('"permission":"acceptEdits"');
  await input.fill("[claude-approval]");
  await input.press("Enter");
  const allowOnce = page.getByRole("button", {
    name: "仅允许此操作",
    exact: true,
  });
  await expect(allowOnce).toBeVisible();
  await trigger.click();
  await expect(option(/^自动接受编辑/)).toHaveAttribute("aria-checked", "true");
  await expect(option(/^只读沙箱/)).toHaveCount(0);
  await expect(menu.getByText("这条消息执行时生效。")).toHaveCount(0);
  await option(/^完全访问/).click();
  await expect(trigger).toHaveAccessibleName("权限 · 完全访问");
  await allowOnce.click();
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  await expect(receipt()).toHaveText(
    "Claude received bypassPermissions and allow",
  );
  await switchProvider("Codex");
  await expect(trigger).toHaveAccessibleName("权限 · 完全访问");
  await switchProvider("Claude Code");
  await expect(trigger).toHaveAccessibleName("权限 · 完全访问");

  await switchProvider("Antigravity");
  await expect(trigger).toHaveAccessibleName("权限 · 极速");
  await page.reload();
  await expect(trigger).toHaveAccessibleName("权限 · 极速");
  await input.fill("[wire] Antigravity Turbo");
  await input.press("Enter");
  await expect(receipt()).toContainText("--dangerously-skip-permissions");
  await switchProvider("Codex");
  await expect(trigger).toHaveAccessibleName("权限 · 完全访问");
  await switchProvider("Antigravity");
  await expect(trigger).toHaveAccessibleName("权限 · 极速");
  await trigger.click();
  await expect(menuItems).toHaveText(agyPresets);
  await option(/^默认/).click();

  await input.fill("[hang] Keep the Antigravity preset until the next run");
  await input.press("Enter");
  await expect(runs.last()).toHaveAttribute("data-status", "running");
  await trigger.click();
  await expect(menuItems).toHaveText(agyPresets);
  await expect(option(/^默认/)).toHaveAttribute("aria-checked", "true");
  await option(/^请求审查/).click();
  await expect(trigger).toHaveAccessibleName("权限 · 默认");
  await trigger.click();
  await expect(option(/^请求审查/)).toHaveAttribute("aria-checked", "true");
  await expect(menu).toContainText("本轮使用默认");
  await page.keyboard.press("Escape");
  await composer.getByRole("button", { name: "停止执行" }).click();
  await expect(runs.last()).toHaveAttribute("data-status", "interrupted");
  await input.fill("[wire] Antigravity requires review");
  await input.press("Enter");
  await expect(receipt()).toContainText('"toolPermission":"request-review"');

  await switchProvider("Browser Agent");
  await expect(trigger).toHaveAccessibleName("权限 · Review safely");
  await input.fill("[mode-change] Use the native mode for Browser Agent");
  await input.press("Enter");
  await expect(runs.last()).toHaveAttribute("data-status", "running");
  await trigger.click();
  await expect(option(/^Review safely/)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu).toContainText("Allows workspace edits.");
  await expect(menu.getByText("这条消息执行时生效。")).toHaveCount(0);
  await option(/^Build changes/).click();
  await expect(runs.last()).toHaveAttribute("data-status", "completed");
  await expect(receipt()).toContainText('"mode":"build-mode"');
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(trigger).toHaveAccessibleName("权限 · Build changes");
  await switchProvider("Claude Code");
  await expect(trigger).toHaveAccessibleName("权限 · 完全访问");
});

test("Agent runtime settings save the equivalent permission on provider changes", async ({
  page,
}) => {
  await createAgent(page, "跨运行时权限");
  await openMoreTool(page);
  const profile = page.locator('[id="panel-profile"]');
  const runtime = profile.getByRole("combobox", { name: "运行时" });
  const permissions = profile.getByRole("radiogroup", { name: "权限" });
  const switchProvider = async (name: string) => {
    await runtime.click();
    await page.getByRole("option", { name, exact: true }).click();
  };

  await expect(permissions.getByRole("radio")).toHaveCount(3);
  await permissions.getByRole("radio", { name: "完全访问" }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.startsWith("/api/agents/") &&
      response.request().postDataJSON()?.profile?.provider === "antigravity",
  );
  await switchProvider("Antigravity");
  await expect(permissions.getByRole("radio")).toHaveCount(4);
  await expect(
    permissions.getByRole("radio", { name: "请求审查" }),
  ).toBeVisible();
  await expect(permissions.getByRole("radio", { name: "极速" })).toBeChecked();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    profile: { provider: "antigravity", permission: "turbo" },
  });
  const savedClaude = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.startsWith("/api/agents/") &&
      response.request().postDataJSON()?.profile?.provider === "claude",
  );
  await switchProvider("Claude Code");
  await expect(
    permissions.getByRole("radio", { name: "完全访问" }),
  ).toBeChecked();
  expect((await savedClaude).ok()).toBeTruthy();
  await expect(
    permissions.getByRole("radio", { name: "自动", exact: true }),
  ).toBeVisible();
  await expect(permissions.getByRole("radio", { name: "计划" })).toBeVisible();
  await expect(permissions.getByRole("radio", { name: "不询问" })).toHaveCount(
    0,
  );
});

test("consecutive tools and thoughts share one activity row that shimmers while running", async ({
  page,
}) => {
  await createAgent(page, "执行过程");
  const composer = page.locator(".chat-composer-wrap");
  await composer
    .getByRole("textbox", { name: "发送消息" })
    .fill("[tool-activity]");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  const run = page.locator(".chat-panel .conversation > .run-content").last();
  const activity = run.locator(".run-activity");
  await expect(activity).toHaveCount(1);
  const running = activity.getByRole("button", {
    name: "正在查询 rg Greeting",
    exact: true,
  });
  await expect(running).toHaveAttribute("aria-expanded", "false");
  await expect(
    activity.getByText("Check the remaining references."),
  ).toBeHidden();
  const runningTitle = running.locator('[data-slot="trace-title"]');
  await expect(runningTitle).toHaveCSS("animation-name", "tw-shimmer");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(runningTitle).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await running.press("Enter");
  const details = activity.getByRole("region", { name: "执行过程" });
  await expect(
    details.getByText("Review the workspace. Then verify the edit."),
  ).toBeVisible();
  await expect(details.getByText("go version", { exact: true })).toBeVisible();
  await expect(details.getByText("rg Greeting", { exact: true })).toBeVisible();
  const kinds = await details
    .locator(":scope > [data-kind]")
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-kind")),
    );
  expect(kinds).toEqual([
    "reasoning",
    "tool",
    "tool",
    "reasoning",
    "tool",
    "tool",
  ]);
  await composer.getByRole("button", { name: "暂停回复", exact: true }).click();
  await expect(run).toHaveAttribute("data-status", "paused");
  const stopped = activity.getByRole("button", {
    name: "2 条命令 · 1 次文件编辑 · 1 次查询",
    exact: true,
  });
  await expect(stopped).toHaveAttribute("aria-expanded", "true");
  await expect(
    run.locator('[data-slot="trace-line"][data-status="running"]'),
  ).toHaveCount(0);
});

test("command exit codes and tool errors stay in their own rows", async ({
  page,
}) => {
  await createAgent(page, "命令结果");
  await send(page, "[command-exits]");
  await page.reload();

  const run = page.locator(".chat-panel .conversation > .run-content").last();
  await run.locator(".run-work-toggle").click();
  const activity = run.locator(".run-activity");
  const summary = activity.getByRole("button", {
    name: "3 条命令",
    exact: true,
  });
  await expect(summary.locator(".lucide-terminal")).toBeVisible();
  await summary.click();

  const missing = activity
    .locator(".tool-item")
    .filter({ hasText: "ls -d node_modules" });
  await missing
    .getByRole("button", { name: "ls -d node_modules", exact: true })
    .click();
  await expect(missing.getByText("退出码 1", { exact: true })).toBeVisible();
  const output = missing.locator('[data-slot="code-block"]');
  await expect(output).toHaveAttribute("data-variant", "default");
  await expect(output).toContainText(
    "ls: node_modules: No such file or directory",
  );

  const noMatch = activity
    .locator(".tool-item")
    .filter({ hasText: "rg NoMatch" });
  await noMatch
    .getByRole("button", { name: "rg NoMatch", exact: true })
    .click();
  await expect(noMatch.getByText("退出码 1", { exact: true })).toBeVisible();

  await activity
    .getByRole("button", { name: "pwd 执行失败", exact: true })
    .click();
  const error = activity.locator(
    '[data-slot="code-block"][data-variant="destructive"]',
  );
  await expect(error).toContainText("Failed to start shell");
});

for (const provider of ["Codex", "Claude Code", "Antigravity"]) {
  test(`${provider} preserves thinking separately from the reply`, async ({
    page,
  }) => {
    await createAgent(page, `${provider} thinking`);
    const runs = page.locator(".chat-panel .conversation > .run-content");
    const paragraphs =
      provider === "Codex"
        ? ["Review the input.", "Compare the results."]
        : ["Review the input."];
    if (provider !== "Codex") {
      await page.getByRole("button", { name: "选择模型和运行时" }).click();
      await page.getByRole("radio", { name: provider, exact: true }).click();
      await page.keyboard.press("Escape");
    } else {
      await page
        .getByRole("textbox", { name: "发送消息" })
        .fill("[thinking] [hang]");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(runs.last()).toHaveAttribute("data-status", "running");
      const thought = runs
        .last()
        .locator(".run-activity")
        .getByRole("button", { name: "Compare the results.", exact: true });
      await expect(thought).toHaveAttribute("aria-expanded", "false");
      await thought.click();
      await expect(runs.last().locator('[data-kind="reasoning"] p')).toHaveText(
        paragraphs,
      );
      await page.getByRole("button", { name: "暂停回复", exact: true }).click();
      await expect(runs.last()).toHaveAttribute("data-status", "paused");
    }
    await send(page, "[thinking]");
    await page.reload();
    const run = runs.last();
    await expect(run.locator(".message-body:visible")).toHaveText("Done.");
    await run.locator(".run-work-toggle").click();
    await run
      .getByRole("button", {
        name: provider === "Codex" ? "思考过程" : paragraphs[0],
        exact: true,
      })
      .click();
    const thoughts = run.locator('[data-kind="reasoning"]');
    await expect(thoughts).toHaveCount(provider === "Codex" ? 2 : 1);
    await expect(thoughts.first().locator("p")).toHaveText(paragraphs);
    if (provider === "Codex") {
      await expect(thoughts.nth(1).locator("p")).toHaveText(
        "Confirm the answer.",
      );
    }
  });
}

test("Antigravity auto-expands pure thinking stream and uses single-line tool status", async ({
  page,
}) => {
  await createAgent(page, "Antigravity live thinking");
  await page.getByRole("button", { name: "选择模型和运行时" }).click();
  await page.getByRole("radio", { name: "Antigravity", exact: true }).click();
  await page.keyboard.press("Escape");

  const composer = page.locator(".chat-composer-wrap");
  const runs = page.locator(".chat-panel .conversation > .run-content");

  // 1. Pure thinking stage auto-expands into a scrollable reasoning region.
  await composer
    .getByRole("textbox", { name: "发送消息" })
    .fill("[thinking] [hang]");
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  const thinkingRun = runs.last();
  await expect(thinkingRun).toHaveAttribute("data-status", "running");
  const thinkingTrigger = thinkingRun
    .locator(".run-activity")
    .getByRole("button", { name: "正在思考", exact: true });
  await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    thinkingRun.getByRole("region", { name: "思考过程" }),
  ).toContainText("Review the input.");
  await thinkingTrigger.focus();
  await expect(thinkingTrigger).toHaveCSS("outline-style", "none");
  await expect(thinkingTrigger).toHaveCSS("box-shadow", "none");
  // Manual collapse is respected and switches the single-line header to the thought summary.
  await thinkingTrigger.click();
  const collapsedThought = thinkingRun
    .locator(".run-activity")
    .getByRole("button", { name: "Review the input.", exact: true });
  await expect(collapsedThought).toHaveAttribute("aria-expanded", "false");
  await expect(thinkingRun.locator('[data-kind="reasoning"]')).toBeHidden();
  await composer.getByRole("button", { name: "停止执行" }).click();
  await expect(thinkingRun).toHaveAttribute("data-status", "interrupted");

  // 2. Once tools start, Antigravity collapses to a single concrete tool row and surfaces subagents.
  await composer
    .getByRole("textbox", { name: "发送消息" })
    .fill("[agy-live-thinking] [hang]");
  await composer.getByRole("button", { name: "发送", exact: true }).click();

  const run = runs.last();
  await expect(run).toHaveAttribute("data-status", "running");

  const activity = run.locator(".run-activity");
  const liveTrigger = activity.getByRole("button", {
    name: "正在读取 internal/provider/acp.go",
    exact: true,
  });
  await expect(liveTrigger).toBeVisible();
  await expect(liveTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(run.getByText("Codebase Researcher")).toBeVisible();

  await liveTrigger.click();
  await expect(
    activity.getByText("Need to verify rawInput and rawOutput."),
  ).toBeVisible();
  await expect(
    activity.getByText("internal/provider/acp.go", { exact: true }),
  ).toBeVisible();

  await composer.getByRole("button", { name: "停止执行" }).click();
  await expect(run).toHaveAttribute("data-status", "interrupted");
});

test("composer action menu orders available commands and browses without editing the draft", async ({
  page,
}, testInfo) => {
  await createAgent(page, "操作面板搭档");
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const plus = composer.getByRole("button", { name: "添加附件、命令或引用" });
  const panel = page.getByRole("dialog", { name: "添加附件、命令或引用" });
  const options = panel.getByRole("option");
  const search = panel.getByRole("combobox");
  await plus.click();
  await expect(search).toBeFocused();
  await expect(options.first()).toHaveText("添加附件");
  await expect(options.locator(".suggestion-shortcut")).toHaveText([
    "/compare",
    "/chat",
    "/topic",
    "/goal",
    "/model",
    "/",
    "@",
  ]);
  await expect(options.nth(6)).toContainText("/compact");
  await expect(options.last()).toContainText("引用已有内容");
  await panel.screenshot({
    path: testInfo.outputPath("composer-actions-light.png"),
  });

  await search.press("ArrowDown");
  await search.press("Enter");
  const comparing = page.getByRole("dialog", { name: "参与对比的 Agent" });
  await expect(comparing).toBeVisible();
  await page.keyboard.press("Escape");
  await plus.click();
  await panel.getByRole("option", { name: /取消对比/ }).click();
  await expect(
    composer.getByRole("button", { name: "添加 Agent" }),
  ).toHaveCount(0);
  await plus.click();
  await panel.getByRole("option", { name: /继续对话/ }).click();
  await plus.click();
  await panel.getByRole("option", { name: /选择模型/ }).click();
  await expect(page.getByRole("textbox", { name: "搜索模型…" })).toBeFocused();
  await page.keyboard.press("Escape");

  await input.fill("left right");
  for (let i = 0; i < 5; i++) await input.press("ArrowLeft");
  await plus.click();
  await search.fill("fixture");
  await expect(options).toContainText(["/fixture-review"]);
  await search.press("Escape");
  await expect(input).toBeFocused();
  await page.keyboard.insertText("!");
  await expect(input).toHaveText("left !right");
  await plus.click();
  await panel.getByRole("option", { name: /引用已有内容/ }).click();
  await search.fill("hello");
  await panel.getByRole("option", { name: "hello.go", exact: true }).click();
  await expect(input.locator("[data-reference]")).toHaveCount(1);
  await expect(input).toHaveText(/left !.*hello\.go.* right/);
  await plus.click();
  await expect(panel.getByRole("option", { name: /\/goal/ })).toHaveCount(0);
  await panel.getByRole("option", { name: /更多命令与技能/ }).click();
  await search.fill("fixture-review");
  await search.press("Enter");
  await expect(input.locator("[data-reference]")).toHaveCount(2);
  await expect(input).toContainText("right");

  await input.fill("```ts");
  await input.press("Shift+Enter");
  await page.keyboard.insertText("const answer = 42");
  await plus.click();
  await panel.getByRole("option", { name: /引用已有内容/ }).click();
  await search.fill("hello");
  await panel.getByRole("option", { name: "hello.go", exact: true }).click();
  await expect(input.locator("pre code")).toHaveText("const answer = 42");
  await expect(input.locator("p [data-reference]")).toHaveCount(1);

  await input.fill("");
  await plus.click();
  const chooser = page.waitForEvent("filechooser");
  await options.first().click();
  await (
    await chooser
  ).setFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Keep this file"),
  });
  await expect(composer.locator(".attachment-chip")).toContainText("brief.txt");
  await plus.click();
  await expect(panel.getByRole("option", { name: /\/goal/ })).toHaveCount(0);
  await search.press("Escape");
  await expect(composer.locator(".attachment-chip")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.locator('button[aria-controls="agent-sidebar"]:visible');
  if ((await sidebar.getAttribute("aria-expanded")) === "true")
    await sidebar.click();
  await page.emulateMedia({ colorScheme: "dark" });
  await plus.click();
  await expect(panel).toBeInViewport({ ratio: 1 });
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await panel.screenshot({
    path: testInfo.outputPath("composer-actions-narrow-dark.png"),
  });
});

test("composer action menu prepares and manages the runtime goal on send", async ({
  page,
}) => {
  await createAgent(page, "目标面板搭档");
  const composer = page.locator(".chat-composer-wrap:visible");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const plus = composer.getByRole("button", { name: "添加附件、命令或引用" });
  const panel = page.getByRole("dialog", { name: "添加附件、命令或引用" });
  await plus.click();
  await panel.getByRole("option", { name: /设置目标/ }).click();
  await expect(input).toHaveText("/goal");
  await input.fill("Finish the parser check");
  await plus.click();
  await panel.getByRole("option", { name: /用草稿设置目标/ }).click();
  await expect(input).toHaveText("/goal Finish the parser check");
  await expect(page.locator(".user-message")).toHaveCount(0);
  await send(page);
  await expect(composer).toContainText("Finish the parser check");
  await plus.click();
  await panel.getByRole("option", { name: /管理目标/ }).click();
  await panel.getByRole("option", { name: /查看当前目标/ }).click();
  await expect(input).toHaveText("/goal status");
  await input.fill("");
  await composer.getByRole("button", { name: "选择模型和运行时" }).click();
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  await picker.getByRole("radio", { name: "Pi", exact: true }).click();
  await picker.getByRole("button", { name: "Plain", exact: true }).click();
  await plus.click();
  const extension = panel.getByRole("option", { name: /\/fixture-command/ });
  await expect(extension).toBeVisible();
  await expect(panel.getByRole("option", { name: /\/goal/ })).toHaveCount(0);
  await extension.click();
  await expect(input).toHaveText("/fixture-command");
});

test("composer toggles directly and keeps inline references through copy, retry and reload", async ({
  page,
}) => {
  await createAgent(page, "引用搭档");
  const composer = page.locator(".chat-composer-wrap");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const references = input.locator("[data-reference]");
  const mode = composer.getByRole("button", { name: "话题", exact: true });
  await expect(mode).toHaveText("对话");
  await mode.click();
  await expect(mode).toHaveText("话题");
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.route(
    "**/api/*/*/suggestions?kind=slash&**",
    (route) => route.fulfill({ status: 503, body: "Skills unavailable" }),
    { times: 1 },
  );
  await input.fill("/");
  const suggestions = page.getByRole("listbox", { name: "命令与技能" });
  const commands = suggestions
    .getByRole("group", { name: "命令", exact: true })
    .getByRole("option");
  await expect(commands.nth(0)).toHaveText("/chat继续对话");
  await expect(commands.nth(1)).toHaveText("/topic开启话题");
  await expect(commands.nth(2)).toHaveText("/model选择模型");
  await expect(suggestions.getByRole("alert")).toContainText("无法加载候选项");
  await suggestions.getByRole("button", { name: "重试", exact: true }).click();
  await expect(suggestions).toContainText("/fixture-review");
  await expect(suggestions).toContainText("/a-related-skill");
  await expect(
    suggestions
      .getByRole("group", { name: "技能", exact: true })
      .getByRole("option"),
  ).toHaveCount(2);
  await input.press("ArrowUp");
  await expect(
    suggestions.getByRole("option", { selected: true }),
  ).toContainText("/fixture-review");
  await input.press("ArrowDown");
  await expect(
    suggestions.getByRole("option", { selected: true }),
  ).toContainText("/chat");
  await input.fill("/frv");
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(
    suggestions.getByRole("group", { name: "命令", exact: true }),
  ).toHaveCount(0);
  await expect(
    suggestions.getByRole("group", { name: "技能", exact: true }),
  ).toBeVisible();
  await expect(suggestions.getByRole("option")).toContainText(
    "/fixture-review",
  );
  await input.fill("$fixture");
  await expect(suggestions).toHaveCount(0);
  await input.fill("/chat");
  await page.getByRole("option", { name: "/chat", exact: false }).waitFor();
  await input.press("Enter");
  await expect(mode).toHaveText("对话");
  await expect(input).toHaveText("");
  await input.fill("/model");
  await input.press("Enter");
  await expect(page.locator(".model-picker")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "搜索模型…", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();

  await input.fill("@ignored");
  await expect(page.getByRole("listbox")).toHaveText(
    "没有匹配的引用或协作 Agent。",
  );
  await input.press("Escape");
  // Start a new mention after dismissing the previous one.
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  await input.fill("@dgn");
  await expect(
    page.getByRole("option", { name: "docs/design notes.md", exact: true }),
  ).toBeVisible();
  await input.press("Escape");
  await input.pressSequentially("x");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.fill("");
  await input.fill("看看🙂 @design");
  await expect(
    page.getByRole("option", { name: "docs/design notes.md", exact: true }),
  ).toBeVisible();
  await input.press("Tab");
  await expect(input).toBeFocused();
  await expect(references).toHaveText(["design notes.md"]);
  await input.pressSequentially("再用 ");
  await page.keyboard.insertText("、fixture-review");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option").first()).toContainText(
    "/fixture-review",
  );
  await input.press("Enter");
  await input.pressSequentially("[wire] 检查引用");
  await expect(references).toHaveText(["design notes.md", "fixture-review"]);
  await expect(input).toHaveText(
    "看看🙂 design notes.md 再用 fixture-review [wire] 检查引用",
  );
  await expect(page.locator(".run-content")).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await composer.screenshot({
    path: "../output/e2e/composer-inline-light.png",
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await composer.screenshot({ path: "../output/e2e/composer-inline-dark.png" });
  await page.reload();
  await expect(references).toHaveText(["design notes.md", "fixture-review"]);

  // Exercise the editor's clipboard serialization, including token identity.
  await input.press("ControlOrMeta+A");
  const clipboard = await input.evaluate((element) => {
    const data = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return {
      html: data.getData("text/html"),
      text: data.getData("text/plain"),
    };
  });
  expect(clipboard.text).toContain("@docs/design notes.md");
  expect(clipboard.text).toContain("$fixture-review");
  await input.fill("");
  await input.evaluate((element, clipboard) => {
    const data = new DataTransfer();
    data.setData("text/html", clipboard.html);
    data.setData("text/plain", clipboard.text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, clipboard);
  await expect(references).toHaveText(["design notes.md", "fixture-review"]);

  await page.route("**/api/messages", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/api/messages");
  await page.reload();
  await composer.getByRole("button", { name: "发送", exact: true }).click();
  await expect(input).toHaveText("");
  await expect(page.locator(".run-content")).toHaveCount(1);
  await expect(references).toHaveCount(0);
  const message = page.locator(".user-message");
  await expect(message.locator(".inline-reference")).toHaveText([
    "design notes.md",
    "fixture-review",
  ]);
  await expect(message).toContainText(
    "看看🙂 design notes.md 再用 fixture-review",
  );
  await expect(message).toContainText("检查引用");
  await expectInlineReference(
    message.getByRole("button", { name: "fixture-review", exact: true }),
  );
  const wire = page
    .locator(".run-content .message-body")
    .filter({ hasText: "wire:" });
  await expect(wire).toContainText("Referenced file");
  await expect(wire).toContainText("design notes.md");
  await expect(wire).toContainText('"name":"fixture-review"');
  await expect(wire).toContainText("Review carefully.");
});

test("note and Board mentions retain their own targets through draft reload and first send", async ({
  page,
}) => {
  await createAgent(page, "笔记引用");
  const title = "Review decisions";
  const card = "Verify callback";
  const note = await page.request.post("/api/tasks/notes", {
    data: {
      id: randomUUID(),
      title,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { taskId: randomUUID() },
            content: [{ type: "text", text: card }],
          },
        ],
      },
    },
  });
  expect(note.ok()).toBeTruthy();
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  const menu = page.getByRole("listbox", { name: "引用与协作" });
  await input.fill(`[wire] 对照@${title}`);
  await expect(menu.getByRole("group", { name: "看板工作项" })).toContainText(
    card,
  );
  await expect(
    menu.getByRole("option", { selected: true }),
  ).toHaveAccessibleName(title);
  await input.press("Tab");
  await page.keyboard.insertText(`@${card}`);
  await expect(menu.getByRole("option", { selected: true })).toContainText(
    card,
  );
  await input.press("Enter");
  await page.reload();
  await expect(input.locator("[data-reference]")).toHaveText([title, card]);
  await send(page);
  const message = page.locator(".user-message");
  await expect(
    message.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  await message.getByRole("button", { name: card, exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: card, exact: true }),
  ).toBeVisible();
});

test("literal @ mentions stay closed while clicking or continuing prose", async ({
  page,
}) => {
  await createAgent(page, "字面艾特");
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  const listbox = page.getByRole("listbox");

  // Standalone @ followed by space must never reopen an empty popup while
  // continuing to type or clicking back into the following text.
  await input.click();
  await input.pressSequentially("lever 好像没实际支持 @");
  await expect(listbox).toBeVisible();
  await input.pressSequentially(" 其他Agent? 或者只支持艾特");
  await expect(listbox).toHaveCount(0);
  await input.evaluate((element) => {
    const { editor } = element as HTMLElement & { editor: Editor };
    const text = editor.getText();
    const pos = text.indexOf("ent?") + 1;
    editor.commands.setTextSelection(pos);
  });
  await expect(listbox).toHaveCount(0);
  await input.pressSequentially("x");
  await expect(listbox).toHaveCount(0);

  // An unmatched @token followed by a space closes cleanly, stays closed while
  // typing or moving the caret back onto it, and lets Enter submit normally.
  await input.fill("");
  await input.pressSequentially("看看 @其他Agent");
  await expect(listbox).toHaveText("没有匹配的引用或协作 Agent。");
  await input.pressSequentially(" 能不能用");
  await page.waitForTimeout(250);
  await expect(listbox).toHaveCount(0);
  await input.evaluate((element) => {
    const { editor } = element as HTMLElement & { editor: Editor };
    const text = editor.getText();
    editor.commands.setTextSelection(text.indexOf("ent ") + 1);
  });
  await page.waitForTimeout(250);
  await expect(listbox).toHaveCount(0);
  await input.evaluate((element) => {
    const { editor } = element as HTMLElement & { editor: Editor };
    editor.commands.focus("end");
  });
  await input.press("Enter");
  await expect(input).toHaveText("");
  await expect(page.locator(".user-message")).toContainText(
    "看看 @其他Agent 能不能用",
  );

  // Dismissing a mention with Escape persists across spaces and caret moves.
  await input.fill("@ignored");
  await expect(listbox).toHaveText("没有匹配的引用或协作 Agent。");
  await input.press("Escape");
  await expect(listbox).toHaveCount(0);
  await input.pressSequentially(" extra");
  await expect(listbox).toHaveCount(0);
  await input.evaluate((element) => {
    const { editor } = element as HTMLElement & { editor: Editor };
    editor.commands.setTextSelection(5);
  });
  await expect(listbox).toHaveCount(0);
  await input.pressSequentially("y");
  await expect(listbox).toHaveCount(0);
});

test("opens project and user Skill references beside the draft", async ({
  page,
}) => {
  await createAgent(page, "查看 Skill 引用");
  const { homeDir } = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const name = `linked-skill-${randomUUID().slice(0, 8)}`;
  const project = join(context().scope, ".agents", "skills", name);
  const user = join(homeDir, ".codex", "skills", name);
  try {
    for (const [directory, label] of [
      [project, "Project Skill"],
      [user, "User Skill"],
    ]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${label}\n---\n\n# ${label} details\n`,
      );
    }
    const draftTabId = await page
      .locator(".workspace-tab.selected [role=tab]")
      .getAttribute("id");
    const draft = page.locator(`[id="${draftTabId}"]`);
    const input = page.getByRole("textbox", { name: "发送消息", exact: true });
    await input.fill(`/${name}`);
    await page.getByRole("option").filter({ hasText: "Project Skill" }).click();
    await input.pressSequentially(`compare /${name}`);
    await page.getByRole("option").filter({ hasText: "User Skill" }).click();
    const references = input.getByRole("button", { name, exact: true });
    const side = page.getByRole("tablist", { name: "侧边分区", exact: true });
    const tabs = side.getByRole("tab", { name, exact: true });
    const preview = page.getByRole("tabpanel", { name, exact: true });

    await references.first().click();
    await expect(
      preview.getByRole("heading", { name: "Project Skill details" }),
    ).toBeVisible();
    await expect(tabs).toHaveCount(1);
    await expect(input).toHaveText(`${name} compare ${name}`);
    await references.last().focus();
    await page.keyboard.press("Enter");
    await expect(
      preview.getByRole("heading", { name: "User Skill details" }),
    ).toBeVisible();
    await expect(preview.locator(".file-save-status")).toHaveText("只读");
    await expect(tabs).toHaveCount(2);
    await page.reload();
    await expect(
      preview.getByRole("heading", { name: "User Skill details" }),
    ).toBeVisible();

    await side
      .getByRole("tab", { name, exact: true, selected: true })
      .press("Delete");
    await expect(draft).toBeFocused();
    await expect(
      preview.getByRole("heading", { name: "Project Skill details" }),
    ).toBeVisible();
    await expect(input).toHaveText(`${name} compare ${name}`);
    await send(page);
    await page
      .locator(".user-message")
      .getByRole("button", { name, exact: true })
      .first()
      .click();
    await expect(
      preview.getByRole("heading", { name: "Project Skill details" }),
    ).toBeVisible();
    await expect(tabs).toHaveCount(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  }
});

test("closing a tab restores the most recently selected open tab", async ({
  page,
}) => {
  await createAgent(page, "恢复标签页");
  const main = page.getByRole("tablist", { name: "Agent 工作区", exact: true });
  const draft = main.getByRole("tab", { name: "新对话", exact: true });
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await openMoreTool(page);
  const profile = main.getByRole("tab", { name: "配置", exact: true });
  await draft.click();
  await profile.click();
  await page.reload();
  await expect(profile).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".files-panel")).toHaveCount(0);
  const closeProfile = main.getByRole("button", {
    name: "关闭 配置",
    exact: true,
  });
  await draft.hover();
  await expect(closeProfile).toBeHidden();
  const idleWidth = await profile.evaluate((tab) => tab.clientWidth);
  await profile.hover();
  await expect(closeProfile).toBeVisible();
  expect(await profile.evaluate((tab) => tab.clientWidth)).toBeLessThan(
    idleWidth,
  );
  await profile.press("Delete");
  await expect(draft).toBeFocused();
  await expect(draft).toHaveAttribute("aria-selected", "true");
  await expect(
    main.getByRole("tab", { name: "文件", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置", exact: true }).click();
  const side = page.locator('.tab-strip[data-pane="side"]');
  await side.getByRole("button", { name: "打开标签", exact: true }).click();
  await page.getByRole("menuitem", { name: "变更", exact: true }).click();
  await draft.click();
  await closeTab(side.getByRole("tab", { name: "配置", exact: true }));
  await expect(draft).toBeFocused();
  await expect(
    side.getByRole("tab", { name: "变更", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await side.getByRole("button", { name: "打开标签", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置", exact: true }).click();
  await draft.click();
  const diff = side.getByRole("tab", { name: "变更", exact: true });
  await diff.click();
  await diff.press("Delete");
  await expect(draft).toBeFocused();
  await expect(
    side.getByRole("tab", { name: "配置", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await main.getByRole("tab", { name: "文件", exact: true }).click();
  await expect(page.locator(".files-panel")).toBeVisible();
  await draft.click();
  await expect(page.locator(".files-panel")).toHaveCount(1);
  await expect(page.locator(".files-panel")).toBeHidden();
});

test("inserts inline Skills in existing text on Antigravity, Pi and DeepSeek Harness", async ({
  page,
}) => {
  await createAgent(page, "行内 Skill");
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  const skills = page.getByRole("group", { name: "技能", exact: true });
  for (const [runtime, query] of [
    ["Antigravity", "/fixture-review"],
    ["Pi", "/skill:fixture-review"],
    ["DeepSeek Harness", "/fixture-review"],
  ]) {
    await page.getByRole("button", { name: "选择模型和运行时" }).click();
    await picker.getByRole("radio", { name: runtime, exact: true }).click();
    await page.keyboard.press("Escape");
    await input.fill("请用处理");
    await input.press("ArrowLeft");
    await input.press("ArrowLeft");
    await input.pressSequentially(query);
    await skills.getByRole("option", { name: /^\/fixture-review/ }).waitFor();
    await input.press("Enter");
    await expect(input).toHaveText("请用fixture-review 处理");
    await input.press("End");
    await input.pressSequentially(" /a-related");
    await skills.getByRole("option", { name: /^\/a-related-skill/ }).click();
    await expect(input).toHaveText("请用fixture-review 处理 a-related-skill");
    await expect(input.locator("[data-reference]")).toHaveCount(2);
  }
});

test("inline references edit at the caret, delete atomically and undo without ghost invocations", async ({
  page,
}) => {
  await createAgent(page, "行内编辑");
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  const references = input.locator("[data-reference]");
  await input.fill("前文 后文");
  await input.press("ArrowLeft");
  await input.press("ArrowLeft");
  await input.pressSequentially("/fixture-review");
  await page.getByRole("option").first().waitFor();
  await input.press("Enter");
  await expect(input).toHaveText("前文 fixture-review 后文");
  await input.press("Backspace"); // trailing space
  await input.press("Backspace"); // the entire skill token
  await expect(references).toHaveCount(0);
  await expect(input).toHaveText("前文 后文");
  await input.press("ControlOrMeta+Z");
  await expect(references).toHaveCount(1);
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  await input.fill("[wire] @hello");
  await page.getByRole("option").waitFor();
  await input.press("Enter");
  await input.press("ArrowLeft"); // before the trailing space
  // Native caret movement reaches ProseMirror through selectionchange.
  // Wait for that event before sending the next key, as with real typing.
  await expect
    .poll(() =>
      input.evaluate(
        (element) =>
          (element as HTMLElement & { editor: Editor }).editor.state.selection
            .$from.nodeBefore?.type.name,
      ),
    )
    .toBe("reference");
  await input.press("ArrowLeft"); // before the file token
  await expect(input.locator(".ProseMirror-selectednode")).toHaveCount(1);
  await input.press("Delete");

  await expect(references).toHaveCount(0);
  await input.press("ArrowRight");
  await input.press("Shift+Enter");
  await input.pressSequentially("中文🙂");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await expect(page.locator(".run-content")).toHaveCount(0);
  await send(page);
  const wire = await page.locator(".run-content .message-body").textContent();
  expect(wire).not.toContain("Referenced file");
  expect(wire).not.toContain('"type":"skill"');
});

test("skills refresh between turns and respect runtime changes in both Chat and Topic", async ({
  page,
}) => {
  await createAgent(page, "技能更新");
  await openMoreTool(page);
  await page.getByRole("button", { name: "添加技能", exact: true }).click();
  await page.getByRole("button", { name: "添加已有目录", exact: true }).click();
  await page
    .getByRole("textbox", { name: "技能目录", exact: true })
    .fill(context().skill);
  const savedSkill = page.waitForResponse(
    (response) =>
      /\/api\/agents\/[^/]+$/.test(response.url()) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "添加", exact: true }).click();
  expect((await savedSkill).ok()).toBeTruthy();
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const composer = page.locator(".chat-composer-wrap");
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await input.fill("/pinned");
  await expect(page.getByRole("option")).toContainText("pinned-review");
  await input.press("Enter");
  await input.pressSequentially("[wire] 使用 Agent 技能");
  await send(page);
  await expect(page.locator(".run-content").last()).toContainText(
    "Original skill.",
  );
  await expect(page.locator(".run-content").last()).toContainText("/sessions/");

  writeFileSync(
    join(context().skill, "SKILL.md"),
    "---\nname: pinned-review\ndescription: Updated skill\n---\nChanged source.\n",
  );
  await input.fill("/pinned");
  await page.getByRole("option").waitFor();
  await input.press("Enter");
  await input.pressSequentially("[wire] 读取更新后的技能");
  await send(page);
  await expect(page.locator(".run-content").last()).toContainText(
    "Changed source.",
  );
  await expect(page.locator(".run-content").last()).not.toContainText(
    "Original skill.",
  );

  await input.fill("/pinned");
  await page.getByRole("option").waitFor();
  await input.press("Enter");
  await composer
    .getByRole("button", { name: "选择模型和运行时", exact: true })
    .click();
  await page.getByRole("radio", { name: "Claude Code", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(composer.getByRole("alert")).toHaveCount(0);
  await expect(
    input.getByRole("button", { name: "pinned-review" }),
  ).toBeVisible();
  const reviewURL = "https://example.test/review/42?file=main.go";
  await input.pressSequentially(`[wire] ${reviewURL}`);
  await send(page);
  const receipt = page
    .locator(".chat-panel .conversation > .run-content")
    .last()
    .locator(".message-body")
    .last();
  await expect(receipt).toContainText(reviewURL);
  await expect(receipt).toContainText("Read and follow the");
  await expect(receipt).toContainText("pinned-review/SKILL.md");
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await input.fill("/fixture-claude");
  await page.getByRole("option", { name: /\/fixture-claude/ }).click();
  await input.pressSequentially("[wire] 使用 Claude 技能");
  await send(page);
  const topic = page.locator(".topic-thread").last();
  await expectInlineReference(
    topic.getByRole("button", { name: "fixture-claude", exact: true }),
  );
  await topic.locator(".topic-open").click();
  const sidebar = page.getByRole("region", {
    name: "话题",
    exact: true,
  });
  await expect(sidebar.locator(".run-content")).toContainText(
    "Use the /fixture-claude skill for this request.",
  );
  await sidebar.getByRole("textbox", { name: "回复话题", exact: true }).click();
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  await reply.fill("@hello");
  await page.getByRole("option").waitFor();
  await reply.press("Enter");
  await reply.pressSequentially("[wire] 再看这个文件");
  await page
    .locator(".topic-composer-wrap:visible")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(topic.locator(".topic-preview")).toHaveCount(3);
  await expect(topic).toHaveAttribute("data-status", "completed");
  await topic.locator(".topic-open").click();
  await expect(sidebar.locator(".run-content").last()).toContainText(
    "hello.go",
  );
  await closeTopic(page);

  await page.setViewportSize({ width: 560, height: 900 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await input.fill("/");
  await expect(
    page.getByRole("option", { name: /\/fixture-claude/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "../output/e2e/composer-skills-narrow.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await input.fill("@design");
  await expect(page.getByRole("option")).toBeVisible();
  await page.screenshot({
    path: "../output/e2e/composer-files-dark.png",
    fullPage: true,
  });
});

test("file suggestions and accepted references follow the selected session scope", async ({
  page,
}) => {
  await createAgent(page, "文件范围");
  await send(page, "建立连续会话");
  const result = await page.evaluate(async (otherScope) => {
    const overview = await (await fetch("/api/overview")).json();
    const agent = overview.agents.find(
      (item: { name: string }) => item.name === "文件范围",
    );
    const chat = overview.chats.find(
      (item: { agentId: string }) => item.agentId === agent.id,
    );
    const view: ChatView = await (await fetch(`/api/chats/${chat.id}`)).json();
    const session = view.sessions[0];
    const post = (path: string, body: unknown, method = "POST") =>
      fetch(`/api${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const updated = await post(
      `/agents/${agent.id}`,
      {
        ...agent,
        profile: {
          ...agent.profile,
          roots: [{ id: "next-root", path: otherScope }],
          primaryRootId: "next-root",
        },
      },
      "PUT",
    );
    if (!updated.ok) throw new Error(await updated.text());
    const oldFiles = await (
      await fetch(
        `/api/chats/${chat.id}/suggestions?kind=file&query=hello&sessionId=${session.id}`,
      )
    ).json();
    const newFiles = await (
      await fetch(`/api/chats/${chat.id}/suggestions?kind=file&query=hello`)
    ).json();
    const ignored = await (
      await fetch(`/api/chats/${chat.id}/suggestions?kind=file&query=hidden`)
    ).json();
    const otherChat = await (
      await post("/chats", { agentId: agent.id })
    ).json();
    const foreignSession = await fetch(
      `/api/chats/${otherChat.id}/suggestions?kind=file&sessionId=${session.id}`,
    );
    const outsideScope = await post("/messages", {
      commandId: crypto.randomUUID(),
      chatId: chat.id,
      operation: "main",
      text: "outside",
      references: newFiles,
    });
    return {
      oldFiles,
      newFiles,
      ignored,
      foreignStatus: foreignSession.status,
      outsideStatus: outsideScope.status,
    };
  }, context().otherScope);
  expect(result.oldFiles).toHaveLength(1);
  expect(result.oldFiles[0].path).toContain("/workspace/hello.go");
  expect(result.newFiles).toHaveLength(1);
  expect(result.newFiles[0].path).toContain("/ordinary-workspace/hello.go");
  expect(result.ignored).toEqual([]);
  expect(result.foreignStatus).toBe(400);
  expect(result.outsideStatus).toBe(400);
});

test("a long model name leaves the composer send button in view", async ({
  page,
}) => {
  const longModel = "GPT Test — Long Context Preview Extended Reasoning Max";
  await page.route("**/api/providers/codex/models?*", async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as Catalog;
    await route.fulfill({
      response,
      json: {
        ...catalog,
        models: catalog.models.map((model) =>
          model.id === "gpt-test" ? { ...model, name: longModel } : model,
        ),
      },
    });
  });
  await createAgent(page, "长模型名");
  const composer = page.locator(".chat-composer-wrap .composer");
  await composer.evaluate((element) => (element.style.maxWidth = "420px"));
  const modelName = composer.locator(".model-trigger-name");
  await expect(modelName).toBeVisible();
  await expect(modelName).toHaveText(longModel);
  const sendButton = composer.getByRole("button", {
    name: "发送",
    exact: true,
  });
  await expect
    .poll(() =>
      sendButton.evaluate((button) => {
        const composer = button.closest(".composer")!.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return bounds.left >= composer.left && bounds.right <= composer.right;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      modelName.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    )
    .toBe(true);
  await send(page, "长模型名下仍可发送");
});

test("a narrow Chat pane keeps composer actions in one icon row", async ({
  page,
}) => {
  await createAgent(page, "窄栏输入框");
  const composer = page.locator(".chat-composer-wrap:visible");
  const toolbar = composer.locator(".composer-actions");
  const mode = toolbar.getByRole("button", { name: "话题", exact: true });
  const model = toolbar.getByRole("button", {
    name: "选择模型和运行时",
    exact: true,
  });
  const modelName = model.locator(".model-trigger-name");
  await mode.click();
  await send(page, "分栏 Topic");
  await page.getByRole("button", { name: "回复", exact: true }).click();
  const divider = page.getByRole("separator", { name: "调整分区宽度" });
  await expect(modelName).toBeVisible();

  await divider.press("Home");
  await divider.press("ArrowRight");
  await divider.press("ArrowRight");
  await expect(mode).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByText("话题", { exact: true })).toBeHidden();
  await expect(modelName).toBeHidden();
  await expect(composer.locator(".prompt-placeholder")).toHaveCSS(
    "white-space",
    "nowrap",
  );
  expect(
    await toolbar.evaluate((element) => {
      const buttons = Array.from(element.querySelectorAll("button"));
      const centers = buttons.map((button) => {
        const { top, height } = button.getBoundingClientRect();
        return top + height / 2;
      });
      return (
        element.scrollWidth <= element.clientWidth &&
        Math.max(...centers) - Math.min(...centers) < 1
      );
    }),
  ).toBe(true);
  await model.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "选择模型和运行时" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await divider.dblclick();
  await expect(mode.getByText("话题", { exact: true })).toBeVisible();
  await expect(modelName).toBeVisible();
});

test("browsing reuses a conversation preview and keeps edits and partial answers", async ({
  page,
}) => {
  await createAgent(page, "巡看会话");
  await send(page, "巡看工作的父 Chat");
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const agent = overview.agents.find((item) => item.name === "巡看会话")!;
  const chat = overview.chats.find((item) => item.agentId === agent.id)!;
  const selection = {
    provider: agent.profile.provider,
    model: agent.profile.model,
  };
  const question = "选颜色 [question]";
  const running = "先看进度 [hang]";
  const patrol = [
    running,
    "回复草稿",
    "检查一",
    "检查二",
    "检查三",
    "检查四",
    "检查五",
    "检查六",
  ];
  const runs = new Map<string, Run>();
  for (const text of [question, ...patrol]) {
    const response = await page.request.post("/api/messages", {
      data: {
        commandId: randomUUID(),
        chatId: chat.id,
        operation: "topic",
        text,
        selection,
        attachmentIds: [],
      },
    });
    expect(response.ok()).toBe(true);
    runs.set(text, (await response.json()) as Run);
  }
  const openTopic = (text: string) =>
    page
      .locator(`.topic-thread[data-session-id="${runs.get(text)!.sessionId}"]`)
      .getByRole("button", { name: "回复", exact: true })
      .click();
  const strip = page.locator('.tab-strip[data-pane="side"]');
  const tabs = strip.getByRole("tab");
  const preview = strip.locator('[role="tab"][aria-description]');
  await openTopic(running);
  await expect(preview).toHaveText("先看进度 [hang]");
  await expect(preview.locator("span")).toHaveCSS("font-style", "italic");
  await openTopic(question);
  await expect(tabs).toHaveCount(1);
  await expect(preview).toHaveText("选颜色 [question]");
  const green = page.getByRole("checkbox", { name: /Green/ });
  await green.check();
  await expect(preview).toHaveCount(0);
  // Patrol enough conversations to evict the question panel from the warm cache.
  for (const title of patrol) {
    await openTopic(title);
    await expect(tabs).toHaveCount(2);
  }
  await tabs.filter({ hasText: "选颜色" }).click();
  await expect(green).toBeChecked();
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(green).toHaveCount(0);
  await openTopic("回复草稿");
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  await reply.fill("开始回复");
  await reply.fill("");
  await openTopic("检查一");
  await expect(tabs).toHaveCount(3);
  await expect(preview).toHaveText("检查一");
  await preview.click({ button: "right" });
  await page.getByRole("menuitem", { name: "保留标签页" }).click();
  await openTopic("检查二");
  await expect(tabs).toHaveCount(4);
  await preview.dblclick();
  await expect(preview).toHaveCount(0);
  await openTopic("检查三");
  await page.reload();
  await expect(preview).toHaveText("检查三");
  await openTopic("检查四");
  await expect(preview).toHaveText("检查四");
  await expect(tabs).toHaveCount(5);
  // A saved workspace from before preview tabs treats all its open tabs as kept.
  await page.evaluate((id) => {
    const saved = JSON.parse(localStorage.getItem("lever:workspaces")!);
    delete saved[id].previews;
    localStorage.setItem("lever:workspaces", JSON.stringify(saved));
  }, agent.id);
  await page.reload();
  await openTopic("检查五");
  await expect(preview).toHaveText("检查五");
  await expect(tabs).toHaveCount(6);
  const run = runs.get(running)!;
  await expect(
    page.locator(`.topic-thread[data-session-id="${run.sessionId}"]`),
  ).toHaveAttribute("data-status", "running");
  expect(
    (await page.request.post(`/api/runs/${run.id}/stop`, { data: {} })).ok(),
  ).toBe(true);
});

test("topic tabs share panes, animate without scaling, and restore without their parent chat", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createAgent(page, "话题标签");
  await send(page, "父 Chat 上下文");
  await page
    .locator(".chat-composer-wrap")
    .getByRole("button", { name: "话题", exact: true })
    .click();
  await send(page, "独立话题标签");
  const topic = page.locator(".topic-thread");
  const sessionId = (await topic.getAttribute("data-session-id"))!;
  const root = (
    (await (await page.request.get(`/api/sessions/${sessionId}/runs`)).json())
      .runs as Run[]
  )[0];
  const topicTab = page.getByRole("tab", { name: "独立话题标签", exact: true });
  const reply = page.getByRole("textbox", { name: "回复话题", exact: true });
  const layout = page.locator(".workspace-layout");
  await topic.locator(".topic-open").click();
  await expect(layout).toHaveAttribute("data-view", "split");
  await expect(layout).toHaveAttribute("data-animated", "true");
  await expect(reply).toBeFocused();
  await expect(topicTab).toHaveCount(1);
  await expect(
    page.locator('.tab-strip[data-pane="side"]').getByRole("tab"),
  ).toHaveCount(1);
  expect(
    await page
      .locator(".topic-conversation")
      .evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  await reply.fill("标签草稿");
  await closeTab(topicTab);
  await expect(layout).toHaveAttribute("data-view", "main");
  await expect(layout).toHaveAttribute("data-animated", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await topic.locator(".topic-open").click();
  await expect(layout).toHaveAttribute("data-view", "split");
  await expect(layout).toHaveAttribute("data-animated", "false");
  await expect(reply).toHaveText("标签草稿");
  await closeTopic(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "文件", exact: true }).click();
  await expect(
    page
      .locator('.tab-strip[data-pane="side"]')
      .getByRole("tab", { name: "文件", exact: true }),
  ).toBeVisible();
  await topic.locator(".topic-open").click();
  await topic.locator(".topic-open").click();
  await expect(topicTab).toHaveCount(1);
  await expect(
    page.locator('.tab-strip[data-pane="side"]').getByRole("tab"),
  ).toHaveCount(2);
  await expect(layout).toHaveCSS("--workspace-main", "50fr");
  await page.screenshot({ path: "../output/e2e/topic-workspace-tabs.png" });
  const divider = page.getByRole("separator", {
    name: "调整分区宽度",
    exact: true,
  });
  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "55");
  await expect(layout).toHaveCSS("--workspace-main", "55fr");
  await expect(layout).toHaveAttribute("data-animated", "false");
  await divider.press("ArrowLeft");
  await expect(layout).toHaveCSS("--workspace-main", "50fr");
  // Moving an existing Topic changes its home pane; opening it again must not move it back.
  const from = (await topicTab.boundingBox())!;
  const to = (await page
    .locator('.tab-strip[data-pane="main"] .tab-scroll')
    .boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  await expect(
    page
      .locator('.tab-strip[data-pane="main"]')
      .getByRole("tab", { name: "独立话题标签", exact: true }),
  ).toBeVisible();
  const parentTab = page.locator(
    `[id="tab-${encodeURIComponent(root.chatId)}"]`,
  );
  // Dnd-kit suppresses click events briefly after a drop; keyboard navigation
  // also verifies the moved tab remains in the shared tablist's focus order.
  await parentTab.focus();
  await parentTab.press("Home");
  await expect(parentTab).toHaveAttribute("aria-selected", "true");
  await expect(topic.locator(".topic-open")).toBeVisible();
  await topic.locator(".topic-open").click();
  await expect(topicTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator('.tab-strip[data-pane="main"]').getByRole("tab"),
  ).toHaveCount(2);
  await expect(reply).toHaveText("标签草稿");
  await closeTab(parentTab);
  // Move the original message beyond the first page of its parent Chat.
  for (let i = 0; i < 41; i++) {
    const response = await page.request.post("/api/messages", {
      data: {
        commandId: crypto.randomUUID(),
        chatId: root.chatId,
        operation: "main",
        text: `后续主消息 ${i}`,
        selection: root.selection,
        attachmentIds: [],
      },
    });
    expect(response.ok()).toBe(true);
    const run = (await response.json()) as Run;
    await expect
      .poll(
        async () => {
          const runs = (
            await (
              await page.request.get(`/api/sessions/${run.sessionId}/runs`)
            ).json()
          ).runs as Run[];
          return `${runs[0]?.id}:${runs[0]?.status}`;
        },
        { intervals: [50, 100] },
      )
      .toBe(`${run.id}:completed`);
  }
  await page.reload();
  await expect(parentTab).toHaveCount(0);
  await expect(reply).toHaveText("标签草稿");
  await expect(
    page.locator(".topic-conversation .user-message").first(),
  ).toContainText("独立话题标签");
  await reply.fill("父 Chat 关闭后仍可回复");
  await page
    .locator(".topic-composer-wrap")
    .getByRole("button", { name: "发送", exact: true })
    .click();
  await expect(reply).toHaveText("");
  await expect(page.locator(".topic-conversation .run-content")).toHaveCount(2);
  await page.getByRole("button", { name: "定位原消息", exact: true }).click();
  await expect(parentTab).toBeVisible();
  await expect(topic.locator(".topic-open")).toBeFocused();
  await expect(topic.locator(".topic-open")).toBeInViewport();
  await expect(
    page
      .locator('.tab-strip[data-pane="side"]')
      .getByRole("tab", { name: "文件", exact: true }),
  ).toBeVisible();
  // Parent is now in the opposite pane. At a narrow width, only the active chat is shown.
  await page.setViewportSize({ width: 560, height: 900 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  await expect(layout).toHaveAttribute("data-view", "side");
  await expect(reply).not.toBeVisible();
  await topic.locator(".topic-open").click();
  await expect(layout).toHaveAttribute("data-view", "main");
  await expect(reply).toBeVisible();
  await expect(page.locator(".chat-panel")).not.toBeVisible();
  await expect(layout).toHaveCSS("--workspace-main", "100fr");
  await page.screenshot({ path: "../output/e2e/topic-workspace-narrow.png" });
  await page.getByRole("button", { name: "定位原消息", exact: true }).click();
  await expect(page.locator(".chat-panel")).toBeVisible();
  await expect(reply).not.toBeVisible();
  await closeTab(page.getByRole("tab", { name: "文件", exact: true }));
  await closeTab(parentTab);
  await expect(layout).toHaveAttribute("data-view", "main");
  await expect(reply).toBeVisible();
  expect(errors).toEqual([]);
});

test("terminal panes retain independent shells and output across reload", async ({
  page,
}) => {
  const sockets = new Map<string, WebSocket>();
  const output = new Map<string, string>();
  const markers = ["TERM_LEFT_READY", "TERM_RIGHT_READY"];
  const ready = new Set<string>();
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (!url.pathname.endsWith("/terminal")) return;
    const id = url.searchParams.get("terminalId")!;
    sockets.set(id, socket);
    output.set(id, "");
    ready.delete(id);
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") {
        output.set(id, output.get(id)! + payload.toString());
      } else if (JSON.parse(payload).type === "ready") ready.add(id);
    });
  });
  await createAgent(page, "Terminal panes");
  await page.getByRole("button", { name: "终端", exact: true }).click();
  const terminal = page.locator(".terminal-panel:visible");
  const panes = terminal.locator(".terminal-pane");
  const splitRight = terminal.getByRole("button", { name: "左右分屏" });
  const splitDown = terminal.getByRole("button", { name: "上下分屏" });
  const close = terminal.getByRole("button", { name: "关闭终端窗格" });
  const terminalTabs = page.getByRole("tab", { name: "终端", exact: true });

  await expect(panes).toHaveCount(1);
  await expect.poll(() => sockets.size).toBe(1);
  await splitRight.click();
  await expect(panes).toHaveCount(2);
  const left = (await panes.nth(0).boundingBox())!;
  const right = (await panes.nth(1).boundingBox())!;
  expect(right.x).toBeGreaterThan(left.x);
  expect(right.y).toBe(left.y);
  await expect(panes.nth(1).getByRole("textbox")).toBeFocused();

  await splitDown.click();
  await expect(panes).toHaveCount(3);
  const upper = (await panes.nth(1).boundingBox())!;
  const lower = (await panes.nth(2).boundingBox())!;
  expect(lower.x).toBe(upper.x);
  expect(lower.y).toBeGreaterThan(upper.y);
  expect((await panes.nth(0).boundingBox())!.height).toBe(left.height);
  await expect.poll(() => sockets.size).toBe(3);
  expect(
    [...sockets.values()].every((socket) => !socket.isClosed()),
  ).toBeTruthy();

  const [leftID, rightID, bottomID] = [...sockets.keys()];
  await close.click();
  await expect(panes).toHaveCount(2);
  await expect.poll(() => sockets.get(bottomID)!.isClosed()).toBe(true);
  expect((await panes.nth(1).boundingBox())!.height).toBe(right.height);
  await expect(panes.nth(1).getByRole("textbox")).toBeFocused();
  expect(
    [leftID, rightID].every((id) => !sockets.get(id)!.isClosed()),
  ).toBeTruthy();

  await terminal.getByRole("button", { name: "新建终端" }).click();
  await expect(terminalTabs).toHaveCount(2);
  await expect(panes).toHaveCount(1);
  await expect.poll(() => sockets.size).toBe(4);
  const newID = [...sockets.keys()].at(-1)!;
  await close.click();
  await expect(terminalTabs).toHaveCount(1);
  await expect(panes).toHaveCount(2);
  await expect.poll(() => sockets.get(newID)!.isClosed()).toBe(true);
  expect(
    [leftID, rightID].every((id) => !sockets.get(id)!.isClosed()),
  ).toBeTruthy();

  const retained = [leftID, rightID];
  const shellLines = new Map<string, string>();
  if (process.platform !== "win32") {
    for (const [index, id] of retained.entries()) {
      await expect.poll(() => ready.has(id)).toBe(true);
      await expect(panes.nth(index).locator(".terminal-status")).toHaveCount(0);
      await panes.nth(index).getByRole("textbox").focus();
      const marker = markers[index];
      // Split the marker so local echo can't satisfy the check.
      await page.keyboard.type(
        `printf '%s:%s\\n' '${marker.slice(0, 9)}''${marker.slice(9)}' $$`,
      );
      await page.keyboard.press("Enter");
      const pattern = new RegExp(`${marker}:\\d+`);
      await expect.poll(() => output.get(id)).toMatch(pattern);
      shellLines.set(id, output.get(id)!.match(pattern)![0]);
    }
  }

  const beforeReload = retained.map((id) => sockets.get(id));
  await openMoreTool(page);
  await page.reload();
  await expect
    .poll(() =>
      retained.every((id, index) => sockets.get(id) !== beforeReload[index]),
    )
    .toBe(true);
  await terminalTabs.click();
  await expect(panes).toHaveCount(2);
  for (const [index, id] of retained.entries()) {
    expect(new URL(sockets.get(id)!.url()).searchParams.has("start")).toBe(
      false,
    );
    await expect.poll(() => ready.has(id)).toBe(true);
    await expect(panes.nth(index).locator(".terminal-status")).toHaveCount(0);
    const shellLine = shellLines.get(id);
    if (!shellLine) continue;
    await expect.poll(() => output.get(id)).toContain(shellLine);
    await expect(panes.nth(index).locator(".xterm-rows")).toContainText(
      shellLine,
    );
    await panes.nth(index).getByRole("textbox").focus();
    await page.keyboard.type("printf 'AFTER_%s:%s\\n' 'RELOAD' $$");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => output.get(id))
      .toContain(`AFTER_RELOAD:${shellLine.split(":")[1]}`);
  }

  await closeTab(terminalTabs);
  await expect(terminalTabs).toHaveCount(0);
  await expect
    .poll(() => retained.every((id) => sockets.get(id)!.isClosed()))
    .toBe(true);
});

test("Worktree setup reconnects on reload and retries only the failed repository", async ({
  page,
}, testInfo) => {
  test.skip(
    process.platform === "win32",
    "The fixture uses POSIX shell commands",
  );
  test.setTimeout(60_000);
  const temp = mkdtempSync(join(dirname(context().scope), "setup-e2e-"));
  const app = join(temp, "app with spaces");
  const apiRepo = join(temp, "api");
  for (const repo of [app, apiRepo]) {
    mkdirSync(repo);
    writeFileSync(join(repo, ".gitignore"), "setup-*\n");
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
  await createAgent(page, "Worktree 初始化", app);
  await send(page, "准备工作");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const agentPath = `/api/agents/${agentId}`;
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const agent = overview.agents.find((value) => value.id === agentId)!;
  const saveScope = await page.request.put(agentPath, {
    data: {
      ...agent,
      profile: {
        ...agent.profile,
        roots: [...agent.profile.roots, { id: "api", path: apiRepo }],
      },
    },
  });
  expect(saveScope.ok(), await saveScope.text()).toBeTruthy();
  await page.reload();
  const worktreePanel = await openScopeTab(page, "Worktree");
  const setupToggle = worktreePanel.getByRole("button", {
    name: "Worktree 初始化命令",
  });
  await setupToggle.press("Enter");
  await expect(setupToggle).toHaveAttribute("aria-expanded", "true");
  const first = String.raw`printf '%s\n' "$$" >> setup-pids; echo SETUP_WAITING; until [ -f setup-release ]; do sleep 0.05; done; printf from-browser > setup-marker`;
  const second =
    "echo attempt >> setup-attempts; if [ ! -f setup-failed ]; then touch setup-failed; echo RETRY_REQUIRED; exit 7; fi";
  await page
    .getByRole("textbox", { name: "app with spaces 的初始化命令" })
    .fill(first);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(agentPath) &&
      response.request().method() === "PUT" &&
      Object.values(
        response.request().postDataJSON()?.profile?.worktreeSetup ?? {},
      ).includes(second),
  );
  await page.getByRole("textbox", { name: "api 的初始化命令" }).fill(second);
  await page.getByRole("textbox", { name: "api 的初始化命令" }).blur();
  expect((await saved).ok()).toBeTruthy();
  await page.getByRole("tab", { name: "准备工作", exact: true }).click();
  const composer = page.locator(".chat-composer-wrap:visible");
  const textbox = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  await textbox.fill("[worktree-setup]");
  const worktrees = composer.getByRole("button", {
    name: "工作目录组",
    exact: true,
  });
  await expect(worktrees).toHaveCount(0);
  const groupsPanel = await openScopeTab(page, "目录组");
  await groupsPanel
    .getByRole("button", { name: "新建目录组", exact: true })
    .click();
  await groupsPanel
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("初始化测试");
  await groupsPanel
    .getByRole("combobox", { name: "app with spaces 的工作目录" })
    .click();
  await page
    .getByRole("option", { name: "新建 worktree", exact: true })
    .click();
  await groupsPanel.getByRole("combobox", { name: "api 的工作目录" }).click();
  await page
    .getByRole("option", { name: "新建 worktree", exact: true })
    .click();
  await expect(
    groupsPanel.getByRole("checkbox", { name: /运行初始化命令/ }),
  ).toHaveCount(2);
  const started: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/setup/"))
      started.push(request.url());
  });
  await groupsPanel.getByRole("button", { name: "创建并初始化" }).dblclick();
  await expect(
    groupsPanel.getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible();
  await expect(groupsPanel.getByRole("alert")).toContainText("已退出（7）");
  const [copy] = (await (
    await page.request.get(`${agentPath}/working-copies`)
  ).json()) as WorkingCopy[];
  const [primary, other] = copy.checkouts;
  await expect
    .poll(() => existsSync(join(primary.path, "setup-pids")))
    .toBeTruthy();
  const initialPid = readFileSync(join(primary.path, "setup-pids"), "utf8");
  expect(started).toHaveLength(2);

  const attached = page.waitForEvent("websocket", {
    predicate: (socket) =>
      new URL(socket.url()).pathname === new URL(started[0]).pathname,
  });
  await page.reload();
  const tabs = await openProfileScope(page);
  await expect(
    tabs.getByRole("tab", { name: "目录组", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await attached;
  await expect(
    groupsPanel.getByRole("button", { name: "停止初始化" }),
  ).toBeVisible();
  expect(started).toHaveLength(2);
  expect(readFileSync(join(primary.path, "setup-pids"), "utf8")).toBe(
    initialPid,
  );
  writeFileSync(join(primary.path, "setup-release"), "");
  await expect(
    groupsPanel.getByText("初始化完成", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 580, height: 820 });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  await groupsPanel.screenshot({
    path: testInfo.outputPath("worktree-setup-retry.png"),
    animations: "disabled",
  });
  await groupsPanel.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    groupsPanel.getByRole("button", { name: "新建目录组", exact: true }),
  ).toBeVisible();
  expect(started).toHaveLength(3);
  expect(readFileSync(join(primary.path, "setup-pids"), "utf8")).toBe(
    initialPid,
  );
  expect(readFileSync(join(other.path, "setup-attempts"), "utf8")).toBe(
    "attempt\nattempt\n",
  );
  expect(existsSync(join(app, "setup-pids"))).toBeFalsy();
  expect(existsSync(join(apiRepo, "setup-attempts"))).toBeFalsy();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("tab", { name: "准备工作", exact: true }).click();
  await worktrees.click();
  await page.getByRole("menuitemradio", { name: /^初始化测试/ }).click();
  await expect(worktrees).toHaveAttribute("title", primary.path);
  await expect(textbox).toHaveText("[worktree-setup]");
  await expect(page.locator(".topic-thread")).toHaveCount(0);
  await send(page);
  await expect(page.locator(".topic-thread")).toContainText(
    "Worktree setup: from-browser",
  );

  await openScopeTab(page, "目录组");
  await groupsPanel
    .getByRole("button", { name: "新建目录组", exact: true })
    .click();
  await groupsPanel
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("跳过初始化");
  await groupsPanel
    .getByRole("combobox", { name: "app with spaces 的工作目录" })
    .click();
  await page
    .getByRole("option", { name: "新建 worktree", exact: true })
    .click();
  await expect(
    groupsPanel.getByRole("checkbox", { name: /运行初始化命令/ }),
  ).toHaveCount(1);
  await groupsPanel.getByRole("button", { name: "创建并初始化" }).click();
  await expect(
    groupsPanel.getByRole("button", { name: "停止初始化" }),
  ).toBeVisible();
  const [stoppedCopy] = (await (
    await page.request.get(`${agentPath}/working-copies`)
  ).json()) as WorkingCopy[];
  const stoppedPath = stoppedCopy.checkouts[0].path;
  await expect
    .poll(() => existsSync(join(stoppedPath, "setup-pids")))
    .toBeTruthy();
  const stoppedPid = Number(
    readFileSync(join(stoppedPath, "setup-pids"), "utf8").trim(),
  );
  await groupsPanel.getByRole("button", { name: "停止初始化" }).click();
  await groupsPanel
    .getByRole("button", { name: "跳过初始化", exact: true })
    .click();
  await expect(
    groupsPanel.getByRole("button", { name: "新建目录组", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "准备工作", exact: true }).click();
  await worktrees.click();
  await page.getByRole("menuitemradio", { name: /^跳过初始化/ }).click();
  await expect(worktrees).toHaveAttribute("title", stoppedPath);
  expect(() => process.kill(stoppedPid, 0)).toThrow(/ESRCH/);
  expect(existsSync(join(stoppedPath, "setup-marker"))).toBeFalsy();
  expect(started).toHaveLength(4);
  await expect(page.locator(".topic-thread")).toHaveCount(1);
});

test("directory groups reuse worktrees and keep Topic tools in the selected Scope", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await createAgent(page, "多目录工作副本");
  const agentId = await page.evaluate(
    () => localStorage.getItem("lever:agent")!,
  );
  const temp = mkdtempSync(join(dirname(context().scope), "copy-e2e-"));
  const app = join(temp, "app");
  const apiRepo = join(temp, "api");
  const notes = join(temp, "notes");
  mkdirSync(join(app, "web"), { recursive: true });
  mkdirSync(join(app, "packages"));
  mkdirSync(apiRepo);
  mkdirSync(notes);
  writeFileSync(join(app, "web", "shared.txt"), "app baseline\n");
  writeFileSync(join(app, "packages", "shared.txt"), "packages baseline\n");
  writeFileSync(join(apiRepo, "shared.txt"), "api baseline\n");
  writeFileSync(join(notes, "notes.txt"), "shared notes\n");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  for (const repo of [app, apiRepo]) {
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Initial",
    );
  }
  writeFileSync(join(app, "web", "shared.txt"), "uncommitted original\n");
  const overview = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const agent = overview.agents.find((candidate) => candidate.id === agentId)!;
  const scope = {
    roots: [
      { id: "web", path: join(app, "web") },
      { id: "packages", path: join(app, "packages") },
      { id: "api", path: apiRepo },
      { id: "notes", path: notes },
    ],
    primaryRootId: "web",
  };
  const save = await page.request.put(`/api/agents/${agentId}`, {
    data: { ...agent, profile: { ...agent.profile, ...scope } },
  });
  expect(save.ok(), await save.text()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".model-trigger:visible")).toContainText(
    "GPT Test",
  );
  const composer = page.locator(".chat-composer-wrap:visible");
  await expect(
    composer.getByRole("button", { name: "工作目录组", exact: true }),
  ).toHaveCount(0);
  await send(page, "普通发送");
  expect(
    git(app, "worktree", "list", "--porcelain").match(/^worktree /gm),
  ).toHaveLength(1);
  await composer.getByRole("button", { name: "话题", exact: true }).click();
  const workspace = composer.getByRole("button", {
    name: "工作目录组",
    exact: true,
  });
  await expect(workspace).toHaveCount(0);
  const directoryMenu = page.getByRole("menu");
  const scopeTabs = await openProfileScope(page);
  const directoryTab = scopeTabs.getByRole("tab", {
    name: "目录",
    exact: true,
  });
  const directory = page
    .getByRole("tabpanel", { name: "目录", exact: true })
    .getByRole("textbox", { name: "工作范围目录", exact: true })
    .first();
  const savedDirectory = await directory.inputValue();
  await directory.clear();
  await expect(
    page.getByText("请输入目录路径，或移除该行。", { exact: true }),
  ).toBeVisible();
  await directoryTab.press("ArrowRight");
  const groupsPanel = page.getByRole("tabpanel", {
    name: "目录组",
    exact: true,
  });
  await expect(
    groupsPanel.getByText("暂无目录组", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("修正并完成工作目录保存后，这里会使用更新后的目录。", {
      exact: true,
    }),
  ).toBeVisible();
  await directoryTab.click();
  await directory.fill(savedDirectory);
  await directory.blur();
  await directoryTab.press("ArrowRight");
  const scopeCard = page
    .locator('[data-slot="card"]')
    .filter({ has: scopeTabs });
  await groupsPanel
    .getByRole("button", { name: "新建目录组", exact: true })
    .click();
  const groupName = groupsPanel.getByRole("textbox", {
    name: "名称",
    exact: true,
  });
  await groupName.fill("跨仓库试验");
  const worktreePanel = await openScopeTab(page, "Worktree");
  await expect(
    worktreePanel.getByText("暂无 worktree", { exact: true }),
  ).toBeVisible();
  await openScopeTab(page, "目录组");
  await expect(groupName).toHaveValue("跨仓库试验");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await groupsPanel.getByRole("combobox", { name: "app 的工作目录" }).click();
  await page
    .getByRole("option", { name: "新建 worktree", exact: true })
    .click();
  await expect(
    groupsPanel.getByRole("button", { name: "创建 1 个 worktree 并保存组" }),
  ).toBeVisible();
  await groupsPanel.getByRole("combobox", { name: "api 的工作目录" }).click();
  await page
    .getByRole("option", { name: "新建 worktree", exact: true })
    .click();
  await scopeCard.screenshot({
    path: "../output/e2e/worktree-create.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 720, height: 820 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  await expect(
    groupsPanel.getByRole("button", { name: "创建 2 个 worktree 并保存组" }),
  ).toBeVisible();
  await scopeCard.screenshot({
    path: "../output/e2e/worktree-create-narrow.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page
    .getByRole("button", { name: "展开 Agent 列表", exact: true })
    .click();
  const copiesURL = `/api/agents/${agentId}/working-copies`;
  const optionsResponse = await page.request.get(
    `${copiesURL}/options?requestId=${randomUUID()}`,
  );
  expect(optionsResponse.ok()).toBeTruthy();
  const options = (await optionsResponse.json()) as CopyOptions;
  expect(options.groups.map((group) => group.rootIds)).toEqual([
    ["web", "packages"],
    ["api"],
  ]);
  // Occupy the second destination after preview. Git must keep the first
  // successful checkout and retry only the missing checkout.
  const secondPath = await groupsPanel
    .getByText(/lever\/.+ · .+-api$/)
    .innerText();
  const blocked = secondPath.split(" · ").at(-1)!;
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, "occupied"), "fixture blocker");
  await groupsPanel
    .getByRole("button", { name: "创建 2 个 worktree 并保存组" })
    .click();
  await expect(groupsPanel.getByRole("alert")).toContainText("already exists");
  const [partial] = (await (
    await page.request.get(copiesURL)
  ).json()) as WorkingCopy[];
  expect(partial.state).toBe("preparing");
  expect(partial.checkouts.map((checkout) => checkout.ready)).toEqual([
    true,
    false,
  ]);
  rmSync(blocked, { recursive: true });
  await groupsPanel.getByRole("button", { name: "重试准备" }).click();
  const newGroup = groupsPanel.getByRole("button", {
    name: "新建目录组",
    exact: true,
  });
  await expect(newGroup).toBeVisible();
  const [copy] = (await (
    await page.request.get(copiesURL)
  ).json()) as WorkingCopy[];
  expect(copy.id).toBe(partial.id);
  expect(copy.state).toBe("ready");
  const groupActions = groupsPanel.getByRole("button", {
    name: "跨仓库试验 目录组操作",
  });
  await groupActions.click();
  await page.getByRole("menuitem", { name: "复制目录组", exact: true }).click();
  await groupsPanel
    .getByRole("textbox", { name: "名称", exact: true })
    .fill("复用主仓库");
  await groupsPanel.getByRole("combobox", { name: "api 的工作目录" }).click();
  await page.getByRole("option", { name: "使用默认目录", exact: true }).click();
  await groupsPanel
    .getByRole("button", { name: "保存目录组", exact: true })
    .click();
  await expect(newGroup).toBeVisible();

  await newGroup.click();
  await groupName.fill("API 单仓");
  await openScopeTab(page, "Worktree");
  const addWorktree = worktreePanel.getByRole("button", {
    name: "添加 worktree",
    exact: true,
  });
  await addWorktree.click();
  await worktreePanel
    .getByRole("combobox", { name: "来源仓库", exact: true })
    .click();
  await page.getByRole("option", { name: "api", exact: true }).click();
  const worktreeName = worktreePanel.getByRole("textbox", {
    name: "名称",
    exact: true,
  });
  await worktreeName.fill("独立 API");
  await worktreeName.press("Enter");
  await expect(addWorktree).toBeVisible();
  await expect(
    worktreePanel.getByText("独立 API", { exact: true }),
  ).toBeVisible();
  await openScopeTab(page, "目录组");
  await expect(groupName).toHaveValue("API 单仓");
  await groupsPanel.getByRole("combobox", { name: "api 的工作目录" }).click();
  await page.getByRole("option", { name: "独立 API", exact: true }).click();
  await groupsPanel
    .getByRole("button", { name: "保存目录组", exact: true })
    .click();
  await expect(newGroup).toBeVisible();
  const groups = (await (
    await page.request.get(copiesURL)
  ).json()) as WorkingCopy[];
  const reused = groups.find((group) => group.name === "复用主仓库")!;
  const apiOnly = groups.find((group) => group.name === "API 单仓")!;
  expect(reused.worktreeIds).toEqual([copy.worktreeIds[0]]);
  expect(reused.roots.find((root) => root.id === "api")?.path).toBe(
    options.roots.find((root) => root.id === "api")?.path,
  );
  expect(apiOnly.worktreeIds).toHaveLength(1);
  expect(apiOnly.roots.find((root) => root.id === "web")?.path).toBe(
    options.roots.find((root) => root.id === "web")?.path,
  );
  expect(apiOnly.checkouts[0].name).toBe("独立 API");
  await scopeCard.screenshot({
    path: "../output/e2e/directory-groups.png",
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "普通发送", exact: true }).click();
  await expect(workspace).toHaveText("默认工作范围");
  await expect(workspace).toHaveAttribute("title", /[/\\]app[/\\]web$/);
  await page.setViewportSize({ width: 580, height: 820 });
  await page
    .getByRole("button", { name: "收起 Agent 列表", exact: true })
    .click();
  await expect(page.locator("#agent-sidebar")).toHaveCSS("width", "0px");
  await page.emulateMedia({ colorScheme: "dark" });
  await workspace.click();
  await expect(directoryMenu).toBeVisible();
  await expect(
    directoryMenu.getByRole("menuitem", { name: "新建 worktree" }),
  ).toHaveCount(0);
  const controls = (await composer.locator(".composer-actions").boundingBox())!;
  const buttons = (await composer.locator(".composer-submit").boundingBox())!;
  expect(buttons.x + buttons.width).toBeLessThanOrEqual(
    controls.x + controls.width,
  );
  const menuBounds = (await directoryMenu.boundingBox())!;
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(580);
  await page.screenshot({
    path: "../output/e2e/topic-workspace-menu-narrow.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(workspace).toBeFocused();
  await workspace.press("ArrowDown");
  await directoryMenu
    .getByRole("menuitemradio", { name: /API 单仓.*api → 独立 API/ })
    .click();
  await expect(workspace).toHaveText("API 单仓");
  await expect(workspace).toHaveAttribute("title", /[/\\]app[/\\]web$/);
  await expect(directoryMenu).not.toBeVisible();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await workspace.press("ArrowDown");
  await directoryMenu
    .getByRole("menuitemradio", { name: /^跨仓库试验/ })
    .click();
  await expect(workspace).toHaveAttribute(
    "title",
    copy.roots.find((root) => root.id === "web")!.path,
  );
  expect(copy.checkouts.map((checkout) => checkout.path)).toEqual(
    partial.checkouts.map((checkout) => checkout.path),
  );
  const cwd = copy.roots.find((root) => root.id === "web")!.path;
  expect(readFileSync(join(cwd, "shared.txt"), "utf8")).toBe("app baseline\n");
  expect(copy.roots.find((root) => root.id === "packages")!.path).toBe(
    join(copy.checkouts[0].path, "packages"),
  );
  expect(copy.roots.find((root) => root.id === "notes")!.path).toBe(
    options.roots.find((root) => root.id === "notes")!.path,
  );
  const input = composer.getByRole("textbox", {
    name: "发送消息",
    exact: true,
  });
  const worktreeSkill = join(cwd, ".agents", "skills", "worktree-review");
  mkdirSync(worktreeSkill, { recursive: true });
  writeFileSync(
    join(worktreeSkill, "SKILL.md"),
    "---\nname: worktree-review\n---\n\n# Worktree Skill details\n",
  );
  await input.fill("/worktree-review");
  await page.getByRole("option", { name: /\/worktree-review/ }).click();
  await input
    .getByRole("button", { name: "worktree-review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Worktree Skill details" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "普通发送", exact: true }).click();
  await expect(workspace).toHaveText("跨仓库试验");
  rmSync(worktreeSkill, { recursive: true });
  await input.fill("@shared");
  await expect(
    page.getByRole("option", { name: "shared.txt", exact: true }),
  ).toHaveCount(3);
  await page
    .getByRole("option", { name: "shared.txt", exact: true })
    .first()
    .click();
  await input.pressSequentially(" [wire]");
  const draftFile = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/file") &&
      url.searchParams.get("workingCopyId") === copy.id &&
      url.searchParams.get("path") === "shared.txt"
    );
  });
  await input.getByRole("button", { name: "shared.txt", exact: true }).click();
  expect((await draftFile).ok()).toBe(true);
  await expect(
    page.locator('.tab-panel[data-pane="side"]:visible .monaco-editor'),
  ).toContainText(/(?:app|packages|api)\s+baseline/);
  await send(page);
  const topicId = await page
    .locator(".topic-thread")
    .getAttribute("data-session-id");
  const view = (await (
    await page.request.get(`/api/sessions/${topicId}`)
  ).json()) as SessionView;
  expect(view.session.workingCopyId).toBe(copy.id);
  expect(view.session.workingCopyName).toBe("跨仓库试验");
  expect(view.session.roots).toEqual(copy.roots);
  expect(
    view.root!.references?.[0].path.startsWith(copy.checkouts[0].path + "/") ||
      view.root!.references?.[0].path.startsWith(copy.checkouts[1].path + "/"),
  ).toBeTruthy();
  expect(
    view.root!.items.some((item) => item.text.includes(`"cwd":"${cwd}"`)),
  ).toBeTruthy();
  await page
    .locator(".topic-thread")
    .getByRole("button", { name: "回复", exact: true })
    .click();
  const topic = page.locator(".topic-conversation:visible");
  await topic.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("treeitem", { name: "shared.txt", exact: true }).click();
  await expect(page.locator(".monaco-editor:visible")).toContainText(
    "app baseline",
  );
  const mod = (await page.evaluate(() => navigator.platform.includes("Mac")))
    ? "Meta"
    : "Control";
  await page.keyboard.press(`${mod}+k`);
  const search = page.getByRole("dialog", { name: "搜索 Lever" });
  const searchInput = search.getByRole("combobox", { name: "搜索 Lever" });
  await search.getByRole("radio", { name: "文件", exact: true }).click();
  const searched = page.waitForResponse(
    (response) =>
      response.url().includes("/files/search?") &&
      response.url().includes("query=shared.txt"),
  );
  await searchInput.fill("shared.txt");
  expect(new URL((await searched).url()).searchParams.get("sessionId")).toBe(
    topicId,
  );
  await expect(search.getByRole("option")).toHaveCount(3);
  await search.getByRole("combobox", { name: "工作目录" }).click();
  await page.getByRole("option", { name: "packages", exact: true }).click();
  await expect(searchInput).toHaveValue("shared.txt");
  await expect(search.getByRole("option")).toHaveCount(1);
  await expect(search.getByRole("option")).toContainText("packages");
  await page.keyboard.press("Escape");
  const displayedDiff = page.waitForResponse(
    (response) =>
      response.url().includes("/diff?") &&
      response.url().includes(`sessionId=${topicId}`),
  );
  await topic.getByRole("button", { name: "变更", exact: true }).click();
  expect((await (await displayedDiff).json()).files).toEqual([]);
  const terminalPath = `/api/agents/${agentId}/terminal`;
  const nextTerminal = () =>
    page.waitForEvent("websocket", {
      predicate: (socket) => new URL(socket.url()).pathname === terminalPath,
    });
  const terminalReady = nextTerminal().then((socket) =>
    socket.waitForEvent("framereceived", {
      predicate: ({ payload }) =>
        typeof payload === "string" && JSON.parse(payload).type === "ready",
    }),
  );
  await topic.getByRole("button", { name: "终端", exact: true }).click();
  const ready = await terminalReady;
  expect(JSON.parse(ready.payload as string).cwd).toBe(cwd);
  const terminal = page.locator(".terminal-panel:visible");
  const terminalTab = page.getByRole("tab", { name: "终端", exact: true });
  const scopedSplit = nextTerminal();
  await terminal.getByRole("button", { name: "左右分屏" }).click();
  expect(new URL((await scopedSplit).url()).searchParams.get("sessionId")).toBe(
    topicId,
  );
  const scopedNew = nextTerminal();
  await terminal.getByRole("button", { name: "新建终端" }).click();
  expect(new URL((await scopedNew).url()).searchParams.get("sessionId")).toBe(
    topicId,
  );
  await expect(terminalTab).toHaveCount(2);
  await terminal.getByRole("button", { name: "关闭终端窗格" }).click();
  await expect(terminalTab).toHaveCount(1);
  const worktreesURL = `/api/agents/${agentId}/worktrees`;
  const appCheckout = `${worktreesURL}/${copy.checkouts[0].id}`;
  const apiCheckout = `${worktreesURL}/${copy.checkouts[1].id}`;
  const deleteGroup = await page.request.delete(`${copiesURL}/${copy.id}`);
  expect(deleteGroup.ok(), await deleteGroup.text()).toBeTruthy();
  const reusedCheckout = await page.request.delete(appCheckout);
  expect(reusedCheckout.status()).toBe(409);
  expect(await reusedCheckout.text()).toContain("复用主仓库");
  const inUse = await page.request.delete(apiCheckout);
  expect(inUse.status()).toBe(409);
  expect(await inUse.text()).toContain("terminal is using this worktree");
  const continuation = await page.request.post("/api/messages", {
    data: {
      commandId: randomUUID(),
      chatId: view.session.chatId,
      sessionId: topicId,
      operation: "reply",
      text: "[approval]",
    },
  });
  expect(continuation.ok(), await continuation.text()).toBeTruthy();
  const turn = (await continuation.json()) as Run;
  const borrowedPath = join(temp, "borrowed-api");
  git(apiRepo, "worktree", "add", "-qb", "fixture-borrowed", borrowedPath);
  const borrowedId = randomUUID();
  const borrowedOptions = await page.request.get(
    `${copiesURL}/options?requestId=${borrowedId}`,
  );
  const discovered = (await borrowedOptions.json()) as CopyOptions;
  const apiGroup = discovered.groups.find((group) =>
    group.rootIds.includes("api"),
  )!;
  const existingPath = apiGroup.existing.find(
    (entry) => entry.branch === "fixture-borrowed",
  )!.path;
  const borrowed = await page.request.post(copiesURL, {
    data: {
      id: borrowedId,
      name: "外部副本",
      choices: [{ source: apiGroup.source, path: existingPath }],
      scope: {
        roots: discovered.roots,
        primaryRootId: discovered.primaryRootId,
      },
    },
  });
  expect(borrowed.ok(), await borrowed.text()).toBeTruthy();
  expect((await borrowed.json()).state).toBe("ready");
  const parallel = await page.request.post("/api/messages", {
    data: {
      commandId: randomUUID(),
      chatId: view.session.chatId,
      operation: "topic",
      text: "[approval]",
      workingCopyId: borrowedId,
    },
  });
  expect(parallel.ok(), await parallel.text()).toBeTruthy();
  const parallelTurn = (await parallel.json()) as Run;
  const turnRequest = async (runId = turn.id) => {
    const overview = (await (
      await page.request.get("/api/overview")
    ).json()) as Overview;
    return overview.requests.find((request) => request.runId === runId)?.id;
  };
  await expect.poll(turnRequest).toBeTruthy();
  await expect.poll(() => turnRequest(parallelTurn.id)).toBeTruthy();
  const busyCopy = await page.request.delete(apiCheckout);
  expect(await busyCopy.text()).toContain("active, queued or unconfirmed");
  const fileURL = `/api/agents/${agentId}/file?sessionId=${topicId}&root=api&path=shared.txt`;
  const original = (await (
    await page.request.get(fileURL)
  ).json()) as FileContent;
  const scopedAPI = copy.roots.find((root) => root.id === "api")!.path;
  const updated = await page.request.put(fileURL, {
    data: {
      content: "scoped API edit\n",
      version: original.version,
      rootPath: scopedAPI,
    },
  });
  expect(updated.ok(), await updated.text()).toBeTruthy();
  const borrowedFile = `/api/agents/${agentId}/file?sessionId=${parallelTurn.sessionId}&root=api&path=shared.txt`;
  const borrowedContent = (await (
    await page.request.get(borrowedFile)
  ).json()) as FileContent;
  const writeBorrowed = await page.request.put(borrowedFile, {
    data: {
      content: "borrowed API edit\n",
      version: borrowedContent.version,
      rootPath: existingPath,
    },
  });
  expect(writeBorrowed.ok(), await writeBorrowed.text()).toBeTruthy();
  const parallelApproval = await page.request.post(
    `/api/requests/${await turnRequest(parallelTurn.id)}/answer`,
    { data: { allow: true } },
  );
  expect(parallelApproval.ok(), await parallelApproval.text()).toBeTruthy();
  const approval = await page.request.post(
    `/api/requests/${await turnRequest()}/answer`,
    { data: { allow: true } },
  );
  expect(approval.ok(), await approval.text()).toBeTruthy();
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/sessions/${topicId}/runs`)
      ).json();
      return data.runs.find((run: Run) => run.id === turn.id)?.status;
    })
    .toBe("completed");
  const diff = await page.request.get(
    `/api/agents/${agentId}/diff?sessionId=${topicId}&root=api&mode=working`,
  );
  expect(diff.ok(), await diff.text()).toBeTruthy();
  expect((await diff.json()).patch).toContain("+scoped API edit");
  expect(readFileSync(join(apiRepo, "shared.txt"), "utf8")).toBe(
    "api baseline\n",
  );
  expect(readFileSync(join(app, "web", "shared.txt"), "utf8")).toBe(
    "uncommitted original\n",
  );
  await closeTab(terminalTab);
  await expect(terminalTab).toHaveCount(0);
  await expect
    .poll(async () => {
      const dirty = await page.request.delete(apiCheckout);
      return dirty.text();
    })
    .toContain("local changes");
  expect(existsSync(copy.checkouts[0].path)).toBeTruthy();
  writeFileSync(join(scopedAPI, "shared.txt"), "api baseline\n");
  const removed = await page.request.delete(apiCheckout);
  expect(removed.ok(), await removed.text()).toBeTruthy();
  expect(existsSync(copy.checkouts[1].path)).toBeFalsy();
  expect(existsSync(copy.checkouts[0].path)).toBeTruthy();
  expect(git(apiRepo, "branch", "--list", copy.checkouts[1].branch)).toContain(
    copy.checkouts[1].branch,
  );
  expect((await page.request.get(fileURL)).status()).toBe(409);
  expect(
    (await page.request.get(`/api/sessions/${topicId}`)).ok(),
  ).toBeTruthy();
});

test("Skills edits managed files and attaches them from Agent Profile", async ({
  page,
}) => {
  const agentName = "Skill Library Reviewer";
  const name = `review-${randomUUID().slice(0, 8)}`;
  const directory = join(context().otherScope, name);
  mkdirSync(directory);
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Team review\n---\n\n# Team review\n`,
  );
  await createAgent(page, agentName);
  const nav = page.getByRole("navigation", { name: "主导航" });
  const skillsMenu = nav.getByRole("button", { name: "技能", exact: true });
  const library = page.getByRole("region", { name: "技能", exact: true });
  const managed = library.getByRole("group", { name: "Lever 托管", exact: true });
  await skillsMenu.click();
  await library
    .getByRole("button", { name: "添加技能", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /^新建技能/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("技能名称", { exact: true }).fill(name);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/skills") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const response = await created;
  expect(response.ok()).toBeTruthy();
  const skill = (await response.json()) as { path: string };
  const content = `---\nname: ${name}\ndescription: Managed review\n---\n\n# Review workspace\n\n[Checklist](references/checklist.md)\n`;
  mkdirSync(join(skill.path, "references"));
  writeFileSync(
    join(skill.path, "references", "checklist.md"),
    "# Review checklist\n",
  );
  const editor = library.locator(".monaco-editor:visible .view-lines");
  await expect(editor).toContainText(name);
  const editMode = library.getByRole("radio", { name: "编辑", exact: true });
  const previewMode = library.getByRole("radio", { name: "预览", exact: true });
  await expect(editMode).toBeChecked();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(content);
  await previewMode.click();
  await expect(previewMode).toBeChecked();
  await expect(library.getByRole("heading", { name: "Review workspace" })).toBeVisible();
  await expect
    .poll(() => readFileSync(join(skill.path, "SKILL.md"), "utf8"))
    .toBe(content);
  await library.getByRole("link", { name: "Checklist" }).click();
  await expect(
    library.getByRole("heading", { name: "Review checklist" }),
  ).toBeVisible();
  const tree = library.getByRole("complementary", { name: "文件目录", exact: true });
  await tree.getByRole("button", { name: "刷新目录" }).click();
  const checklist = tree.getByRole("treeitem", { name: "checklist.md", exact: true });
  await expect(checklist).toHaveAttribute("aria-selected", "true");
  await expect(checklist.locator('svg[data-icon-token="markdown"]')).toBeVisible();
  await expect(tree.getByRole("treeitem").first()).toHaveAccessibleName("SKILL.md");
  await expect(library.getByRole("navigation", { name: "文件路径" })).toContainText("references/checklist.md");
  const [menuBox, treeBox, docBox] = await Promise.all([
    library.getByRole("navigation", { name: "技能", exact: true }).boundingBox(),
    tree.boundingBox(),
    library.locator(".file-preview").boundingBox(),
  ]);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(treeBox!.x + 1);
  expect(treeBox!.x + treeBox!.width).toBeCloseTo(docBox!.x, 0);
  await editMode.click();
  await expect(editor).toContainText("# Review checklist");
  await expect(checklist).toHaveAttribute("aria-selected", "true");
  await previewMode.click();

  await library
    .getByRole("button", { name: "添加到技能库", exact: true })
    .click();
  await page
    .getByRole("dialog").getByRole("button", { name: /^添加已有目录/ })
    .click();
  await page.getByLabel("技能目录", { exact: true }).fill(directory);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(
    library.getByRole("heading", { name: "Team review" }),
  ).toBeVisible();
  await expect(
    library.getByRole("status").filter({ hasText: "只读" }),
  ).toBeVisible();
  await expect(editMode).toHaveCount(0);
  await library.getByRole("radio", { name: "源码", exact: true }).click();
  await expect(editor).toContainText("# Team review");
  await expect(library.getByRole("button", { name: "保存文件" })).toHaveCount(0);
  await expect(tree.getByRole("button", { name: "新建文件" })).toHaveCount(0);
  await previewMode.click();
  await expect(
    library
      .getByRole("group", { name: "外部目录", exact: true })
      .getByRole("button", { name }),
  ).toHaveAttribute("aria-current", "page");

  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByRole("button", { name: `打开 ${agentName} 的配置`, exact: true })
    .click();
  await page.getByRole("button", { name: "添加技能", exact: true }).click();
  await page.getByRole("combobox", { name: "搜索技能" }).fill(name);
  const saved = page.waitForResponse(
    (response) =>
      /\/api\/agents\/[^/]+$/.test(response.url()) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("option", { name: `${name} Lever` }).click();
  const profile = (await (await saved).json()) as Agent;
  expect(profile.profile.skills).toEqual([skill.path]);

  await skillsMenu.click();
  await library.getByRole("button", { name: "Lever 托管", exact: true }).click();
  await managed.getByRole("button", { name }).click();
  await library
    .getByRole("button", { name: "引用此技能的 Agent", exact: true })
    .click();
  const usage = page.getByRole("dialog", { name: "引用此技能的 Agent" });
  await expect(usage.getByText(agentName, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 420, height: 800 });
  await managed.getByRole("button", { name }).click();
  await expect(
    library.getByRole("heading", { name: "Review workspace" }),
  ).toBeVisible();
  await library
    .getByRole("button", { name: "显示文件目录", exact: true })
    .click();
  const modesBox = (await library.getByRole("radiogroup", { name: "文件显示模式" }).boundingBox())!;
  expect(modesBox.y + modesBox.height).toBeLessThanOrEqual((await tree.boundingBox())!.y);
  await previewMode.click();
  await expect(tree).toBeHidden();
  await library.getByRole("button", { name: "显示文件目录", exact: true }).click();
  await library
    .getByRole("treeitem", { name: "SKILL.md", exact: true })
    .click();
  await expect(
    library.getByRole("heading", { name: "Review workspace" }),
  ).toBeVisible();
});

test("Skills opens same-name discoveries from each source in Files", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const agentName = `Skill Discovery ${suffix}`;
  const name = `discover-${suffix}`;
  const scope = context().scope;
  const second = join(context().otherScope, `scope-${suffix}`);
  await createAgent(page, agentName);
  const overview = await page.request.get("/api/overview");
  expect(overview.ok()).toBeTruthy();
  const { homeDir } = (await overview.json()) as Overview;
  const fixtures = [
    {
      group: "用户全局",
      root: homeDir,
      collection: ".agents",
      content: "User skill",
    },
    {
      group: "项目 Scope",
      root: scope,
      collection: ".codex",
      content: "Primary Scope skill",
    },
    {
      group: "项目 Scope",
      root: second,
      collection: ".claude",
      content: "Secondary Scope skill",
    },
  ];
  for (const fixture of fixtures) {
    const dir = join(fixture.root, fixture.collection, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\n---\n\n# ${fixture.content}\n\n[Notes](notes.md)\n`,
    );
    writeFileSync(join(dir, "notes.md"), `# Notes for ${fixture.content}\n`);
  }
  await page
    .getByRole("button", { name: `打开 ${agentName} 的配置`, exact: true })
    .click();
  const saved = page.waitForResponse(
    (response) =>
      /\/api\/agents\/[^/]+$/.test(response.url()) &&
      response.request().method() === "PUT",
  );
  await enterScopePath(
    page,
    page.getByRole("button", { name: "添加目录", exact: true }),
    second,
  );
  expect((await saved).ok()).toBeTruthy();

  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "技能", exact: true })
    .click();
  const library = page.getByRole("region", { name: "技能", exact: true });
  const folders = library.getByRole("navigation", {
    name: "技能",
    exact: true,
  });
  for (const fixture of fixtures) {
    const folder = folders.getByRole("button", { name: fixture.group, exact: true });
    if (await folder.getAttribute("aria-expanded") !== "true") await folder.click();
    const row = folders
      .getByRole("group", { name: fixture.group, exact: true })
      .getByRole("button", { name }).filter({ hasText: fixture.collection });
    await expect(row).toContainText(fixture.collection);
    await row.click();
    await expect(
      library.getByRole("heading", { name: fixture.content, exact: true }),
    ).toBeVisible();
    await expect(
      library.getByRole("status").filter({ hasText: "只读" }),
    ).toBeVisible();
    await library.getByRole("link", { name: "Notes", exact: true }).click();
    await expect(
      library.getByRole("heading", {
        name: `Notes for ${fixture.content}`,
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("Skills overview filters and saves preferences for the selected Agent", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const agentName = `Skill preferences ${suffix}`;
  const otherName = `Skill browsing ${suffix}`;
  const name = `preference-${suffix}`;
  await createAgent(page, agentName);
  const overviewResponse = await page.request.get("/api/overview");
  expect(overviewResponse.ok()).toBeTruthy();
  const { homeDir, agents } = (await overviewResponse.json()) as Overview;
  const agent = agents.find((item) => item.name === agentName)!;
  const created = await page.request.post("/api/agents", {
    data: {
      ...agent,
      id: "",
      name: otherName,
      profile: {
        ...agent.profile,
        roots: [
          { id: agent.profile.primaryRootId, path: context().otherScope },
        ],
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  for (const dir of [
    join(homeDir, ".agents", "skills"),
    join(context().scope, ".codex", "skills"),
  ]) {
    const skill = join(dir, name);
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      `---\nname: ${name}\ndescription: Review preferences\n---\n\n# Overview fixture\n`,
    );
  }
  await page
    .getByRole("button", { name: `打开 ${agentName} 的配置`, exact: true })
    .click();
  await page
    .getByLabel("系统指令", { exact: true })
    .fill("Keep this draft while adjusting Skills.");

  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "技能", exact: true }).click();
  const overview = page.getByRole("region", { name: "Skills 技能库", exact: true });
  await overview.getByRole("searchbox", { name: "搜索技能" }).fill(name);
  const copies = overview.getByRole("group", { name, exact: true });
  const user = copies.filter({ has: page.locator(".skill-source-pill", { hasText: "全局" }) });
  const scope = copies.filter({ has: page.locator(".skill-source-pill", { hasText: "workspace" }) });
  const prefs = overview.getByRole("switch", {
    name: `为 ${agentName} 启用 ${name}`,
    exact: true,
  });
  await expect(prefs).toHaveCount(2);
  await expect(prefs.first()).toBeChecked();
  await user.getByRole("switch").click();
  await expect(prefs.first()).not.toBeChecked();
  await expect(prefs.last()).not.toBeChecked();
  await overview.getByRole("radio", { name: "已启用", exact: true }).click();
  await expect(
    overview.getByText("没有匹配的技能", { exact: true }),
  ).toBeVisible();
  await overview.getByRole("radio", { name: "已禁用", exact: true }).click();
  await expect(prefs).toHaveCount(2);

  await overview.getByRole("combobox", { name: "选择 Agent" }).click();
  await page.getByRole("option", { name: otherName, exact: true }).click();
  await expect(
    user.getByRole("switch", { name: `为 ${otherName} 启用 ${name}` }),
  ).toBeChecked();
  await expect(scope.getByRole("switch")).toHaveCount(0);
  await expect(
    scope.getByRole("button", { name: `将 ${name} 挂载到 ${otherName}`, exact: true }),
  ).toBeVisible();
  await overview.getByRole("radio", { name: "项目", exact: true }).click();
  await expect(user).toHaveCount(0);
  await scope.getByRole("button", { name: "Overview fixture", exact: true }).click();
  const library = page.getByRole("region", { name: "技能", exact: true });
  await expect(
    library.getByRole("heading", { name: "Overview fixture", exact: true }),
  ).toBeVisible();
  await library
    .locator(".file-bar")
    .getByRole("button", { name: "总览", exact: true })
    .click();
  await expect(overview.getByRole("searchbox")).toHaveValue(name);
  await expect(user).toHaveCount(0);

  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByLabel("系统指令", { exact: true })).toHaveValue(
    "Keep this draft while adjusting Skills.",
  );
  await expect(
    page.getByRole("button", { name: `重新启用 ${name}`, exact: true }),
  ).toBeVisible();
});

test("Profile shows default Skill sources and disables a Skill by name", async ({
  page,
}) => {
  const agentName = "Default Skills Reviewer";
  const suffix = randomUUID().slice(0, 8);
  const userSkill = "default-" + suffix;
  const secondSkill = "secondary-" + suffix;
  const secondRoot = join(context().otherScope, "scope-" + suffix);
  const source = join(secondRoot, ".claude", "skills", secondSkill);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "SKILL.md"),
    "---\nname: " +
      secondSkill +
      "\ndescription: Secondary Scope fixture\n---\n\n# Fixture\n",
  );

  await createAgent(page, agentName);
  const created = await page.request.post("/api/skills", {
    data: { name: userSkill },
  });
  expect(created.ok()).toBeTruthy();
  await page
    .getByRole("button", {
      name: "打开 " + agentName + " 的配置",
      exact: true,
    })
    .click();
  await enterScopePath(
    page,
    page.getByRole("button", { name: "添加目录", exact: true }),
    secondRoot,
  );
  await page
    .getByRole("button", {
      name: "默认技能 · 用户目录和全部工作范围目录",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "用户目录", exact: true }),
  ).toContainText(/data[\\/]skills/);
  const scopeSources = page.getByRole("region", {
    name: "工作范围目录",
    exact: true,
  });
  await expect(scopeSources).toContainText("scope-" + suffix);
  await expect(scopeSources).toContainText(".claude");

  const waitProfileSave = () =>
    page.waitForResponse(
      (response) =>
        /\/api\/agents\/[^/]+$/.test(response.url()) &&
        response.request().method() === "PUT",
    );
  await page.getByRole("button", { name: "禁用技能", exact: true }).click();
  await page.getByRole("combobox", { name: "搜索技能" }).fill(userSkill);
  const disabledSaved = waitProfileSave();
  await page.getByRole("option", { name: userSkill, exact: true }).click();
  const enable = page.getByRole("button", {
    name: "重新启用 " + userSkill,
    exact: true,
  });
  await expect(enable).toBeVisible();
  const disabledResponse = await disabledSaved;
  expect(disabledResponse.ok()).toBeTruthy();
  const agent = (await disabledResponse.json()) as Agent;
  expect(agent.profile.disabledSkills).toEqual([userSkill]);
  const suggestions = async () => {
    const response = await page.request.get(
      "/api/agents/" + agent.id + "/suggestions?kind=skill&provider=codex",
    );
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { name: string }[]).map(
      (skill) => skill.name,
    );
  };
  const enabled = await suggestions();
  expect(enabled).toContain(secondSkill);
  expect(enabled).not.toContain(userSkill);
  const enabledSaved = waitProfileSave();
  await enable.click();
  expect((await enabledSaved).ok()).toBeTruthy();
  expect(await suggestions()).toContain(userSkill);
});

test("file conflict retains the draft until a disk reload succeeds", async ({
  page,
}) => {
  const name = `conflict-${randomUUID()}.txt`;
  const filePath = join(context().scope, name);
  const initial = "original";
  const disk = "edited by another process";
  const draft = "unsaved 中文";
  writeFileSync(filePath, initial);
  try {
    await createAgent(page, "文件保存冲突");
    await page.getByRole("button", { name: "文件", exact: true }).click();
    const item = page.getByRole("treeitem", { name, exact: true });
    await item.click();
    const editor = page.locator(".monaco-editor:visible");
    const lines = editor.locator(".view-lines");
    await expect(lines).toContainText(initial);

    const sent = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route(
      (url) =>
        url.pathname.endsWith("/file") && url.searchParams.get("path") === name,
      async (route) => {
        if (
          route.request().method() !== "PUT" ||
          route.request().postDataJSON().content !== "first edit"
        ) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        sent.resolve();
        await release.promise;
        await route.fulfill({ response });
      },
    );
    await lines.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("first edit");
    try {
      await sent.promise;
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.insertText("second edit");
    } finally {
      release.resolve();
    }
    await expect.poll(() => readFileSync(filePath, "utf8")).toBe("second edit");
    await expect(
      page.getByText("有未保存的修改", { exact: true }),
    ).not.toBeVisible();
    await page.unrouteAll({ behavior: "wait" });

    writeFileSync(filePath, disk);
    await lines.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText(draft);

    const alert = page.getByRole("alert").filter({ hasText: "磁盘文件已修改" });
    await expect(alert).toBeVisible();
    expect(readFileSync(filePath, "utf8")).toBe(disk);

    await page.getByRole("treeitem", { name: "hello.go", exact: true }).click();
    await expect(alert).not.toBeVisible();
    await item.click();
    await expect(alert).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await alert.getByRole("button", { name: "下载草稿" }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`${name}.draft`);
    expect(readFileSync((await download.path())!, "utf8")).toBe(draft);

    await page.setViewportSize({ width: 540, height: 800 });
    await page.emulateMedia({ colorScheme: "dark" });
    const hideAgents = page.getByRole("button", { name: "收起 Agent 列表" });
    if (await hideAgents.isVisible()) await hideAgents.click();
    await expect(alert).toBeVisible();
    await expect(
      alert.getByRole("button", { name: "下载草稿" }),
    ).toBeInViewport();
    await expect(
      alert.getByRole("button", { name: "重新载入磁盘版本" }),
    ).toBeInViewport();
    const confirmReload = async () => {
      await alert.getByRole("button", { name: "重新载入磁盘版本" }).click();
      await page.getByRole("button", { name: "丢弃并重新加载" }).click();
    };
    rmSync(filePath);
    await confirmReload();
    await expect(page.getByText("无法重新载入，草稿已保留。")).toBeVisible();
    await expect(lines).toContainText(draft);

    writeFileSync(filePath, disk);
    await confirmReload();
    await expect(alert).not.toBeVisible();
    await expect(lines).toContainText(disk);
    expect(readFileSync(filePath, "utf8")).toBe(disk);
  } finally {
    rmSync(filePath, { force: true });
  }
});

test("sidebar Topics keep their Chat position across prepend pagination, fresh mount, and same-pane collisions", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await createAgent(page, "话题定位稳定性");
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const agent = overview.agents.find(({ name }) => name === "话题定位稳定性")!;
  const chatResponse = await page.request.post("/api/chats", {
    data: { agentId: agent.id, title: "长历史对话" },
  });
  expect(chatResponse.ok()).toBe(true);
  const chat: { id: string } = await chatResponse.json();

  const postAndWait = async (
    operation: "main" | "topic",
    text: string,
  ): Promise<Run> => {
    const response = await page.request.post("/api/messages", {
      data: { chatId: chat.id, commandId: randomUUID(), operation, text },
    });
    expect(response.ok()).toBe(true);
    const run = (await response.json()) as Run;
    await expect
      .poll(
        async () => {
          const runs = (
            await (
              await page.request.get(`/api/sessions/${run.sessionId}/runs`)
            ).json()
          ).runs as Run[];
          return runs.find((item) => item.id === run.id)?.status;
        },
        { intervals: [50, 100] },
      )
      .toBe("completed");
    return run;
  };

  const tall = Array.from(
    { length: 16 },
    (_, i) => `段落 ${i + 1}：用于拉高聊天记录高度以验证滚动定位。`,
  ).join("\n\n");
  await postAndWait("main", `消息 0\n\n${tall}`);
  const oldTopic = await postAndWait("topic", "很早的话题 T1");
  for (let i = 2; i <= 10; i++) {
    await postAndWait("main", `消息 ${i}\n\n${tall}`);
  }
  // Lands at the top of the 12-item first page, triggering onLoadEarlier when scrolled to.
  const midTopic = await postAndWait("topic", "首屏顶部话题 T2");
  for (let i = 12; i <= 22; i++) {
    await postAndWait("main", `消息 ${i}\n\n${tall}`);
  }

  await page.reload();
  const sidebar = page.locator("#agent-sidebar");
  const mainStrip = page.locator('.tab-strip[data-pane="main"]');
  const sideStrip = page.locator('.tab-strip[data-pane="side"]');
  const mainPanel = page.locator('.tab-panel[data-pane="main"][data-visible="true"]');
  const mainTopic = (sessionId: string) =>
    mainPanel.locator(`.topic-thread[data-session-id="${sessionId}"]`);

  // 1. Clicking midTopic while Chat is open in single-pane view triggers split animation
  // and onLoadEarlier prepend; left pane must stay aligned to midTopic.
  await sidebar.locator(`[data-session-id="${midTopic.sessionId}"]`).click();
  await expect(
    sideStrip.getByRole("tab", { name: "首屏顶部话题 T2", selected: true }),
  ).toBeVisible();
  await expect(mainTopic(midTopic.sessionId)).toBeInViewport();
  await page.waitForTimeout(550);
  await expect(mainTopic(midTopic.sessionId)).toBeInViewport();

  // 2. Clicking an older Topic from page 2 scrolls to it in the left pane.
  await sidebar.locator(`[data-session-id="${oldTopic.sessionId}"]`).click();
  await expect(mainTopic(oldTopic.sessionId)).toBeInViewport();

  // 3. After manually scrolling away, clicking the same Topic again re-locates it.
  await mainPanel.locator(".chat-scroll").evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    el.scrollTop = el.scrollHeight;
  });
  await expect(mainTopic(oldTopic.sessionId)).not.toBeInViewport();
  await sidebar.locator(`[data-session-id="${oldTopic.sessionId}"]`).click();
  await expect(mainTopic(oldTopic.sessionId)).toBeInViewport();

  // 4. Opening a Topic from an empty workspace mounts Chat fresh without scrollToEnd overriding reveal.
  await page.evaluate((agentId) => {
    const saved = JSON.parse(localStorage.getItem("lever:workspaces") || "{}");
    saved[agentId] = { tabs: [], selected: "" };
    localStorage.setItem("lever:workspaces", JSON.stringify(saved));
  }, agent.id);
  await page.reload();
  await sidebar.locator(`[data-session-id="${midTopic.sessionId}"]`).click();
  await expect(
    mainStrip.getByRole("tab", { name: "长历史对话", selected: true }),
  ).toBeVisible();
  await expect(mainTopic(midTopic.sessionId)).toBeInViewport();
  await page.waitForTimeout(550);
  await expect(mainTopic(midTopic.sessionId)).toBeInViewport();

  // 5. Right-click "在新标签页打开" also keeps the Topic tab and locates it in Chat.
  await closeTab(sideStrip.getByRole("tab", { name: "首屏顶部话题 T2" }));
  await mainPanel.locator(".chat-scroll").evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    el.scrollTop = el.scrollHeight;
  });
  await expect(mainTopic(midTopic.sessionId)).not.toBeInViewport();
  await sidebar
    .locator(`[data-session-id="${midTopic.sessionId}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "在新标签页打开", exact: true }).click();
  const keptTopicTab = sideStrip.getByRole("tab", {
    name: "首屏顶部话题 T2",
    selected: true,
  });
  await expect(keptTopicTab).toBeVisible();
  await expect(keptTopicTab).not.toHaveAttribute("aria-description");
  await expect(mainTopic(midTopic.sessionId)).toBeInViewport();

  // 6. If Chat and Topic collide in the same pane, clicking the Topic separates them and locates it.
  await mainStrip
    .getByRole("tab", { name: "长历史对话", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "移动到右侧面板", exact: true }).click();
  await expect(mainStrip.getByRole("tab")).toHaveCount(0);
  await sidebar.locator(`[data-session-id="${midTopic.sessionId}"]`).click();
  await expect(
    mainStrip.getByRole("tab", { name: "长历史对话", selected: true }),
  ).toBeVisible();
  await expect(
    sideStrip.getByRole("tab", { name: "首屏顶部话题 T2", selected: true }),
  ).toBeVisible();
  await expect(mainTopic(midTopic.sessionId)).toBeInViewport();
});

test("sidebar Chats fill main instead of side and side Topic details open opposite", async ({
  page,
}) => {
  await createAgent(page, "分栏归属规则");
  await send(page, "对话 A 首条消息");
  const overview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const agent = overview.agents.find(({ name }) => name === "分栏归属规则")!;
  const chatA = overview.chats.find(({ agentId }) => agentId === agent.id)!;
  const chatBResponse = await page.request.post("/api/chats", {
    data: { agentId: agent.id, title: "对话 B" },
  });
  expect(chatBResponse.ok()).toBe(true);
  const chatB: { id: string } = await chatBResponse.json();
  const chatBRunResponse = await page.request.post("/api/messages", {
    data: {
      chatId: chatB.id,
      commandId: randomUUID(),
      operation: "main",
      text: "对话 B 内容",
    },
  });
  expect(chatBRunResponse.ok()).toBe(true);
  const topicResponse = await page.request.post("/api/messages", {
    data: {
      chatId: chatA.id,
      commandId: randomUUID(),
      operation: "topic",
      text: "右侧话题查看 [hello.go](hello.go:3)",
    },
  });
  expect(topicResponse.ok()).toBe(true);
  const topicRun = (await topicResponse.json()) as Run;
  await expect
    .poll(
      async () => {
        const runs = (
          await (
            await page.request.get(`/api/sessions/${topicRun.sessionId}/runs`)
          ).json()
        ).runs as Run[];
        return runs.find((item) => item.id === topicRun.id)?.status;
      },
      { intervals: [50, 100] },
    )
    .toBe("completed");

  const updatedOverview: Overview = await (
    await page.request.get("/api/overview")
  ).json();
  const mainConvA = updatedOverview.conversations.find(
    (item) => item.chatId === chatA.id && item.kind === "main",
  )!;
  const mainConvB = updatedOverview.conversations.find(
    (item) => item.chatId === chatB.id && item.kind === "main",
  )!;

  const sidebar = page.locator("#agent-sidebar");
  const mainStrip = page.locator('.tab-strip[data-pane="main"]');
  const sideStrip = page.locator('.tab-strip[data-pane="side"]');
  const sidePanel = page.locator('.tab-panel[data-pane="side"][data-visible="true"]');

  // Open Topic in side, then close main tab so the left pane is empty while side is active.
  await sidebar.locator(`[data-session-id="${topicRun.sessionId}"]`).click();
  await expect(sideStrip.getByRole("tab")).toHaveCount(1);
  await closeTab(mainStrip.getByRole("tab").first());
  await expect(mainStrip.getByRole("tab")).toHaveCount(0);

  // 1. Clicking Chat A in Agents sidebar when left pane is empty must open in main, not side.
  await sidebar.locator(`[data-session-id="${mainConvA.id}"]`).click();
  await expect(
    mainStrip.locator(`[role="tab"][id="tab-${encodeURIComponent(chatA.id)}"]`),
  ).toHaveAttribute("aria-selected", "true");
  await expect(sideStrip.getByRole("tab")).toHaveCount(1);

  // 2. When both panes are non-empty and side pane is active, clicking Chat B still opens in main.
  await sideStrip.getByRole("tab").first().click();
  await sidebar.locator(`[data-session-id="${mainConvB.id}"]`).click();
  await expect(
    mainStrip.getByRole("tab", { name: "对话 B", selected: true }),
  ).toBeVisible();
  await expect(sideStrip.getByRole("tab")).toHaveCount(1);

  // 3. Clicking a Markdown file link inside the side Topic opens Files in the opposite (main) pane.
  await sidePanel.getByRole("link", { name: "hello.go", exact: true }).click();
  await expect(
    mainStrip.getByRole("tab", { name: "hello.go", selected: true }),
  ).toBeVisible();
  await expect(sidePanel.locator(".topic-conversation")).toBeVisible();

  // 4. When left pane is empty again, Agent sidebar Files action fills main instead of side.
  await mainStrip.getByRole("tab").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "关闭所有标签页", exact: true }).click();
  await expect(mainStrip.getByRole("tab")).toHaveCount(0);
  await sidebar
    .locator(`[data-agent-id="${agent.id}"]`)
    .getByRole("button", { name: `打开 ${agent.name} 的文件`, exact: true })
    .click();
  await expect(
    mainStrip.getByRole("tab", { name: "文件", selected: true }),
  ).toBeVisible();
  await expect(sideStrip.getByRole("tab")).toHaveCount(1);
});

test("per-pane tab limit applies independently per Agent and pane and evicts earliest-left tabs", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(context().url);
  const { scope } = context();

  const createApiAgent = async (name: string) => {
    const response = await page.request.post("/api/agents", {
      data: {
        name,
        profile: {
          provider: "codex",
          roots: [{ id: "root", path: scope }],
          primaryRootId: "root",
          permission: "ask",
          instructions: "",
          skills: [],
          delegations: [],
        },
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as Agent;
  };
  const createApiChat = async (agentId: string, title: string) => {
    const response = await page.request.post("/api/chats", {
      data: { agentId, title },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as ChatView["chat"];
  };
  const sendApiMessage = async (chatId: string, text: string) => {
    const response = await page.request.post("/api/messages", {
      data: { chatId, commandId: randomUUID(), operation: "main", text },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as Run;
  };

  const agentA = await createApiAgent("分栏上限 A");
  const agentB = await createApiAgent("分栏上限 B");
  const chatA1 = await createApiChat(agentA.id, "左栏对话 1");
  const chatA2 = await createApiChat(agentA.id, "左栏对话 2");
  const chatA3 = await createApiChat(agentA.id, "左栏对话 3");
  const chatB1 = await createApiChat(agentB.id, "AgentB 对话 1");
  const chatB2 = await createApiChat(agentB.id, "AgentB 对话 2");
  await sendApiMessage(chatA1.id, "A1 初始消息");
  await sendApiMessage(chatA2.id, "A2 初始消息");
  await sendApiMessage(chatA3.id, "A3 初始消息");
  await sendApiMessage(chatB1.id, "B1 初始消息");
  await sendApiMessage(chatB2.id, "B2 初始消息");

  await page.reload();
  const sidebar = page.locator("#agent-sidebar");
  const mainStrip = page.locator('.tab-strip[data-pane="main"]');
  const sideStrip = page.locator('.tab-strip[data-pane="side"]');

  // Set per-pane tab limit to 2 in Settings.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const limitInput = page.getByLabel("单分栏标签页上限", { exact: true });
  await limitInput.fill("2");
  await limitInput.press("Enter");
  await page.getByRole("button", { name: "Agents", exact: true }).click();

  const openKeptInMain = async (chatId: string) => {
    const overview: Overview = await (
      await page.request.get("/api/overview")
    ).json();
    const conv = overview.conversations.find(
      (item) => item.chatId === chatId && item.kind === "main",
    )!;
    const row = sidebar.locator(`[data-session-id="${conv.id}"]`);
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "在新标签页打开", exact: true })
      .or(page.getByRole("menuitem", { name: "保留标签页", exact: true }))
      .click();
  };

  // Agent A: open 2 tabs in main (chatA1, chatA2), then revisit chatA1 so chatA2 is left earlier.
  await sidebar
    .locator(`[data-agent-id="${agentA.id}"] .agent-select`)
    .click();
  await openKeptInMain(chatA1.id);
  await openKeptInMain(chatA2.id);
  await expect(mainStrip.getByRole("tab")).toHaveCount(2);
  await mainStrip.getByRole("tab", { name: "左栏对话 1", exact: true }).click();

  // Open 3 tool tabs in Agent A's right pane: right pane trims to 2, left pane keeps BOTH tabs!
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "文件", exact: true }).click();
  await sideStrip.getByRole("button", { name: "打开标签", exact: true }).click();
  await page.getByRole("menuitem", { name: "笔记", exact: true }).click();
  await sideStrip.getByRole("button", { name: "打开标签", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置", exact: true }).click();
  await expect(sideStrip.getByRole("tab")).toHaveCount(2);
  await expect(
    sideStrip.getByRole("tab", { name: "文件", exact: true }),
  ).toHaveCount(0);
  await expect(
    sideStrip.getByRole("tab", { name: "笔记", exact: true }),
  ).toBeVisible();
  await expect(
    sideStrip.getByRole("tab", { name: "配置", exact: true }),
  ).toBeVisible();
  await expect(mainStrip.getByRole("tab")).toHaveCount(2);
  await expect(
    mainStrip.getByRole("tab", { name: "左栏对话 1", exact: true }),
  ).toBeVisible();
  await expect(
    mainStrip.getByRole("tab", { name: "左栏对话 2", exact: true }),
  ).toBeVisible();

  // Switch to Agent B and open 2 main tabs + 2 side tabs: Agent A's tabs must NOT be closed.
  await sidebar
    .locator(`[data-agent-id="${agentB.id}"] .agent-select`)
    .click();
  await openKeptInMain(chatB1.id);
  await openKeptInMain(chatB2.id);
  await page.getByRole("button", { name: "展开侧边分栏", exact: true }).click();
  await page.getByRole("menuitem", { name: "文件", exact: true }).click();
  await sideStrip.getByRole("button", { name: "打开标签", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置", exact: true }).click();
  await expect(mainStrip.getByRole("tab")).toHaveCount(2);
  await expect(sideStrip.getByRole("tab")).toHaveCount(2);

  // Switch back to Agent A: both panes still retain their 2 tabs.
  await sidebar
    .locator(`[data-agent-id="${agentA.id}"] .agent-select`)
    .click();
  await expect(mainStrip.getByRole("tab")).toHaveCount(2);
  await expect(sideStrip.getByRole("tab")).toHaveCount(2);

  // Send a brand-new message to inactive chatA2: new message activity must NOT prevent chatA2
  // (which was left earlier than chatA1) from being evicted when opening chatA3.
  const run = await sendApiMessage(chatA2.id, "后台新消息");
  await expect
    .poll(async () => {
      const runs = (
        await (
          await page.request.get(`/api/sessions/${run.sessionId}/runs`)
        ).json()
      ).runs as Run[];
      return runs.find((item) => item.id === run.id)?.status;
    })
    .toBe("completed");

  await openKeptInMain(chatA3.id);
  await expect(mainStrip.getByRole("tab")).toHaveCount(2);
  await expect(
    mainStrip.getByRole("tab", { name: "左栏对话 2", exact: true }),
  ).toHaveCount(0);
  await expect(
    mainStrip.getByRole("tab", { name: "左栏对话 1", exact: true }),
  ).toBeVisible();
  await expect(
    mainStrip.getByRole("tab", { name: "左栏对话 3", exact: true }),
  ).toBeVisible();
  // Right pane still untouched.
  await expect(sideStrip.getByRole("tab")).toHaveCount(2);
});

test("starter Lever Agent shows Lever logo and Agents support custom image avatars", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(context().url);

  const sidebar = page.locator("#agent-sidebar");
  const leverRow = sidebar.locator(".agent-contact").filter({
    has: page.getByRole("button", { name: "Lever", exact: true }),
  });
  await expect(leverRow).toHaveCount(1);
  const leverSidebarImg = leverRow.locator(".agent-avatar img");
  await expect(leverSidebarImg).toBeVisible();
  await expect
    .poll(() => leverSidebarImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  // Open the starter Lever Agent's Profile and inspect its AvatarPicker.
  await leverRow
    .getByRole("button", { name: "打开 Lever 的配置", exact: true })
    .click();
  const profileAvatar = page.locator(".profile-avatar-trigger .agent-avatar img");
  await expect(profileAvatar).toBeVisible();
  await expect
    .poll(() => profileAvatar.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "选择头像", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "选择头像", exact: true });
  await expect(picker.getByRole("tab", { name: "图片", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    picker.getByRole("button", { name: /更换图片/ }),
  ).toBeVisible();
  await expect(
    picker.getByRole("group", { name: "头像背景", exact: true }),
  ).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("lever-logo-picker-light.png"),
    animations: "disabled",
  });

  // Check Dark theme rendering of starter logo & picker.
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: testInfo.outputPath("lever-logo-picker-dark.png"),
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.keyboard.press("Escape");

  // Create a new Agent with a custom uploaded image avatar.
  const pngA = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGN4GOb9nxLMMGrAqAGjBgwXAwAw2oEfMM9KGgAAAABJRU5ErkJggg==",
    "base64",
  );
  const pngB = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGMwKXvwnxLMMGrAqAGjBgwXAwAzu4kfmQACHQAAAABJRU5ErkJggg==",
    "base64",
  );

  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "创建 Agent", exact: true });
  const agentName = `Custom Avatar ${randomUUID().slice(0, 6)}`;
  await dialog.getByLabel("名称", { exact: true }).fill(agentName);
  await dialog.getByRole("button", { name: "选择头像", exact: true }).click();
  const createPicker = page.getByRole("dialog", {
    name: "选择头像",
    exact: true,
  });
  await createPicker.getByRole("tab", { name: "图片", exact: true }).click();

  // Reject a non-image file with an inline alert.
  const createFileInput = createPicker.locator('input[type="file"]');
  await createFileInput.setInputFiles({
    name: "not-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(createPicker.getByRole("alert")).toContainText("有效的图片");

  // Upload a valid PNG image during Agent creation.
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/avatars") &&
      response.request().method() === "POST",
  );
  await createFileInput.setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: pngA,
  });
  expect((await uploadResponse).ok()).toBeTruthy();
  await expect(createPicker.getByRole("alert")).toHaveCount(0);
  await expect(createPicker.locator(".avatar-upload-zone img")).toBeVisible();
  await page.keyboard.press("Escape");

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "创建 Agent", exact: true }).click();
  const created = (await (await createdResponse).json()) as Agent;
  expect(created.avatar?.kind).toBe("image");
  expect(created.avatar?.value).toMatch(/^[a-f0-9]{64}$/);
  expect(created.avatar?.color ?? "").toBe("");

  const customRow = sidebar.locator(`[data-agent-id="${created.id}"]`);
  const customSidebarImg = customRow.locator(".agent-avatar img");
  await expect(customSidebarImg).toHaveAttribute(
    "src",
    `/api/avatars/${created.avatar!.value}`,
  );
  await expect
    .poll(() =>
      customSidebarImg.evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBe(16);

  // Replace the custom image in Profile and verify persistence after reload.
  await customRow
    .getByRole("button", { name: `打开 ${agentName} 的配置`, exact: true })
    .click();
  await page.getByRole("button", { name: "选择头像", exact: true }).click();
  const editPicker = page.getByRole("dialog", { name: "选择头像", exact: true });
  await expect(
    editPicker.getByRole("tab", { name: "图片", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const savedEdit = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/agents/${created.id}`) &&
      response.request().method() === "PUT",
  );
  await editPicker.locator('input[type="file"]').setInputFiles({
    name: "blue.png",
    mimeType: "image/png",
    buffer: pngB,
  });
  const edited = (await (await savedEdit).json()) as Agent;
  expect(edited.avatar?.kind).toBe("image");
  expect(edited.avatar?.value).not.toBe(created.avatar?.value);

  await page.reload();
  const reloadedImg = sidebar.locator(
    `[data-agent-id="${created.id}"] .agent-avatar img`,
  );
  await expect(reloadedImg).toHaveAttribute(
    "src",
    `/api/avatars/${edited.avatar!.value}`,
  );
  await expect
    .poll(() => reloadedImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBe(16);

  // Duplicating an Agent with a custom image avatar preserves its avatar.
  await sidebar
    .getByRole("button", { name: agentName, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制 Agent…" }).click();
  const copyDialog = page.getByRole("dialog", { name: "复制 Agent", exact: true });
  const copiedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST",
  );
  await copyDialog.getByRole("button", { name: "创建副本", exact: true }).click();
  const copied = (await (await copiedResponse).json()) as Agent;
  expect(copied.avatar).toEqual(edited.avatar);

  // Verify English tab labels fit inside the popover without horizontal overflow.
  await page.evaluate(() => localStorage.setItem("lever:language", "en-US"));
  await page.reload();
  await sidebar
    .locator(`[data-agent-id="${created.id}"] .agent-profile-trigger`)
    .click();
  await page.getByRole("button", { name: "Choose avatar", exact: true }).click();
  const enPicker = page.getByRole("dialog", {
    name: "Choose avatar",
    exact: true,
  });
  await expect(
    enPicker.getByRole("tab", { name: "Image", exact: true }),
  ).toBeVisible();
  expect(
    await enPicker
      .getByRole("tablist", { name: "Avatar type", exact: true })
      .evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("custom-avatar-picker-en.png"),
    animations: "disabled",
  });
});
