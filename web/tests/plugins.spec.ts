import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function openPlugins(page: Page) {
  const { url } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  );
  await page.goto(url);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  return page.getByRole("main", { name: "插件" });
}

test("plugin groups share card columns at every panel width and after a search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 780 });
  const plugins = await openPlugins(page);
  const cards = plugins.locator(".plugins-library .plugin-card");
  await expect(cards.first()).toBeVisible();
  const checkIcons = async (selector: string, size: number) => {
    const buttons = plugins.locator(selector);
    const icons = buttons.locator(
      ":scope > :is(svg, img, .plugin-github-icon)",
    );
    await expect(icons).toHaveCount(await buttons.count());
    expect(
      await icons.evaluateAll(
        (items, px) =>
          items.every((item) => {
            const { width, height } = item.getBoundingClientRect();
            return (
              width === px &&
              height === px &&
              (!(item instanceof HTMLImageElement) || item.naturalWidth > 0)
            );
          }),
        size,
      ),
    ).toBe(true);
  };
  await checkIcons(".plugin-card-mark", 18);
  await expect(plugins.locator(".plugin-card-mark").first()).toHaveCSS("width", "32px");
  await expect(plugins.locator(".plugin-signal-label")).toHaveCount(await cards.count());
  await checkIcons("#plugin-index-groups .sidebar-nav-item", 16);
  const geometry = () =>
    cards.evaluateAll((elements) => {
      const boxes = elements.map((element) => element.getBoundingClientRect());
      const firstRow = boxes.filter(
        (box) => Math.abs(box.top - boxes[0].top) < 1,
      );
      return {
        columns: firstRow.length,
        aligned: boxes.every((box) =>
          firstRow.some(
            (track) =>
              Math.abs(track.left - box.left) < 1 &&
              Math.abs(track.right - box.right) < 1,
          ),
        ),
        firstWidth: firstRow[0]?.width,
      };
    });
  await expect.poll(geometry).toMatchObject({ columns: 3, aligned: true });
  const groupEdges = await plugins.locator(".plugins-library .plugins-group").evaluateAll((groups) => groups.map((group) => {
    const { top, bottom } = group.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(groupEdges.every((edge, index) => !index || edge.top > groupEdges[index - 1].bottom)).toBe(true);
  const full = await geometry();
  const search = plugins.getByRole("searchbox");
  await search.fill("lever.imap-mail");
  await expect(cards).toHaveCount(1);
  expect((await geometry()).firstWidth).toBeCloseTo(full.firstWidth, 0);
  await search.fill("");

  await plugins.getByRole("button", { name: "收起二级菜单" }).click();
  for (const [width, columns] of [
    [625, 2],
    [390, 1],
  ]) {
    await page.setViewportSize({ width, height: 780 });
    await expect.poll(geometry).toMatchObject({ columns, aligned: true });
  }
});

test("a runtime plugin opens its connections and can add another native account", async ({
  page,
}) => {
  const plugins = await openPlugins(page);
  const card = plugins.getByRole("group", { name: "Codex", exact: true });
  await card.getByRole("button").click();
  await plugins.getByRole("button", { name: "管理连接" }).click();
  const connections = page.getByRole("navigation", { name: "我的连接" });
  const details = page.getByRole("region", { name: "运行时详情" });
  await expect(connections.getByRole("button", { name: /Claude/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "添加运行时", exact: true }).click();
  await details.getByRole("button", { name: /^Codex/ }).click();
  await expect(
    details.getByRole("heading", { name: "添加 Codex" }),
  ).toBeVisible();
  await details.getByLabel("连接名称").fill("工作");
  await details.getByRole("button", { name: "添加并登录" }).click();
  const login = page.getByRole("dialog", { name: "登录 工作" });
  await expect(login).toBeVisible();
  await expect(login.locator(".xterm")).toBeVisible();
  const closed = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      /\/api\/providers\/[^/]+\/terminal\//.test(response.url()),
  );
  await login.getByRole("button", { name: "关闭" }).click();
  expect((await closed).ok()).toBe(true);
  await expect(
    connections.getByRole("button", { name: /Codex · 工作/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    connections.getByRole("button", { name: /Codex · 本机默认/ }),
  ).toBeVisible();
  await connections.getByRole("button", { name: "查看全部连接" }).click();
  await expect(
    connections.getByRole("button", { name: /Claude Code/ }),
  ).toBeVisible();
  const mainNav = page.getByRole("navigation", { name: "主导航" });
  await mainNav.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByRole("button", { name: "打开 Lever 的配置", exact: true })
    .click();
  await page.getByRole("combobox", { name: "运行时", exact: true }).click();
  await expect(
    page.getByRole("option", { name: "Codex · 工作" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Codex · 本机默认" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "打开 Lever 的对话", exact: true })
    .click();
  const pickerButton = page.getByRole("button", {
    name: "选择模型和运行时",
    exact: true,
  });
  await pickerButton.click();
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  await expect(
    picker.getByRole("radio", { name: "Codex · 本机默认" }),
  ).toHaveText("Codex · 本机默认");
  await expect(picker.getByRole("radio", { name: "Codex · 工作" })).toHaveText(
    "Codex · 工作",
  );
  await page.keyboard.press("Escape");
  await mainNav.getByRole("button", { name: "插件", exact: true }).click();
  await expect(card).toContainText("2 个连接");
  await card.getByRole("button").click();
  await plugins.getByRole("button", { name: "管理连接" }).click();
  await connections.getByRole("button", { name: /Codex · 工作/ }).click();
  const configuration = details.getByRole("region", {
    name: "配置",
    exact: true,
  });
  await expect(configuration.getByLabel("可执行文件")).toBeVisible();
  await expect(
    configuration.getByLabel("配置目录", { exact: true }),
  ).toBeVisible();
  const connectionNameInput = configuration.getByLabel("连接名称");
  await connectionNameInput.fill("工作账户");
  await expect(
    details.getByRole("button", { name: "保存", exact: true }),
  ).toHaveCount(0);
  await expect(
    connections.getByRole("button", { name: /Codex · 工作账户/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(connectionNameInput).toBeFocused();
  // Changing launch identity switches to explicit Save as new connection (no auto-save).
  const executableInput = configuration.getByLabel("可执行文件");
  const originalExecutable = await executableInput.inputValue();
  await executableInput.fill("/custom/codex-bin");
  await expect(
    details.getByRole("button", { name: "另存为新连接", exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "取消", exact: true }).click();
  await expect(executableInput).toHaveValue(originalExecutable);
  await expect(
    details.getByRole("button", { name: "另存为新连接", exact: true }),
  ).toHaveCount(0);
  await details.getByRole("button", { name: "移除", exact: true }).click();
  await details.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(
    connections.getByRole("button", { name: /Codex · 工作/ }),
  ).toHaveCount(0);
  await expect(
    connections.getByRole("button", { name: /Codex/ }),
  ).toBeVisible();
});

test("runtime settings show detected instances, explicit types, and compact back navigation", async ({
  page,
}) => {
  const { url } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  );
  await page.goto(url);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "运行时", exact: true })
    .click();

  const panel = page.getByRole("region", { name: "运行时", exact: true });
  const details = page.getByRole("region", { name: "运行时详情" });
  const connected = panel.getByRole("region", { name: "已接入" });
  const available = panel.getByRole("region", { name: "可接入" });
  await expect(connected.getByRole("button")).toHaveCount(5);
  await expect(available.getByRole("button", { name: /^ACP/ })).toBeVisible();
  await expect(
    details.getByRole("heading", { name: "Codex", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("switch", { name: /在模型选择器显示/ }).first(),
  ).toBeChecked();

  await panel.getByRole("button", { name: "添加运行时" }).click();
  await expect(details.getByText("未安装")).toHaveCount(0);
  for (const name of [
    "Codex",
    "Claude Code",
    "Antigravity",
    "Pi",
    "DeepSeek Harness",
    "ACP",
  ]) {
    await expect(
      details.getByRole("button", { name: new RegExp(`^${name} `) }),
    ).toBeVisible();
  }
  await details.getByRole("button", { name: /^ACP / }).click();
  await expect(
    details.getByRole("heading", { name: "添加 ACP" }),
  ).toBeVisible();
  await expect(
    details.getByRole("textbox", { name: "可执行文件" }),
  ).toBeVisible();
  await details.getByRole("button", { name: "取消" }).click();

  await page.setViewportSize({ width: 390, height: 780 });
  const sidebarToggle = page.getByRole("button", { name: "收起二级菜单" });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  const pi = connected.getByRole("button", { name: /^Pi / });
  await pi.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await expect(
    details.getByRole("heading", { name: "Pi", exact: true }),
  ).toBeVisible();
  const back = details.getByRole("button", { name: "运行时", exact: true });
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(details).toBeHidden();
  await expect(pi).toBeFocused();
});

test("local agy confirms a fresh model probe after the login terminal exits", async ({
  page,
}) => {
  const probe = Promise.withResolvers<void>();
  let refreshes = 0;
  await page.route("**/api/providers/antigravity/models?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("refresh") !== "true" || ++refreshes > 1) {
      await route.continue();
      return;
    }
    await probe.promise;
    await route.fulfill({
      status: 409,
      json: {
        code: "antigravity_cli_auth_required",
        error: "Authentication required",
      },
    });
  });
  const plugins = await openPlugins(page);
  await plugins
    .getByRole("group", { name: "Antigravity", exact: true })
    .getByRole("button")
    .click();
  await plugins.getByRole("button", { name: "管理连接" }).click();
  const details = page.getByRole("region", { name: "运行时详情" });
  const login = page.getByRole("dialog", { name: "登录 Antigravity" });
  async function openLogin() {
    await details
      .getByRole("button", { name: /^(打开登录终端|登录)$/ })
      .click();
    await expect(login.locator(".xterm-rows")).toContainText(
      "Paste the fixture agy login code:",
    );
  }
  async function submit(code: string) {
    await login.getByRole("textbox", { name: "终端输入" }).focus();
    await page.keyboard.type(code);
    await page.keyboard.press("Enter");
  }
  async function closeLogin() {
    await login.getByRole("button", { name: "关闭" }).click();
    await expect(login).toBeHidden();
  }

  await openLogin();
  const concurrent = await page.request.post(
    "/api/providers/antigravity/terminal/duplicate-login",
    { data: {} },
  );
  expect(concurrent.status()).toBe(409);
  await submit("invalid");
  await expect(login.getByRole("alert")).toContainText("agy 登录未完成");
  expect(refreshes).toBe(0);
  await closeLogin();

  await openLogin();
  await submit("fixture");
  try {
    await expect(login.getByText("正在验证登录和模型访问…")).toBeVisible();
    await expect(login.getByText("Google 登录和模型访问已验证。")).toHaveCount(
      0,
    );
  } finally {
    probe.resolve();
  }
  await expect(login.getByRole("alert")).toContainText(
    "新的 agy 进程仍未读到登录凭据",
  );
  await closeLogin();
  await expect(details.getByText("待登录", { exact: true })).toBeVisible();

  await openLogin();
  await submit("fixture");
  await expect(login.getByText("Google 登录和模型访问已验证。")).toBeVisible();
  expect(refreshes).toBe(2);
  await closeLogin();
  await expect(details.getByText("已就绪", { exact: true })).toBeVisible();
});

test("a managed Antigravity account takes its initial API key in the inline form", async ({
  page,
}) => {
  const plugins = await openPlugins(page);
  await plugins
    .getByRole("group", { name: "Antigravity", exact: true })
    .getByRole("button")
    .click();
  await plugins.getByRole("button", { name: "管理连接" }).click();
  await page.getByRole("button", { name: "添加运行时", exact: true }).click();
  const details = page.getByRole("region", { name: "运行时详情" });
  await details.getByRole("button", { name: /^Antigravity/ }).click();
  await details.getByLabel("连接名称").fill("密钥账号");
  await details.getByText("指定程序", { exact: true }).click();
  await details
    .getByLabel("可执行文件", { exact: true })
    .fill("/fixture/agy_acp_server");
  await details.getByText("Gemini API 密钥", { exact: true }).click();
  const key = details.getByLabel("API 密钥", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("fixture-gemini-key");
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/api/providers"),
  );
  await details.getByRole("button", { name: "保存并检测" }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const connection = await response.json();
  expect(connection).not.toHaveProperty("apiKey");
  await expect(details.getByPlaceholder("••••••••")).toHaveValue("");
  await details
    .getByRole("button", { name: "移除", exact: true })
    .last()
    .click();
  await details.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "我的连接" }).getByText("密钥账号"),
  ).toHaveCount(0);
});

test("an older backend keeps connected providers visible and explains missing agy usage", async ({
  page,
}) => {
  await page.route("**/api/provider-candidates", (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "404 page not found\n",
    }),
  );
  await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const rows = await response.json();
    for (const row of rows)
      if (row.type === "antigravity") delete row.reportsUsage;
    await route.fulfill({ response, json: rows });
  });
  const main = await openPlugins(page);
  await main
    .getByRole("group", { name: "Codex", exact: true })
    .getByRole("button")
    .click();
  await main.getByRole("button", { name: "管理连接" }).click();
  await expect(page.getByText(/当前 Lever 后端尚不支持自动发现/)).toBeVisible();
  await expect(page.getByText("404 page not found")).toHaveCount(0);
  const detected = page.getByRole("region", { name: "已接入" });
  await expect(
    detected.getByRole("button", { name: /Codex/ }).first(),
  ).toBeVisible();
  const usage = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "订阅用量" });
  await usage.hover();
  const detail = page.getByRole("tooltip");
  await expect(detail.getByText("Antigravity", { exact: true })).toBeVisible();
  await expect(detail.getByText(/当前后端无法读取 agy 用量/)).toBeVisible();
});

test("plugin index switches between groups and restores the overview search, position and focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 430 });
  const plugins = await openPlugins(page);
  const nav = plugins.getByRole("navigation", { name: "插件" });
  const library = plugins.getByRole("region", {
    name: "插件总览",
    exact: true,
  });
  const search = nav.getByRole("searchbox");
  for (const group of ["Agent 运行时", "任务来源", "消息渠道", "事件源"]) {
    await expect(
      nav.getByRole("heading", { name: group, exact: true }),
    ).toBeVisible();
    await expect(
      library.getByRole("heading", { name: group, exact: true }),
    ).toBeVisible();
  }
  await search.fill("lever.");
  const mail = library.getByRole("group", { name: "IMAP 邮件", exact: true });
  await mail.scrollIntoViewIfNeeded();
  const scroll = plugins.locator(".plugins-scroll");
  const top = await scroll.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await mail.click({ position: { x: 16, y: 34 } });
  await expect(
    plugins.getByRole("heading", { name: "IMAP 邮件", exact: true }),
  ).toBeFocused();
  await nav.getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(
    plugins.getByRole("heading", {
      level: 2,
      name: "Claude Code",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await search.fill("feishu");
  await expect(nav.getByRole("region")).toHaveCount(1);
  await expect(
    plugins.getByRole("heading", {
      level: 2,
      name: "Claude Code",
      exact: true,
    }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(
    nav.getByRole("button", { name: "飞书机器人", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "全部插件总览", exact: true }).click();
  await expect(search).toHaveValue("lever.");
  await expect(mail.getByRole("button")).toBeFocused();
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(top);
});

test("compact plugin index supports keyboard selection and the card switch operates in place", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const plugins = await openPlugins(page);
  const nav = plugins.getByRole("navigation", { name: "插件" });
  const toggle = plugins.getByRole("button", { name: "展开二级菜单" });
  await toggle.click();
  const search = nav.getByRole("searchbox");
  await expect(search).toBeFocused();
  await search.fill("Lark");
  await search.press("ArrowDown");
  await expect(
    nav.getByRole("button", { name: "飞书待办", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    plugins.getByRole("heading", { name: "飞书机器人", exact: true }),
  ).toBeVisible();
  await expect(nav).toHaveCount(0);
  await plugins.getByRole("button", { name: "返回总览" }).click();
  await expect(
    plugins.getByRole("group", { name: "飞书待办", exact: true }),
  ).toBeVisible();
  const enable = plugins.getByRole("switch", {
    name: "启用插件 飞书待办",
    exact: true,
  });
  const initial = await enable.isChecked();
  const change = () =>
    Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/plugins/lever.lark-todos") &&
          response.request().method() === "PUT" &&
          response.ok(),
      ),
      enable.click(),
    ]);
  try {
    await change();
    await expect(enable).toBeChecked({ checked: !initial });
    await expect(
      plugins.getByRole("heading", { name: "插件总览", exact: true }),
    ).toBeVisible();
  } finally {
    if ((await enable.isChecked()) !== initial) await change();
  }
  await expect(enable).toBeChecked({ checked: initial });
  const pane = plugins.locator(".plugins-scroll");
  expect(await pane.evaluate((el) => el.scrollWidth === el.clientWidth)).toBe(
    true,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth === innerWidth,
    ),
  ).toBe(true);
});

test("feishu add bot dialog defaults to QR registration with direct configurable options", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });

  let channelState: Record<string, unknown> = {
    configured: false,
    enabled: true,
    connection: "offline",
    paused: false,
    bots: [],
  };
  const registerPosts: Array<Record<string, unknown>> = [];
  const registerPuts: Array<Record<string, unknown>> = [];
  let cancelCount = 0;
  const createPosts: Array<Record<string, unknown>> = [];

  await page.route("**/api/channels/feishu**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (url.pathname === "/api/channels/feishu" && method === "GET") {
      await route.fulfill({ json: channelState });
      return;
    }
    if (
      url.pathname === "/api/channels/feishu/bots/registration" &&
      method === "POST"
    ) {
      registerPosts.push(req.postDataJSON() as Record<string, unknown>);
      channelState = {
        ...channelState,
        registration: {
          phase: "waiting",
          url: "https://accounts.feishu.cn/create?user_code=test-qr",
          brand: "feishu",
        },
      };
      await route.fulfill({ json: channelState });
      return;
    }
    if (
      url.pathname === "/api/channels/feishu/bots/registration" &&
      method === "PUT"
    ) {
      registerPuts.push(req.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: channelState });
      return;
    }
    if (
      url.pathname === "/api/channels/feishu/registration" &&
      method === "DELETE"
    ) {
      cancelCount += 1;
      channelState = {
        ...channelState,
        registration: { phase: "cancelled" },
      };
      await route.fulfill({ json: channelState });
      return;
    }
    if (url.pathname === "/api/channels/feishu/bots" && method === "POST") {
      const payload = req.postDataJSON() as {
        appId: string;
        brand?: string;
        displayName?: string;
        agentId?: string;
        settings?: Record<string, unknown>;
      };
      createPosts.push(payload as Record<string, unknown>);
      channelState = {
        configured: true,
        enabled: true,
        connection: "online",
        paused: false,
        bots: [
          {
            id: "bot-1",
            appId: payload.appId,
            brand: payload.brand ?? "feishu",
            botName: payload.displayName || "Test Bot",
            enabled: true,
            connection: "online",
            paired: false,
            settings: payload.settings,
          },
        ],
      };
      await route.fulfill({ json: channelState });
      return;
    }
    await route.continue();
  });

  const plugins = await openPlugins(page);
  await plugins
    .getByRole("navigation", { name: "插件" })
    .getByRole("button", { name: "飞书机器人", exact: true })
    .click();

  await expect(
    plugins.getByRole("heading", { name: "飞书机器人", exact: true }),
  ).toBeVisible();
  // Empty state renders a single primary CTA button
  await expect(
    plugins.getByRole("button", { name: "绑定第一个机器人" }),
  ).toBeVisible();
  await expect(
    plugins.getByRole("button", { name: "绑定机器人", exact: true }),
  ).toHaveCount(0);

  await plugins.getByRole("button", { name: "绑定第一个机器人" }).click();
  const dialog = page.getByRole("dialog", { name: "绑定新的飞书机器人" });
  await expect(dialog).toBeVisible();

  // Defaults to QR scan mode and auto-starts QR registration without extra clicks
  const qrMode = dialog.getByRole("radio", { name: "扫码新建 / 绑定" });
  const manualMode = dialog.getByRole("radio", { name: "手动输入凭据" });
  await expect(qrMode).toHaveAttribute("data-state", "on");
  await expect(manualMode).toHaveAttribute("data-state", "off");
  await expect(
    dialog.getByRole("link", { name: "打开配置链接" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "新建或选择机器人" }),
  ).toHaveCount(0);
  // Platform selector is hidden in QR mode (Feishu/Lark is auto-detected)
  await expect(dialog.getByRole("radio", { name: "Lark" })).toHaveCount(0);
  expect(registerPosts).toHaveLength(1);

  // Scene presets are replaced by direct configurable options
  await expect(dialog.getByText("初始场景预设")).toHaveCount(0);
  await expect(dialog.getByText("个人随身助手")).toHaveCount(0);
  await expect(dialog.getByText("初始配置")).toBeVisible();
  await expect(dialog.getByText("私聊调用权限")).toBeVisible();
  await expect(dialog.getByText("私聊形态")).toBeVisible();
  await expect(dialog.getByText("回复样式")).toBeVisible();
  await expect(dialog.getByText("允许在群聊中使用")).toBeVisible();
  await expect(dialog.getByText("群聊默认触发")).toHaveCount(0);

  // Configure direct options and verify live draft sync to backend
  await dialog.getByRole("radio", { name: "应用内全员" }).click();
  await dialog.getByRole("radio", { name: "简洁文本" }).click();
  await dialog.getByRole("switch", { name: "允许在群聊中使用" }).click();
  await expect(dialog.getByText("群聊准入范围")).toBeVisible();
  await expect(dialog.getByText("群聊默认触发")).toBeVisible();
  await expect(dialog.getByText("群聊回复落点")).toBeVisible();
  await dialog.getByRole("radio", { name: "必须 @" }).click();
  await dialog.getByRole("radio", { name: "引用回复" }).click();

  await expect
    .poll(
      () =>
        (
          registerPuts[registerPuts.length - 1] as
            | { settings?: Record<string, unknown> }
            | undefined
        )?.settings,
    )
    .toMatchObject({
      dmAccess: "all",
      replyStyle: "text",
      groupEnabled: true,
      groupMention: "at_only",
      groupReplyTarget: "quote",
    });

  // Switch to manual credentials mode: cancels QR, reveals platform & App ID/Secret
  await manualMode.click();
  await expect.poll(() => cancelCount).toBe(1);
  await expect(dialog.getByRole("radio", { name: "Lark" })).toBeVisible();
  await dialog.getByLabel("App ID").fill("cli_direct_options");
  await dialog.getByLabel("App Secret").fill("sec_direct_options");
  await dialog.getByLabel("显示名称（可选）").fill("直配测试机器人");
  await dialog.getByRole("button", { name: "验证并绑定" }).click();

  await expect(dialog).toBeHidden();
  expect(createPosts).toHaveLength(1);
  expect(createPosts[0]).toMatchObject({
    appId: "cli_direct_options",
    displayName: "直配测试机器人",
    settings: {
      dmAccess: "all",
      replyStyle: "text",
      groupEnabled: true,
      groupMention: "at_only",
      groupReplyTarget: "quote",
    },
  });
  expect(createPosts[0]).not.toHaveProperty("preset");

  // Bot summary bar should no longer show scene preset dropdown
  await expect(
    plugins.getByRole("button", { name: "套用预设" }),
  ).toHaveCount(0);
  await expect(
    plugins.getByRole("tab", { name: /直配测试机器人/ }),
  ).toBeVisible();
});

test("feishu bot settings warn on deadlocked DM access, configure reactions top-level, and group chat rules together", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });

  let settings: Record<string, unknown> = {
    displayName: "测试小助手",
    agentId: "agent-placeholder",
    dmMode: "continuous",
    replyStyle: "card",
    reaction: "OnIt",
    reactionDone: "DONE",
    groupEnabled: false,
    groupMention: "thread_free",
    groupReplyTarget: "topic",
    dmAccess: "admin",
    dmWhitelist: [],
    groupAccess: "whitelist",
    replyMention: "requester",
    admins: [],
    defaultPrompt: "",
    chatOverrides: [],
    advanced: {
      reactionAck: true,
      senderTag: true,
      hideLocalAddresses: true,
      historyLimit: 20,
      trustSameOwnerBots: false,
      sessionMapping: "single_chat_topics",
      approvalMode: "lever",
      blockedUsers: [],
    },
  };
  let pendingRequests: Array<Record<string, unknown>> = [
    {
      openId: "ou_requester",
      name: "赵访客",
      preview: "请问可以帮我看看吗",
      requestedAt: "2026-11-27T05:00:00Z",
    },
  ];
  const knownUsers: Array<Record<string, unknown>> = [
    {
      openId: "ou_requester",
      name: "赵访客",
      email: "guest@example.com",
      source: "recent",
    },
  ];
  const settingsPuts: Array<Record<string, unknown>> = [];
  const accessPosts: Array<Record<string, unknown>> = [];

  const directoryContacts = [
    {
      openId: "ou_alice",
      name: "张爱丽",
      enName: "Alice Zhang",
      email: "alice@example.com",
      source: "directory",
    },
    {
      openId: "ou_zhou",
      name: "群成员小周",
      source: "chat",
    },
  ];

  const makeChannel = () => ({
    configured: true,
    enabled: true,
    connection: "online",
    paused: false,
    bots: [
      {
        id: "bot-ux-1",
        appId: "cli_ux_test",
        brand: "feishu",
        botName: "Lever",
        enabled: true,
        connection: "online",
        paired: false,
        pendingRequests,
        knownUsers,
        settings,
      },
    ],
  });

  await page.route("**/api/channels/feishu**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/api/channels/feishu" && req.method() === "GET") {
      await route.fulfill({ json: makeChannel() });
      return;
    }
    if (
      url.pathname === "/api/channels/feishu/bots/bot-ux-1/contacts" &&
      req.method() === "GET"
    ) {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q === "ou_foreign") {
        await route.fulfill({
          json: {
            contacts: [],
            warning: "cross_app_open_id",
          },
        });
        return;
      }
      const filtered = q
        ? directoryContacts.filter(
            (c) =>
              c.name.includes(q) ||
              (c.email ?? "").toLowerCase().includes(q.toLowerCase()) ||
              c.openId.includes(q),
          )
        : directoryContacts;
      await route.fulfill({
        json: {
          contacts: filtered,
          missingScopes: ["contact:user.id:readonly"],
        },
      });
      return;
    }
    if (
      url.pathname === "/api/channels/feishu/bots/bot-ux-1/access-requests" &&
      req.method() === "POST"
    ) {
      const body = req.postDataJSON() as Record<string, unknown>;
      accessPosts.push(body);
      const openId = String(body.openId ?? "");
      pendingRequests = pendingRequests.filter((r) => r.openId !== openId);
      if (body.action === "allow_dm") {
        const cur = (settings.dmWhitelist as string[]) ?? [];
        settings = {
          ...settings,
          dmAccess: "whitelist",
          dmWhitelist: cur.includes(openId) ? cur : [...cur, openId],
        };
      }
      await route.fulfill({ json: makeChannel() });
      return;
    }
    if (
      url.pathname === "/api/channels/feishu/bots/bot-ux-1/settings" &&
      req.method() === "PUT"
    ) {
      const next = req.postDataJSON() as Record<string, unknown>;
      settingsPuts.push(next);
      settings = next;
      for (const id of [
        ...((next.admins as string[]) ?? []),
        ...((next.dmWhitelist as string[]) ?? []),
      ]) {
        const hit = directoryContacts.find((c) => c.openId === id);
        if (hit && !knownUsers.some((u) => u.openId === id)) {
          knownUsers.push(hit);
        }
      }
      await route.fulfill({ json: makeChannel() });
      return;
    }
    await route.continue();
  });

  const plugins = await openPlugins(page);
  await plugins
    .getByRole("navigation", { name: "插件" })
    .getByRole("button", { name: "飞书机器人", exact: true })
    .click();

  const settingsRegion = plugins.getByRole("region", { name: "渠道设置" });

  // Unclaimed admin-only bot shows direct-message auto-bind guidance (NOT manual /pair).
  await expect(settingsRegion.getByText("已连接")).toBeVisible();
  await expect(
    settingsRegion.getByText(/直接在飞书给机器人发任意一条消息即可自动绑定/),
  ).toBeVisible();
  await expect(
    settingsRegion.getByRole("button", { name: "绑定管理员私聊" }),
  ).toHaveCount(0);

  // Pending DM access request can be approved with one click ("授权私聊").
  await expect(settingsRegion.getByText("待处理私聊授权请求（1）")).toBeVisible();
  await expect(settingsRegion.getByText("赵访客")).toBeVisible();
  await settingsRegion.getByRole("button", { name: "授权私聊" }).click();
  await expect
    .poll(() => accessPosts[accessPosts.length - 1]?.action)
    .toBe("allow_dm");
  await expect(settingsRegion.getByText("待处理私聊授权请求")).toHaveCount(0);
  // Approved user appears as a human-readable chip in the DM whitelist row.
  await expect(settingsRegion.getByText("赵访客")).toBeVisible();

  // Search contacts & directly authorize an admin via FeishuContactPicker.
  await settingsRegion.getByRole("button", { name: "搜索添加管理员" }).click();
  const contactSearch = page.getByPlaceholder(
    "搜姓名、邮箱、手机号或粘贴 ou_...",
  );
  await expect(contactSearch).toBeVisible();
  await expect(page.getByText(/部分通讯录权限未开通/)).toBeVisible();
  await contactSearch.fill("ou_foreign");
  await expect(page.getByText(/该 Open ID 属于其他飞书应用/)).toBeVisible();

  await contactSearch.fill("张爱丽");
  await page.getByRole("option", { name: /张爱丽/ }).click();
  await expect
    .poll(() => settingsPuts[settingsPuts.length - 1]?.admins)
    .toEqual(["ou_alice"]);
  await page.keyboard.press("Escape");
  await expect(settingsRegion.getByText("张爱丽")).toBeVisible();

  // Reaction ack & completion pickers are top-level (NOT hidden in Advanced & Safety).
  const ackSelect = settingsRegion.getByRole("button", { name: "表情回执" });
  const doneSelect = settingsRegion.getByRole("button", {
    name: "完成后切换表情",
  });
  await expect(ackSelect).toBeVisible();
  await expect(doneSelect).toBeVisible();

  await ackSelect.click();
  await page.getByRole("option", { name: "点赞" }).click();
  await expect
    .poll(() => settingsPuts[settingsPuts.length - 1]?.reaction)
    .toBe("THUMBSUP");

  await doneSelect.click();
  await page.getByRole("option", { name: "保持不变" }).click();
  await expect
    .poll(() => settingsPuts[settingsPuts.length - 1]?.reactionDone)
    .toBe("");

  // Switching to custom emoji shows inline key input and persists valid custom emoji.
  await ackSelect.click();
  await page.getByRole("option", { name: "自定义表情" }).click();
  const customInput = settingsRegion.getByLabel("表情标识", { exact: true });
  await expect(customInput).toBeVisible();
  await customInput.fill("FINGERHEART");
  await customInput.press("Enter");
  await expect
    .poll(() => settingsPuts[settingsPuts.length - 1]?.reaction)
    .toBe("FINGERHEART");

  // Enabling group chats reveals group settings + per-group rules inside the unified card.
  await expect(
    settingsRegion.getByText("指定群聊规则", { exact: true }),
  ).toHaveCount(0);
  await settingsRegion
    .getByRole("switch", { name: "允许在群聊中使用" })
    .click();
  await expect(settingsRegion.getByText("群聊准入范围")).toBeVisible();
  await expect(settingsRegion.getByText("回复 @ 权限")).toBeVisible();
  await expect(
    settingsRegion.getByText("指定群聊规则", { exact: true }),
  ).toBeVisible();
  await expect(
    settingsRegion.getByRole("button", { name: "添加群聊规则" }),
  ).toBeVisible();
});

test("ACP runtimes toggle native session titles with immediate auto-save", async ({
  page,
}) => {
  const { url } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  );
  async function openRuntimes() {
    await page.goto(url);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "运行时", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "运行时", exact: true });
    const details = page.getByRole("region", { name: "运行时详情" });
    const connected = panel.getByRole("region", { name: "已接入" });
    return { details, connected };
  }

  const { details, connected } = await openRuntimes();
  await connected.getByRole("button", { name: /^Codex/ }).click();
  await expect(
    details.getByRole("heading", { name: "Codex", exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("switch", { name: "原生会话标题", exact: true }),
  ).toHaveCount(0);

  await connected.getByRole("button", { name: /^DeepSeek Harness/ }).click();
  await expect(
    details.getByRole("switch", { name: "原生会话标题", exact: true }),
  ).toBeChecked();

  await connected.getByRole("button", { name: /^Antigravity/ }).click();
  const toggle = details.getByRole("switch", {
    name: "原生会话标题",
    exact: true,
  });
  await expect(toggle).toBeChecked();

  const disabledSave = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/providers") &&
      response.request().postDataJSON()?.id === "antigravity" &&
      response.request().postDataJSON()?.nativeTitles === false,
  );
  await toggle.click();
  expect((await disabledSave).ok()).toBe(true);
  await expect(toggle).not.toBeChecked();

  // Persists across reload, then restores back to enabled.
  const reloaded = await openRuntimes();
  await reloaded.connected
    .getByRole("button", { name: /^Antigravity/ })
    .click();
  const reloadedToggle = reloaded.details.getByRole("switch", {
    name: "原生会话标题",
    exact: true,
  });
  await expect(reloadedToggle).not.toBeChecked();

  const enabledSave = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/providers") &&
      response.request().postDataJSON()?.id === "antigravity" &&
      response.request().postDataJSON()?.nativeTitles === undefined,
  );
  await reloadedToggle.click();
  expect((await enabledSave).ok()).toBe(true);
  await expect(reloadedToggle).toBeChecked();
});
