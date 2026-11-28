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

test("markdown preview fits mermaid diagrams in overview and expands to a zoomable viewer", async ({
  page,
}) => {
  const { scope } = context();
  const hostDir = realpathSync(mkdtempSync(join(tmpdir(), "lever-mermaid-")));
  const docPath = join(hostDir, "architecture.md");
  writeFileSync(
    docPath,
    [
      "# 架构总览",
      "",
      "```mermaid",
      "flowchart TB",
      '    subgraph iOS["Lever iOS App（SwiftUI · iOS 18.0+）"]',
      '        UI["UI 层 · Feed / Chat / Topic / RunChangesSheet / Lightbox / SwiftTerm"]',
      '        ScrollMD["滚动锚定（onScrollGeometryChange） · 流式 Markdown（Textual + 补全器）"]',
      '        Activity["Live Activities（ActivityKit + Widget Extension）"]',
      '        Store["模块化 @Observable Store · Sync / Projection / Composer / Media / Terminal"]',
      '        GRDB["GRDB.swift（DatabasePool WAL + Migrator + FTS5 全文检索）"]',
      '        Nuke["Nuke / NukeUI（ImagePipeline + 自定义 LeverNukeDataLoader）"]',
      '        Keychain["KeychainStore（原生 Security.framework）"]',
      "    end",
      '    subgraph Core["LeverCore.xcframework（mobile/core + internal/multinode）"]',
      '        FFI["C FFI · JSON 请求 / FetchBinary 原始字节 / SSE 事件回调"]',
      '        Loopback["本地一次性回环代理 · MobileWorkspace（HTTP） / TerminalProxy（WS）"]',
      '        Router["NodeRouter · Ed25519 签名 / TLS 1.3 钉扎 / Bonjour / LAN↔Hub 择路"]',
      "    end",
      '    subgraph Remote["Owner Node & 可选 Lever Hub"]',
      '        Peer["Owner Node · /peer/v1/*（会话 / Diff / 附件 / PTY 终端）"]',
      '        Hub["Lever Hub · /ws/sync / /ws/tunnel / APNs（Alert + LiveActivity）"]',
      "    end",
      "    UI --> ScrollMD",
      "    UI --> Store",
      "    UI --> Nuke",
      "    UI --> Activity",
      "    Store --> GRDB",
      "    Store --> FFI",
      "    Nuke --> FFI",
      '    UI -->|"SwiftTerm WS / SFSafariViewController"| Loopback',
      "    FFI --> Router",
      "    Loopback --> Router",
      '    FFI <-->|"凭证读写回调"| Keychain',
      '    Router <-->|"LAN TLS 1.3 直连"| Peer',
      '    Router <-->|"HTTPS + SSE + Yamux 隧道"| Hub',
      "    Hub <--> Peer",
      "```",
      "",
      "## 简图",
      "",
      "```mermaid",
      "flowchart LR",
      "    A[Start] --> B[End]",
      "```",
      "",
    ].join("\n"),
  );

  try {
    await createAgent(page, "Mermaid 预览 Agent", scope);
    await page.route(
      "**/api/messages",
      async (route) => {
        const response = await route.fetch({
          postData: {
            ...route.request().postDataJSON(),
            text: `查看架构图：[architecture.md](${pathToFileURL(docPath).href})`,
          },
        });
        await route.fulfill({ response });
      },
      { times: 1 },
    );

    await send(page, "打开架构文档");
    await page
      .locator(".run-content")
      .last()
      .getByRole("link", { name: "architecture.md" })
      .click();

    const preview = page.getByRole("tabpanel", {
      name: "architecture.md",
      exact: true,
    });
    await expect(preview).toBeVisible();

    const diagrams = preview.locator(".mermaid-diagram");
    await expect(diagrams).toHaveCount(2, { timeout: 15_000 });

    const largeTrigger = diagrams.nth(0);
    const largeImage = largeTrigger.locator("img");
    await expect
      .poll(() =>
        largeImage.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(800);

    const largeMetrics = await largeTrigger.evaluate((button) => {
      const img = button.querySelector("img") as HTMLImageElement;
      const buttonRect = button.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      return {
        buttonWidth: buttonRect.width,
        buttonHeight: buttonRect.height,
        scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth,
        scrollHeight: button.scrollHeight,
        clientHeight: button.clientHeight,
        imgWidth: imgRect.width,
        imgHeight: imgRect.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      };
    });

    // Large diagram fits completely inside the overview container without clipping or scroll overflow.
    expect(largeMetrics.scrollWidth).toBeLessThanOrEqual(
      largeMetrics.clientWidth + 1,
    );
    expect(largeMetrics.scrollHeight).toBeLessThanOrEqual(
      largeMetrics.clientHeight + 1,
    );
    expect(largeMetrics.imgWidth).toBeLessThanOrEqual(
      largeMetrics.buttonWidth + 1,
    );
    expect(largeMetrics.imgHeight).toBeLessThanOrEqual(
      largeMetrics.buttonHeight + 1,
    );
    expect(largeMetrics.imgWidth).toBeLessThan(largeMetrics.naturalWidth);
    const naturalRatio = largeMetrics.naturalWidth / largeMetrics.naturalHeight;
    const renderedRatio = largeMetrics.imgWidth / largeMetrics.imgHeight;
    expect(Math.abs(renderedRatio - naturalRatio)).toBeLessThan(0.05);

    // Small diagram keeps its natural size instead of being stretched to full width.
    const smallTrigger = diagrams.nth(1);
    const smallImage = smallTrigger.locator("img");
    await expect
      .poll(() =>
        smallImage.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    const smallMetrics = await smallImage.evaluate((node) => {
      const img = node as HTMLImageElement;
      const rect = img.getBoundingClientRect();
      return {
        width: rect.width,
        naturalWidth: img.naturalWidth,
      };
    });
    expect(smallMetrics.width).toBeLessThanOrEqual(
      smallMetrics.naturalWidth + 1,
    );

    // Clicking the diagram opens the expanded zoomable dialog.
    await largeTrigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "适应窗口" })).toHaveText(
      "100%",
    );

    const dialogImage = dialog.locator(".attachment-preview img");
    await expect(dialogImage).toBeVisible();
    const dialogImageMetrics = await dialog.evaluate((root) => {
      const viewport = root.querySelector(".attachment-preview-viewport")!;
      const img = root.querySelector(
        ".attachment-preview img",
      ) as HTMLImageElement;
      const vpRect = viewport.getBoundingClientRect();
      const imgRect = img.getBoundingClientRect();
      return {
        vpWidth: vpRect.width,
        vpHeight: vpRect.height,
        imgWidth: imgRect.width,
        imgHeight: imgRect.height,
      };
    });
    expect(dialogImageMetrics.imgWidth).toBeLessThanOrEqual(
      dialogImageMetrics.vpWidth,
    );
    expect(dialogImageMetrics.imgHeight).toBeLessThanOrEqual(
      dialogImageMetrics.vpHeight,
    );
    expect(dialogImageMetrics.imgHeight).toBeGreaterThan(
      largeMetrics.imgHeight,
    );

    // Zoom in via button and keyboard, then reset and close.
    await dialog.getByRole("button", { name: "放大" }).click();
    await expect(dialog.getByRole("button", { name: "适应窗口" })).toHaveText(
      "125%",
    );
    await page.keyboard.press("+");
    await expect(dialog.getByRole("button", { name: "适应窗口" })).toHaveText(
      "156%",
    );
    await dialog.getByRole("button", { name: "适应窗口" }).click();
    await expect(dialog.getByRole("button", { name: "适应窗口" })).toHaveText(
      "100%",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(largeTrigger).toBeFocused();

    // Header expand button also opens the dialog and restores focus to itself.
    const expandButton = preview
      .getByRole("button", { name: "放大图表" })
      .first();
    await expandButton.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(expandButton).toBeFocused();
  } finally {
    rmSync(hostDir, { recursive: true, force: true });
  }
});
