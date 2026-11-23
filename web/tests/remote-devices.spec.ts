import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { InboxItem, Record as Shared } from "../src/api/hub.gen";

test("dispatch from desktop, answer on mobile and accept the same Run", async ({
  page,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const fixture = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
  const fixtureURL = new URL(fixture.url);
  const host = async (path: string, body: unknown) => {
    const response = await page.request.post(
      fixtureURL.origin + "/api" + path,
      {
        headers: {
          Authorization:
            "Bearer " +
            new URLSearchParams(fixtureURL.hash.slice(1)).get("token"),
        },
        data: body,
      },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const temp = mkdtempSync(join(tmpdir(), "lever-hub-browser-"));
  const binary = join(
    temp,
    "lever-hub" + (process.platform === "win32" ? ".exe" : ""),
  );
  const dataDir = join(temp, "hub"),
    password = randomUUID();
  // The existing Playwright Host fixture provides the isolated test provider.
  // Build the Hub's embedded renderer independently from the desktop bundle.
  if (!existsSync("hubassets/dist/hub.html"))
    execFileSync("pnpm", ["exec", "vite", "build", "--mode", "hub"], {
      stdio: "pipe",
    });
  execFileSync("go", ["build", "-o", binary, "./cmd/lever-hub"], {
    cwd: resolve(".."),
  });
  execFileSync(
    binary,
    ["setup", "--data-dir", dataDir, "--user", "owner", "--password-stdin"],
    { input: password + "\n" },
  );
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = "127.0.0.1:" + (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const origin = "http://" + address;
  const hub = spawn(binary, ["--data-dir", dataDir, "--listen", address], {
    stdio: "ignore",
  });
  const ended = once(hub, "exit");
  let scope: { hubId: string; spaceId: string } | undefined;
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(origin + "/healthz")).ok;
        } catch {
          return false;
        }
      })
      .toBe(true);
    await page.goto(origin);
    await page.getByLabel("账号").fill("owner");
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "工作区" }),
    ).toBeVisible();
    const me = await (await page.request.get(origin + "/api/me")).json();
    const path = origin + "/api/spaces/" + me.spaces[0].id;
    const ticket = await (
      await page.request.post(path + "/tickets", { data: { role: "executor" } })
    ).json();
    scope = await host("/remote", {
      action: "pair",
      pair: {
        hub: origin,
        code: ticket.code,
        role: "executor",
        name: "Test Host",
      },
    });
    const agent = await host("/agents", {
      name: "Remote fixture",
      profile: {
        provider: "codex",
        permission: "ask",
        roots: [{ id: "test", path: fixture.scope }],
        primaryRootId: "test",
      },
    });
    await host("/remote", { action: "expose", scope, agentId: agent.id });
    const bindings = await host("/remote", { action: "status" });
    const device = bindings.find(
      (b: { hubId: string }) => b.hubId === scope!.hubId,
    ).deviceId;
    const confirm = async (kind: string) => {
      let found: InboxItem | undefined;
      await expect
        .poll(async () => {
          const items: InboxItem[] = await host("/remote", {
            action: "inbox",
            scope,
          });
          found = items.find((i) => i.intent.kind === kind);
          return !!found;
        })
        .toBe(true);
      return host("/remote", { action: "accept", scope, id: found!.intent.id });
    };
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "新建任务", exact: true }).click();
    await page.getByLabel("标题", { exact: true }).fill("设备审批回归");
    await page
      .getByLabel("正文", { exact: true })
      .fill("Run the fixture [approval]");
    await page.getByRole("button", { name: "创建任务", exact: true }).click();
    await page
      .getByRole("combobox", { name: "执行设备", exact: true })
      .selectOption(device);
    await page
      .getByRole("combobox", { name: "Agent", exact: true })
      .selectOption(agent.id);
    await page.getByRole("button", { name: "确认派发", exact: true }).click();
    const receipt = await confirm("dispatch_task");
    const taskURL = page.url();
    await page.getByRole("button", { name: "打开 Chat", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "允许一次", exact: true }).click();
    await confirm("answer");
    await expect(
      page.getByText("已回答", { exact: false }).first(),
    ).toBeVisible();
    const archive: Shared[] = await (
      await page.request.get(
        path + "/archive/" + device + "?chat=" + receipt.chatId,
      )
    ).json();
    const answered = archive.find(
      (r) =>
        r.kind === "request" &&
        r.runId === receipt.runId &&
        r.status === "answered",
    )!;
    expect(answered).toBeTruthy();
    await page.goto(
      origin +
        "/s/" +
        scope.spaceId +
        "/devices/" +
        device +
        "/chats/" +
        receipt.chatId +
        "/requests/" +
        answered.id,
    );
    const card = page.locator("#hub-record-" + answered.id);
    await expect(card).toContainText("已回答");
    await expect(card.getByRole("button")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(taskURL);
    await page.getByRole("button", { name: "验收", exact: true }).click();
    const taskId = new URL(taskURL).pathname.split("/").at(-1);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(path + "/tasks/" + taskId)).json())
            .task.acceptedRunId,
      )
      .toBe(receipt.runId);
    await page.getByRole("button", { name: "打开 Chat", exact: true }).click();
    await page
      .getByRole("button", { name: "从对话创建任务", exact: true })
      .click();
    await page.getByLabel("标题", { exact: true }).fill("来源对话任务");
    await page.getByLabel("项目标签", { exact: true }).fill("移动协作");
    await page.getByRole("button", { name: "创建任务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "打开来源对话", exact: true }),
    ).toBeVisible();
    const linkedId = new URL(page.url()).pathname.split("/").at(-1);
    const linked = await (
      await page.request.get(path + "/tasks/" + linkedId)
    ).json();
    expect(linked.task.source.chatId).toBe(receipt.chatId);
    expect(linked.task.project).toBe("移动协作");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "关闭任务", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(path + "/tasks/" + linkedId)).json())
            .task.status,
      )
      .toBe("closed");
  } finally {
    try {
      if (scope) await host("/remote", { action: "unpair", scope });
    } finally {
      hub.kill();
      await ended;
      rmSync(temp, { recursive: true, force: true });
    }
  }
});
