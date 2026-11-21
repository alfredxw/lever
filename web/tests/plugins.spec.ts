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
  await checkIcons(".plugin-card-open", 24);
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
    .getByRole("button", { name: "打开 Lever 的 Profile", exact: true })
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
    .getByRole("button", { name: "打开 Lever 的 Chat", exact: true })
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
  await configuration.getByLabel("连接名称").fill("工作账户");
  await details.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    connections.getByRole("button", { name: /Codex · 工作账户/ }),
  ).toHaveAttribute("aria-pressed", "true");
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
  const mail = library.getByRole("group", { name: "IMAP Mail", exact: true });
  await mail.scrollIntoViewIfNeeded();
  const scroll = plugins.locator(".plugins-scroll");
  const top = await scroll.evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  await mail.click({ position: { x: 16, y: 34 } });
  await expect(
    plugins.getByRole("heading", { name: "IMAP Mail", exact: true }),
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
    nav.getByRole("button", { name: "Lark Bot", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "总览", exact: true }).click();
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
    nav.getByRole("button", { name: "Lark Todos", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    plugins.getByRole("heading", { name: "Lark Bot", exact: true }),
  ).toBeVisible();
  await expect(nav).toHaveCount(0);
  await plugins.getByRole("button", { name: "返回总览" }).click();
  await expect(
    plugins.getByRole("group", { name: "Lark Todos", exact: true }),
  ).toBeVisible();
  const enable = plugins.getByRole("switch", {
    name: "启用插件 Lark Todos",
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
