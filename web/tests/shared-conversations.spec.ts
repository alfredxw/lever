import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Overview, SharedHistory } from "../src/api/types.gen";

test("scrolling into a partial native exchange loads its prompt without losing the exchange", async ({
  page,
}) => {
  const { url, scope } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  );
  await page.goto(url);
  const { homeDir } = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const id = randomUUID();
  const title = `Paginated native history ${id}`;
  const project = join(homeDir, ".claude", "projects", `shared-${id}`);
  mkdirSync(project, { recursive: true });
  const lines = Array.from({ length: 151 }, (_, index) => {
    const role = index % 2 ? "assistant" : "user";
    return JSON.stringify({
      type: role,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: id,
      cwd: scope,
      entrypoint: "cli",
      message: { role, content: `Native ${role} ${1 + Math.floor(index / 2)}` },
    });
  });
  lines.push(
    JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: id }),
  );
  writeFileSync(join(project, `${id}.jsonl`), lines.join("\n") + "\n");
  try {
    await page.reload();
    await page.getByRole("tab", { name: "最近", exact: true }).click();
    const row = page
      .getByRole("tabpanel", { name: "最近" })
      .getByRole("button", { name: new RegExp(title) });
    await row.click();
    const chat = page.getByRole("tabpanel", { name: title, exact: true });
    await expect(
      chat.getByText("Native user 76", { exact: true }),
    ).toBeInViewport();
    const earlier = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/${id}?limit=200`) && response.ok(),
    );
    await chat.locator(".chat-scroll").evaluate((node) => {
      node.scrollTop = 0;
    });
    await earlier;
    await expect(
      chat.getByText("Native user 26", { exact: true }),
    ).toBeInViewport();
    await expect(
      chat.getByText("Native assistant 26", { exact: true }),
    ).toBeInViewport();
    await chat.getByRole("button", { name: "回到最新消息" }).click();
    await expect(
      chat.getByText("Native user 76", { exact: true }),
    ).toBeInViewport();
    await page
      .getByRole("tab", { name: title, exact: true })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "移动到右侧面板" }).click();
    await expect(chat).toHaveAttribute("data-pane", "side");
    await expect(
      chat.getByText("Native user 76", { exact: true }),
    ).toBeVisible();
    await row.click();
    await expect(chat).toHaveAttribute("data-pane", "side");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Recent opens a native conversation and both clients continue it", async ({
  page,
}) => {
  test.skip(process.platform === "win32", "This fixture uses a Unix socket");
  const { url, scope } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
  const detailRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/details/")) detailRequests.push(request.url());
  });
  await page.goto(url);
  await expect(
    page.getByRole("tab", { name: "最近", exact: true }),
  ).toBeVisible();
  const { homeDir } = (await (
    await page.request.get("/api/overview")
  ).json()) as Overview;
  const id = randomUUID();
  const title = `Native conversation ${id.slice(0, 6)}`;
  const opening = `Inspect the attached image ${id.slice(0, 6)}`;
  const root = join(homeDir, ".claude");
  const project = join(root, "projects", `shared-${id}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  const transcript = join(project, `${id}.jsonl`);
  const socketDir = mkdtempSync(join(tmpdir(), "lever-peer-"));
  const socketPath = join(socketDir, `${process.pid}.sock`);
  const sessionFile = join(root, "sessions", `${process.pid}.json`);
  const setStatus = (status: string, reachable = true) =>
    writeFileSync(
      sessionFile,
      JSON.stringify({
        sessionId: id,
        status,
        ...(reachable && { messagingSocketPath: socketPath, peerProtocol: 1 }),
      }),
    );
  const log = (
    role: "user" | "assistant",
    content: string | Record<string, unknown>[],
    origin?: { kind: "peer"; body: string },
  ) => {
    appendFileSync(
      transcript,
      JSON.stringify({
        type: role,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: id,
        cwd: scope,
        entrypoint: "cli",
        isMeta: !!origin,
        message: { content },
        origin,
      }) + "\n",
    );
  };
  const imageBlock = {
    type: "image",
    fixturePadding: " ".repeat(128 << 10), // exercise image lookup across read chunks
    source: {
      type: "base64",
      media_type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    },
  };
  log("user", [{ type: "text", text: opening }, imageBlock]);
  log("assistant", "I will inspect the image.");
  log("assistant", [
    { type: "thinking", thinking: "Inspect the attachment." },
    {
      type: "tool_use",
      name: "Read",
      id: "toolu_fixture",
      input: { file_path: "reference.png" },
    },
  ]);
  log("user", [
    {
      type: "tool_result",
      tool_use_id: "toolu_fixture",
      content: [{ type: "text", text: "Image read successfully." }, imageBlock],
    },
  ]);
  log("assistant", "We can continue here.");
  log("assistant", [{ type: "thinking", thinking: "Trailing activity." }]);
  const received: { session_id: string; message: { content: string } }[] = [];
  const original = createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("end", () => {
      const command = JSON.parse(text.trim()) as (typeof received)[number];
      received.push(command);
      const body = command.message.content.split("\n").slice(1, -1).join("\n");
      log("user", "", { kind: "peer", body });
      log("assistant", "The original application answered.");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      original.once("error", reject);
      original.listen(socketPath, resolve);
    });
    setStatus("idle");
    await page.getByRole("tab", { name: "最近", exact: true }).click();
    const recent = page.getByRole("tabpanel", { name: "最近" });
    await expect(recent.getByText(opening, { exact: true })).toBeVisible();
    appendFileSync(
      transcript,
      JSON.stringify({ type: "ai-title", aiTitle: title, sessionId: id }) +
        "\n",
    );
    const row = recent.getByRole("button", { name: new RegExp(title) });
    const chat = page.getByRole("tabpanel", { name: title, exact: true });
    await expect(row).toContainText("We can continue here.");
    await expect(row).not.toContainText("Claude Code");
    const icon = row.locator('.contact-name [data-icon="inline-start"]');
    await expect(icon).toHaveAttribute("width", "12");
    await expect(icon).toHaveAttribute("height", "12");
    await expect(row.locator(".conversation-origin svg, time")).toHaveCount(0);
    await row.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "打开会话",
      "置顶到「最近」",
    ]);
    await page.getByRole("menuitem", { name: "打开会话" }).click();
    await expect(
      page.getByRole("tab", { name: title, exact: true }),
    ).toBeVisible();
    await expect(chat.getByText("We can continue here.")).toBeVisible();
    const activity = page.getByRole("button", {
      name: /^(执行过程|用时 .+)$/,
    });
    await expect(activity).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("I will inspect the image.")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Read", exact: true }),
    ).toBeHidden();
    const userPhoto = page.locator(".user-message .attachment-image img");
    await expect(userPhoto).toHaveJSProperty("naturalWidth", 1);
    const openPhoto = page
      .locator(".user-message")
      .getByRole("button", { name: "图片 1", exact: true });
    await openPhoto.click();
    const preview = page.getByRole("region", { name: "图片预览", exact: true });
    await expect(preview.getByRole("img")).toHaveJSProperty("naturalWidth", 1);
    await preview.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(preview).toBeHidden();
    await activity.click();
    await expect(page.getByText("I will inspect the image.")).toBeVisible();
    const tool = page.getByRole("button", { name: "Read", exact: true });
    expect(detailRequests).toHaveLength(0);
    await tool.click();
    await expect(
      page.getByText("Image read successfully.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.locator(".run-work .attachment-image img"),
    ).toHaveJSProperty("naturalWidth", 1);
    expect(detailRequests).toHaveLength(2);
    await activity.click();

    log("user", "Reply sent in the native app");
    await expect(chat.getByText("Reply sent in the native app")).toBeVisible();
    setStatus("busy", false);
    const priorityRow = recent
      .getByRole("region", { name: "优先", exact: true })
      .getByRole("button", { name: new RegExp(title) });
    const running = page.locator('.run-content[data-status="running"]');
    await expect(running.getByText(/^已运行 /)).toBeVisible();
    await expect(
      priorityRow.getByRole("img", { name: "正在执行" }),
    ).toBeVisible();
    await expect(priorityRow).toContainText("Reply sent in the native app");
    log("assistant", [{ type: "tool_use", id: "toolu_live", name: "Grep" }]);
    await expect(running.getByText("· Grep", { exact: true })).toBeVisible();

    setStatus("waiting");
    await expect(
      priorityRow.getByRole("img", { name: "待你处理" }),
    ).toBeVisible();
    await expect(
      page
        .locator('.run-content[data-status="waiting_user"]')
        .getByText("待你处理"),
    ).toBeVisible();

    log("user", [
      {
        type: "tool_result",
        tool_use_id: "toolu_live",
        content: "Found the file.",
      },
    ]);
    log("assistant", "Native run finished.");
    setStatus("idle");
    await expect(chat.getByText("Native run finished.")).toBeVisible();
    await expect(running).toHaveCount(0);
    await expect(priorityRow).toHaveCount(0);
    await expect(row).toContainText("Native run finished.");

    const composer = page.locator(".chat-composer-wrap");
    const editor = composer.getByRole("textbox", {
      name: "发送消息",
      exact: true,
    });
    await openPhoto.click();
    await expect(preview).toBeVisible();
    await editor.fill("Reply sent in Lever");
    await composer.getByRole("button", { name: "发送", exact: true }).click();
    await expect(preview).toBeHidden();
    await expect(
      chat.getByText("The original application answered."),
    ).toBeVisible();
    expect(received).toHaveLength(1);
    expect(received[0].session_id).toBe(id);
    await expect(
      page
        .locator(".user-message")
        .getByText("Reply sent in Lever", { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveText("");

    await editor.fill("Keep this unsent draft");
    rmSync(sessionFile);
    await expect(
      composer.getByRole("button", { name: "发送", exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect(editor).toHaveText("Keep this unsent draft");
    await expect(
      page.getByRole("tab", { name: title, exact: true }),
    ).toHaveCount(1);

    // Vite can update the renderer while the running desktop still serves
    // history in the original text-only format.
    await page.route(`**/api/shared-conversations/*/${id}?*`, async (route) => {
      const response = await route.fetch();
      const history: SharedHistory = await response.json();
      await route.fulfill({
        response,
        json: {
          ...history,
          messages: history.messages
            .filter(({ text }) => text)
            .map(({ id, role, text, createdAt }) => ({
              id,
              role,
              text,
              createdAt,
            })),
        },
      });
    });
    await page.reload();
    await expect(chat.getByText("We can continue here.")).toBeVisible();
    await expect(
      chat.getByText("The original application answered."),
    ).toBeVisible();
    await expect(page.getByText("I will inspect the image.")).toBeHidden();
  } finally {
    await new Promise<void>((resolve) => original.close(() => resolve()));
    rmSync(sessionFile, { force: true });
    rmSync(socketDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
