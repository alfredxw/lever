import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function context() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    scope: string;
  };
}

async function createAgent(page: Page, name: string, scope: string) {
  await page.goto(context().url);
  await page
    .getByRole("button", { name: "创建 Agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(name);
  await dialog.getByRole("textbox", { name: "工作范围目录" }).fill(scope);
  await dialog.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "发送消息", exact: true }),
  ).toBeVisible();
}

async function send(page: Page, text: string) {
  const mode = page.getByRole("button", { name: "话题", exact: true });
  if ((await mode.getAttribute("aria-pressed")) === "true") await mode.click();
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  await input.click();
  await input.fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".run-content").last()).toHaveAttribute(
    "data-status",
    "completed",
    { timeout: 15_000 },
  );
}

test("HTML previews expand in place under list items, nested lists, emphasis, headings, and tables", async ({
  page,
}) => {
  const { scope } = context();
  const realScope = realpathSync(scope);
  const variantsDir = join(realScope, "output", "agent-sidebar-variants");
  mkdirSync(variantsDir, { recursive: true });
  writeFileSync(
    join(variantsDir, "single-row.html"),
    "<!doctype html><h1>单行视图对比页</h1>",
  );
  writeFileSync(
    join(variantsDir, "nested.html"),
    "<!doctype html><h1>嵌套子项预览</h1>",
  );
  writeFileSync(
    join(variantsDir, "emphasized.html"),
    "<!doctype html><h1>强调链接预览</h1>",
  );
  writeFileSync(
    join(variantsDir, "heading.html"),
    "<!doctype html><h1>标题链接预览</h1>",
  );
  writeFileSync(
    join(variantsDir, "table.html"),
    "<!doctype html><h1>表格链接预览</h1>",
  );
  writeFileSync(
    join(variantsDir, "quote.html"),
    "<!doctype html><h1>引用链接预览</h1>",
  );

  await createAgent(page, "原地预览 Agent", scope);
  const replyMarkdown = [
    "专门做了一份聚焦单行视图的深化对比页：",
    "",
    "- 预览文件：[output/agent-sidebar-variants/single-row.html](output/agent-sidebar-variants/single-row.html)",
    "  - 子说明：保留单行布局细节",
    "  - 子预览：[nested.html](output/agent-sidebar-variants/nested.html)",
    "- 后续列表项",
    "",
    "重点参考：**[强调对照](output/agent-sidebar-variants/emphasized.html)**。",
    "",
    "### 标题入口：[heading.html](output/agent-sidebar-variants/heading.html)",
    "",
    "> 引用入口：[quote.html](output/agent-sidebar-variants/quote.html)",
    "",
    "| 方案 | 文件 |",
    "| --- | --- |",
    "| 表格项 | [table.html](output/agent-sidebar-variants/table.html) |",
    "",
    "末尾总结段落：这份总结位于整条回复的最底部。",
  ].join("\n");

  await page.route(
    "**/api/messages",
    async (route) => {
      const response = await route.fetch({
        postData: {
          ...route.request().postDataJSON(),
          text: replyMarkdown,
        },
      });
      await route.fulfill({ response });
    },
    { times: 1 },
  );

  await send(page, "查看深化对比页");

  const turn = page.locator(".run-content").last();
  const response = turn.locator(".chat-response");
  const trailingParagraph = response.getByText(
    "末尾总结段落：这份总结位于整条回复的最底部。",
  );

  // 1. Tight bullet list item expands inside its own <li> and above its nested <ul>
  const singleRowLink = response.getByRole("link", {
    name: "output/agent-sidebar-variants/single-row.html",
  });
  await expect(singleRowLink).toHaveAttribute("aria-expanded", "false");
  await singleRowLink.click();
  await expect(singleRowLink).toHaveAttribute("aria-expanded", "true");

  const singleRowPreviewId = await singleRowLink.getAttribute("aria-controls");
  expect(singleRowPreviewId).toBeTruthy();
  const singleRowPreview = response.locator(`[id="${singleRowPreviewId}"]`);
  await expect(
    singleRowPreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "单行视图对比页" }),
  ).toBeVisible();

  const listPlacement = await singleRowPreview.evaluate((preview) => {
    const li = preview.closest("li");
    const nestedList = li?.querySelector("ul");
    const nextItem = li?.nextElementSibling;
    return {
      insideLi: Boolean(li),
      beforeNestedList: Boolean(
        nestedList &&
          preview.compareDocumentPosition(nestedList) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      beforeNextItem: Boolean(
        nextItem &&
          preview.compareDocumentPosition(nextItem) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    };
  });
  expect(listPlacement).toEqual({
    insideLi: true,
    beforeNestedList: true,
    beforeNextItem: true,
  });

  // 2. Nested list item owns its own independent inline preview inside the nested <li>
  const nestedLink = response.getByRole("link", { name: "nested.html" });
  await nestedLink.click();
  const nestedPreviewId = await nestedLink.getAttribute("aria-controls");
  expect(nestedPreviewId).toBeTruthy();
  expect(nestedPreviewId).not.toBe(singleRowPreviewId);
  const nestedPreview = response.locator(`[id="${nestedPreviewId}"]`);
  await expect(
    nestedPreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "嵌套子项预览" }),
  ).toBeVisible();
  expect(
    await nestedPreview.evaluate((preview) => {
      const innerLi = preview.closest("li");
      const outerLi = innerLi?.parentElement?.closest("li");
      return Boolean(innerLi && outerLi);
    }),
  ).toBe(true);

  await singleRowPreview.getByRole("button", { name: "收起预览" }).click();
  await expect(singleRowLink).toBeFocused();
  await expect(singleRowPreview).toHaveCount(0);
  await nestedPreview.getByRole("button", { name: "收起预览" }).click();
  await expect(nestedLink).toBeFocused();
  await expect(nestedPreview).toHaveCount(0);

  // 3. Link inside <strong> within <p> expands right below that <p>, above the heading & trailing text
  const emphasizedLink = response.getByRole("link", { name: "强调对照" });
  await emphasizedLink.click();
  const emphasizedPreviewId =
    await emphasizedLink.getAttribute("aria-controls");
  const emphasizedPreview = response.locator(`[id="${emphasizedPreviewId}"]`);
  await expect(
    emphasizedPreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "强调链接预览" }),
  ).toBeVisible();
  expect(
    await emphasizedPreview.evaluate((preview) => {
      const prev = preview.previousElementSibling;
      const next = preview.nextElementSibling;
      return prev?.tagName === "P" && next?.tagName === "H3";
    }),
  ).toBe(true);
  await emphasizedLink.click();
  await expect(emphasizedPreview).toHaveCount(0);

  // 4. Link inside heading expands right below the <h3>, above the blockquote
  const headingLink = response.getByRole("link", { name: "heading.html" });
  await headingLink.click();
  const headingPreviewId = await headingLink.getAttribute("aria-controls");
  const headingPreview = response.locator(`[id="${headingPreviewId}"]`);
  await expect(
    headingPreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "标题链接预览" }),
  ).toBeVisible();
  expect(
    await headingPreview.evaluate((preview) => {
      const prev = preview.previousElementSibling;
      const next = preview.nextElementSibling;
      return prev?.tagName === "H3" && next?.tagName === "BLOCKQUOTE";
    }),
  ).toBe(true);
  await headingLink.click();
  await expect(headingPreview).toHaveCount(0);

  // 5. Link inside blockquote expands in place without inheriting italic header text
  const quoteLink = response.getByRole("link", { name: "quote.html" });
  await quoteLink.click();
  const quotePreviewId = await quoteLink.getAttribute("aria-controls");
  const quotePreview = response.locator(`[id="${quotePreviewId}"]`);
  await expect(
    quotePreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "引用链接预览" }),
  ).toBeVisible();
  expect(
    await quotePreview.evaluate((preview) => ({
      insideBlockquote: Boolean(preview.closest("blockquote")),
      fontStyle: getComputedStyle(preview).fontStyle,
    })),
  ).toEqual({
    insideBlockquote: true,
    fontStyle: "normal",
  });
  await quoteLink.click();
  await expect(quotePreview).toHaveCount(0);

  // 6. Link inside table expands right below the table, above the trailing paragraph
  const tableLink = response.getByRole("link", { name: "table.html" });
  await tableLink.click();
  const tablePreviewId = await tableLink.getAttribute("aria-controls");
  const tablePreview = response.locator(`[id="${tablePreviewId}"]`);
  await expect(
    tablePreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "表格链接预览" }),
  ).toBeVisible();
  const tablePlacement = await Promise.all([
    tablePreview.evaluate((preview) =>
      Boolean(
        preview.previousElementSibling?.classList.contains(
          "response-table-block",
        ),
      ),
    ),
    tablePreview.boundingBox(),
    trailingParagraph.boundingBox(),
  ]);
  expect(tablePlacement[0]).toBe(true);
  expect(tablePlacement[1]!.y + tablePlacement[1]!.height).toBeLessThanOrEqual(
    tablePlacement[2]!.y + 2,
  );
  await tableLink.click();
  await expect(tablePreview).toHaveCount(0);

  // 7. User prompt bullet list also expands in place inside its own <li>
  const userPrompt = turn.locator(".user-message");
  const userLink = userPrompt.getByRole("link", {
    name: "output/agent-sidebar-variants/single-row.html",
  });
  await expect(userLink).toHaveAttribute("aria-expanded", "false");
  await userLink.click();
  const userPreviewId = await userLink.getAttribute("aria-controls");
  const userPreview = userPrompt.locator(`[id="${userPreviewId}"]`);
  await expect(
    userPreview
      .frameLocator("iframe")
      .getByRole("heading", { name: "单行视图对比页" }),
  ).toBeVisible();
  expect(
    await userPreview.evaluate((preview) => {
      const li = preview.closest("li");
      const nestedList = li?.querySelector("ul");
      const nextItem = li?.nextElementSibling;
      return Boolean(
        li &&
          nestedList &&
          preview.compareDocumentPosition(nestedList) &
            Node.DOCUMENT_POSITION_FOLLOWING &&
          nextItem &&
          preview.compareDocumentPosition(nextItem) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
});
