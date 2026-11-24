import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("personal channel saves owner-only routes and reply preferences", async ({
  page,
}) => {
  const { url } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  );
  const directory = mkdtempSync(join(tmpdir(), "personal-channel-ui-"));
  const name = "Personal channel fixture";
  writeFileSync(
    join(directory, "lever-plugin.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "example.personal-ui",
      name,
      version: "1",
      contributes: {
        channels: [
          {
            id: "personal",
            name,
            driver: "personal-stdio-v1",
            command: "bridge",
          },
        ],
      },
    }),
  );
  writeFileSync(join(directory, "bridge"), "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  let id: string | undefined;
  try {
    await page.goto(url);
    await expect(
      page.getByRole("navigation", { name: "主导航" }),
    ).toBeVisible();
    const installed = await page.request.post("/api/plugins", {
      data: { directory },
    });
    expect(installed.ok()).toBe(true);
    id = (await installed.json()).id;
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "插件", exact: true })
      .click();
    const card = page.getByRole("group", { name, exact: true });
    const cardIcon = card.locator(".plugin-card-mark > img");
    await expect(cardIcon).toBeVisible();
    expect(
      await cardIcon.evaluate(
        (image: HTMLImageElement) => image.naturalWidth > 0,
      ),
    ).toBe(true);
    await card.getByRole("button").click();
    const detailIcon = page.locator(
      ".plugins-detail-identity .plugin-icon > img",
    );
    await expect(detailIcon).toBeVisible();
    expect(
      await detailIcon.evaluate(
        (image: HTMLImageElement) => image.naturalWidth > 0,
      ),
    ).toBe(true);
    await expect(page.getByText("仅本人可唤起", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "扫码连接" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "保存", exact: true }),
    ).toHaveCount(0);
    const waitChannelSave = (
      match?: (body: Record<string, unknown>) => boolean,
    ) =>
      page.waitForResponse((response) => {
        if (
          !response.url().endsWith(`/api/plugins/${id}/channel`) ||
          response.request().method() !== "PUT" ||
          !response.ok()
        )
          return false;
        return !match || match(response.request().postDataJSON());
      });
    const picker = page.getByRole("button", { name: "选择 Agent" });
    await picker.click();
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible();
    await option.click();
    await page.getByPlaceholder("/agent /ai").fill("/审查 /agent /abc");
    await expect(
      page.getByRole("radio", { name: "单 Chat（话题分组）" }),
    ).toBeChecked();
    await expect(
      page.getByText(/每个 Agent 共用 1 个主 Chat/),
    ).toBeVisible();
    await page.getByRole("radio", { name: "多 Chat（按飞书会话）" }).click();
    await expect(
      page.getByText(/每个飞书私聊或群聊各自对应 1 个独立 Chat/),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "跟随 Agent" })).toBeChecked();
    await page.getByRole("radio", { name: "指定模型" }).click();
    await page.getByRole("button", { name: "选择模型和运行时" }).click();
    const models = page.getByRole("dialog", { name: "选择模型和运行时" });
    await models.getByRole("radio", { name: "Codex", exact: true }).click();
    await models
      .getByRole("button", { name: "GPT Review", exact: true })
      .click();
    await models.getByRole("radio", { name: "高", exact: true }).click();
    await page.getByRole("radio", { name: "直接回复" }).click();
    const receipts = page.getByRole("region", { name: "消息回执" });
    const reaction = receipts.getByRole("button", { name: "原消息表情" });
    const search = page.getByRole("combobox", { name: "搜索表情" });
    await expect(reaction).toHaveAccessibleDescription("关闭");
    await reaction.click();
    await expect(page.getByRole("option", { name: "收到" })).toBeVisible();
    await search.fill("处理");
    await expect(page.getByRole("option", { name: "处理中" })).toBeVisible();
    await search.press("Enter");
    await expect(reaction).toHaveAccessibleDescription("处理中");
    await page.getByLabel("渠道提示词", { exact: true }).fill("先给结论。");
    await page.getByRole("radio", { name: "仅本条和引用" }).click();
    await page.getByRole("radio", { name: "指定会话", exact: true }).click();
    const savedChatIds = waitChannelSave(
      (body) =>
        Array.isArray(body.chatIds) &&
        body.chatIds.length === 2 &&
        body.chatIds[0] === "111" &&
        body.chatIds[1] === "222",
    );
    await page.getByLabel("会话数字 ID（空格分隔）").fill("111 222");
    await savedChatIds;
    const view = await (
      await page.request.get(`/api/plugins/${id}/channel`)
    ).json();
    expect(view.state).toBe("signedOut");
    expect(view.settings).toMatchObject({
      chatIds: ["111", "222"],
      chatMode: "byChat",
      reaction: "OnIt",
      threadReply: false,
      contextLimit: 0,
      prompt: "先给结论。",
      routes: [
        {
          enabled: true,
          commands: ["/审查", "/agent", "/abc"],
          selection: { provider: "codex", model: "gpt-review", effort: "high" },
        },
      ],
    });
    const reopenSettings = async () => {
      await page.reload();
      await page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name: "插件", exact: true })
        .click();
      if (!(await receipts.isVisible())) await card.getByRole("button").click();
    };
    await reopenSettings();
    await expect(reaction).toHaveAccessibleDescription("处理中");
    await expect(receipts.getByRole("textbox")).toHaveCount(0);
    await reaction.click();
    await page.getByRole("option", { name: "自定义表情" }).click();
    // Choosing custom reaction with an empty key does not overwrite the saved value.
    const unchanged = await (
      await page.request.get(`/api/plugins/${id}/channel`)
    ).json();
    expect(unchanged.settings.reaction).toBe("OnIt");
    const savedCustomEmoji = waitChannelSave(
      (body) => body.reaction === "YouAreTheBest",
    );
    await receipts
      .getByLabel("表情标识", { exact: true })
      .fill("YouAreTheBest");
    await savedCustomEmoji;
    await reopenSettings();
    await expect(
      page.getByRole("radio", { name: "多 Chat（按飞书会话）" }),
    ).toBeChecked();
    const savedSingle = waitChannelSave((body) => body.chatMode === "single");
    await page.getByRole("radio", { name: "单 Chat（话题分组）" }).click();
    await savedSingle;
    await expect(
      page.getByRole("button", { name: "选择模型和运行时" }),
    ).toContainText("GPT Review");
    await expect(page.getByLabel("渠道提示词", { exact: true })).toHaveValue(
      "先给结论。",
    );
    await expect(receipts.getByLabel("表情标识", { exact: true })).toHaveValue(
      "YouAreTheBest",
    );
    const savedInherit = waitChannelSave();
    await page.getByRole("radio", { name: "跟随 Agent" }).click();
    await savedInherit;
    const restored = await (
      await page.request.get(`/api/plugins/${id}/channel`)
    ).json();
    expect(restored.settings.routes[0].selection).toBeUndefined();
    expect(restored.settings.reaction).toBe("YouAreTheBest");
    await reaction.click();
    const savedCleared = waitChannelSave();
    await page.getByRole("option", { name: "关闭", exact: true }).click();
    await savedCleared;
    const cleared = await (
      await page.request.get(`/api/plugins/${id}/channel`)
    ).json();
    expect(cleared.settings.reaction).toBe("");
    let legacy = false;
    let state = "preparing";
    await page.route(`**/api/plugins/${id}/channel`, async (route) => {
      const settings = { ...cleared.settings };
      if (legacy) {
        delete settings.prompt;
        delete settings.chatMode;
      }
      await route.fulfill({
        json: {
          ...cleared,
          state,
          settings,
          last: {
            command: "/agent",
            agentId: settings.routes[0].agentId,
            chatId: "fixture",
            sessionId: "fixture-topic",
            runId: "fixture-run",
            topic: true,
            chatName: "研发群",
            status: "sent",
            runStatus: "failed",
            contextReady: true,
            selection: { provider: "claude", model: "claude-review" },
            reaction: "DONE",
            reactionStatus: "ok",
          },
        },
      });
    });
    await expect(page.getByText(/正在准备插件运行环境/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "取消", exact: true }),
    ).toBeEnabled();
    state = "dependency";
    await expect(page.getByText(/运行环境准备失败/)).toBeVisible();
    await expect(page.getByRole("button", { name: "扫码连接" })).toBeEnabled();
    const last = page.getByRole("region", { name: "最近受理" });
    await expect(last).toContainText("研发群");
    await expect(last).toContainText("执行失败");
    await expect(last).toContainText("claude-review");
    await expect(last).toContainText("完成 · 飞书已确认");
    await expect(last).toContainText("失败通知已送达");
    await page.setViewportSize({ width: 390, height: 840 });
    const sidebar = page.getByRole("button", { name: "收起二级菜单" });
    if (await sidebar.isVisible()) await sidebar.click();
    await page
      .getByRole("heading", { name: "回复与上下文" })
      .scrollIntoViewIfNeeded();
    await expect(page.getByRole("radio", { name: "直接回复" })).toBeChecked();
    const scroll = page.locator(".plugins-scroll");
    expect(
      await scroll.evaluate((item) => item.scrollWidth <= item.clientWidth + 1),
    ).toBe(true);
    legacy = true;
    await expect(page.getByText(/当前后端使用旧版本/)).toBeVisible();
    await expect(page.getByRole("radio", { name: "指定模型" })).toHaveCount(0);
    await expect(
      page.getByRole("radio", { name: "单 Chat（话题分组）" }),
    ).toHaveCount(0);
  } finally {
    if (id) await page.request.delete(`/api/plugins/${id}`).catch(() => {});
    rmSync(directory, { force: true, recursive: true });
  }
});
