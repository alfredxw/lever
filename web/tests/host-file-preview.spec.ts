import { expect, test, type Page } from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+w2S8AAAAASUVORK5CYII=",
  "base64",
);

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

test("chat opens read-only host Markdown artifacts with absolute images, carousels, and workspace links", async ({
  page,
}) => {
  const { scope } = context();
  const realScope = realpathSync(scope);
  const workspaceNote = join(realScope, "host-link-target.txt");
  writeFileSync(workspaceNote, "line 1\nline 2 target\nline 3\n");

  const hostDir = realpathSync(mkdtempSync(join(tmpdir(), "lever-brain-")));
  const beforeAfter = join(hostDir, "01-before-after.png");
  const slideOne = join(hostDir, "02-states.png");
  const slideTwo = join(hostDir, "04-dark.png");
  const designDoc = join(hostDir, "workspace-search-ux-design.md");
  writeFileSync(beforeAfter, onePixelPng);
  writeFileSync(slideOne, onePixelPng);
  writeFileSync(slideTwo, onePixelPng);
  writeFileSync(
    designDoc,
    [
      "# WorkspaceSearch 优化方案",
      "",
      `对应文件：[host-link-target.txt](${pathToFileURL(workspaceNote).href}#L2-L3)`,
      "",
      `![Before / After 对比](${beforeAfter})`,
      "",
      "````carousel",
      `![状态总览](${slideOne})`,
      "<!-- slide -->",
      `![深色模式](${slideTwo})`,
      "````",
      "",
    ].join("\n"),
  );

  try {
    await createAgent(page, "宿主机预览 Agent", scope);
    await page.route(
      "**/api/messages",
      async (route) => {
        const response = await route.fetch({
          postData: {
            ...route.request().postDataJSON(),
            text: `详见设计文档：[workspace-search-ux-design.md](${pathToFileURL(designDoc).href})`,
          },
        });
        await route.fulfill({ response });
      },
      { times: 1 },
    );

    await send(page, "查看设计文档");

    const response = page.locator(".run-content").last().locator(".chat-response");
    const docLink = response.getByRole("link", {
      name: "workspace-search-ux-design.md",
    });
    await expect(docLink).toBeVisible();
    await expect(docLink).toHaveAttribute("title", designDoc);
    await docLink.click();

    const preview = page.getByRole("tabpanel", {
      name: "workspace-search-ux-design.md",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect(preview.locator(".file-save-status")).toHaveText("只读");
    await expect(
      preview.getByRole("button", { name: "在文件中搜索" }),
    ).toHaveCount(0);
    await expect(
      preview.getByRole("button", { name: "显示文件目录" }),
    ).toHaveCount(0);
    await expect(
      preview.getByRole("heading", { name: "WorkspaceSearch 优化方案" }),
    ).toBeVisible();

    await expect
      .poll(() =>
        preview
          .getByAltText("Before / After 对比")
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBe(1);

    await expect
      .poll(() =>
        preview
          .getByAltText("状态总览")
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await expect(preview.locator(".file-markdown-carousel")).toContainText(
      "1 / 2",
    );
    await preview.getByRole("button", { name: "下一页" }).click();
    await expect
      .poll(() =>
        preview
          .getByAltText("深色模式")
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await expect(preview.locator(".file-markdown-carousel")).toContainText(
      "2 / 2",
    );

    await preview.getByRole("link", { name: "host-link-target.txt" }).click();
    const targetPanel = page.getByRole("tabpanel", {
      name: "host-link-target.txt",
      exact: true,
    });
    await expect(targetPanel).toBeVisible();
    await expect(targetPanel.locator(".file-save-status")).toHaveCount(0);
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(workspaceNote, { force: true });
  }
});
