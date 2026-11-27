import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Agent, Catalog } from "../src/api/types.gen";

function context() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    bin: string;
    scope: string;
  };
}

async function startFreshServer(bin: string) {
  const temp = mkdtempSync(join(tmpdir(), "lever-first-launch-"));
  const dataDir = join(temp, "data");
  const homeDir = join(temp, "home");
  mkdirSync(homeDir, { recursive: true });
  const ext = process.platform === "win32" ? ".exe" : "";
  const child = spawn(
    join(bin, `lever${ext}`),
    ["--data-dir", dataDir, "--listen", "127.0.0.1:0"],
    {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: join(homeDir, ".codex"),
        CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        LEVER_CODEX_PATH: join(bin, `codex${ext}`),
        LEVER_CLAUDE_PATH: join(bin, `claude${ext}`),
        LEVER_ANTIGRAVITY_PATH: join(bin, `agy${ext}`),
        LEVER_PI_PATH: join(bin, `pi${ext}`),
        LEVER_DSH_PATH: join(bin, `dsh${ext}`),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await new Promise<string>((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`Fresh lever server timed out: ${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Lever: (http[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fresh lever server exited early (${code}): ${stderr}`));
    });
  });
  return {
    url,
    close: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolveClose();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolveClose();
        });
      });
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

test("first launch offers Auto vs YOLO, applies across runtimes, and can be adjusted in Settings", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { bin } = context();
  const fresh = await startFreshServer(bin);
  try {
    await page.goto(fresh.url);
    const setupDialog = page.getByRole("dialog", { name: "选择默认权限模式" });
    await expect(setupDialog).toBeVisible();

    const radioGroup = setupDialog.getByRole("radiogroup", {
      name: "选择默认权限模式",
    });
    await expect(
      radioGroup.getByRole("radio", { name: /Auto/ }),
    ).toBeChecked();

    await page.waitForTimeout(200);
    await page.screenshot({
      path: "../output/e2e/permission-setup-light.png",
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: "../output/e2e/permission-setup-dark.png",
    });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await page.waitForTimeout(200);

    // Choose YOLO on first launch.
    await radioGroup.getByRole("radio", { name: /YOLO/ }).click();
    await expect(
      radioGroup.getByRole("radio", { name: /YOLO/ }),
    ).toBeChecked();
    const saveSetup = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/settings/permissions") &&
        res.request().method() === "PUT",
    );
    await setupDialog.getByRole("button", { name: "开始使用" }).click();
    expect((await saveSetup).ok()).toBeTruthy();
    await expect(setupDialog).toBeHidden();

    // Starter Agent ("Lever") immediately reflects YOLO full access, and reload does not re-prompt.
    const composer = page.locator(".chat-composer-wrap:visible");
    await expect(
      composer.getByRole("button", { name: /^权限 · 完全访问/ }),
    ).toBeVisible();
    await page.reload();
    await expect(setupDialog).toHaveCount(0);
    await expect(
      composer.getByRole("button", { name: /^权限 · 完全访问/ }),
    ).toBeVisible();

    // Switching runtimes in Composer adopts each runtime's YOLO equivalent.
    const modelTrigger = composer.getByRole("button", {
      name: "选择模型和运行时",
    });
    const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
    const rail = picker.getByRole("radiogroup", { name: "运行时", exact: true });

    await modelTrigger.click();
    await rail.getByRole("radio", { name: "Antigravity", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 极速/ }),
    ).toBeVisible();

    await rail.getByRole("radio", { name: "Claude Code", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 完全访问/ }),
    ).toBeVisible();

    await rail.getByRole("radio", { name: "Pi", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 完全访问/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // Settings -> General shows YOLO and lets the user switch to Auto.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settingsPerm = page.getByRole("radiogroup", {
      name: "默认权限模式",
    });
    await expect(
      settingsPerm.getByRole("radio", { name: "YOLO", exact: true }),
    ).toBeChecked();
    await settingsPerm.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "../output/e2e/settings-permissions.png",
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: "../output/e2e/settings-permissions-dark.png",
    });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);

    const saveAuto = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/settings/permissions") &&
        res.request().method() === "PUT",
    );
    await settingsPerm.getByRole("radio", { name: "Auto", exact: true }).click();
    expect((await saveAuto).ok()).toBeTruthy();
    await expect(
      settingsPerm.getByRole("radio", { name: "Auto", exact: true }),
    ).toBeChecked();

    // After switching to Auto, Composer reflects Auto equivalents across runtimes.
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 自动接受编辑/ }),
    ).toBeVisible();

    await modelTrigger.click();
    await rail.getByRole("radio", { name: "Codex", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 代我审批/ }),
    ).toBeVisible();

    await rail.getByRole("radio", { name: "Claude Code", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 自动/ }),
    ).toBeVisible();

    await rail.getByRole("radio", { name: "Antigravity", exact: true }).click();
    await expect(
      composer.getByRole("button", { name: /^权限 · 自动/ }),
    ).toBeVisible();
  } finally {
    await fresh.close();
  }
});

test("model switching maps effort by user habit (Carbon high / Neon xhigh -> GPT max, ultra separate)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { url, scope } = context();

  const agyCatalog: Catalog = {
    provider: "antigravity",
    defaultPermission: "auto",
    permissions: [
      { id: "request-review", name: "", mode: "request_review" },
      { id: "default", name: "", mode: "ask" },
      { id: "auto", name: "", mode: "auto" },
      { id: "turbo", name: "", mode: "full_access" },
    ],
    capabilities: {
      steering: false,
      images: true,
      files: true,
      multiRoot: true,
      mcp: true,
      skills: true,
      resume: true,
    },
    models: [
      {
        id: "gemini-carbon",
        name: "Gemini Carbon",
        default: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        fast: false,
      },
      {
        id: "gemini-neon",
        name: "Gemini Neon",
        default: false,
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
        fast: false,
      },
    ],
  };

  const codexCatalog: Catalog = {
    provider: "codex",
    defaultPermission: "auto_review",
    permissions: [
      { id: "ask", name: "", mode: "ask" },
      { id: "auto_review", name: "", mode: "auto" },
      { id: "full_access", name: "", mode: "full_access" },
    ],
    capabilities: {
      steering: true,
      images: true,
      files: true,
      multiRoot: true,
      mcp: true,
      skills: true,
      resume: true,
    },
    models: [
      {
        id: "gpt-6",
        name: "GPT-6",
        default: true,
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "medium",
        fast: true,
      },
      {
        id: "gpt-6-pro",
        name: "GPT-6 Pro",
        default: false,
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "medium",
        fast: true,
      },
    ],
  };

  await page.route("**/api/providers/antigravity/models*", (route) =>
    route.fulfill({ json: agyCatalog }),
  );
  await page.route("**/api/providers/codex/models*", (route) =>
    route.fulfill({ json: codexCatalog }),
  );

  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  const created = await page.request.post("/api/agents", {
    data: {
      name: "Effort Habit Agent",
      profile: {
        provider: "antigravity",
        model: "gemini-carbon",
        permission: "auto",
        instructions: "",
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
        skills: [],
        delegations: [],
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const agent = (await created.json()) as Agent;

  await page.reload();
  await page.getByRole("button", { name: agent.name, exact: true }).click();

  const composer = page.locator(".chat-composer-wrap:visible");
  const trigger = composer.getByRole("button", { name: "选择模型和运行时" });
  const picker = page.getByRole("dialog", { name: "选择模型和运行时" });
  const efforts = picker.getByRole("radiogroup", { name: "推理强度" });
  const rail = picker.getByRole("radiogroup", { name: "运行时", exact: true });

  // 1. Start on Carbon -> choose Carbon's top effort (high).
  await trigger.click();
  await efforts.getByRole("radio", { name: "高", exact: true }).click();
  await expect(trigger).toContainText("Gemini Carbon高");

  // 2. Same provider: Carbon (high, top) -> Neon (top=xhigh) => xhigh!
  await trigger.click();
  await picker.getByRole("button", { name: "Gemini Neon", exact: true }).click();
  await expect(
    efforts.getByRole("radio", { name: "更高", exact: true }),
  ).toBeChecked();
  await expect(trigger).toContainText("Gemini Neon更高");

  // 3. Same provider: Neon (xhigh, top) -> Carbon (top=high) => high!
  await picker
    .getByRole("button", { name: "Gemini Carbon", exact: true })
    .click();
  await expect(
    efforts.getByRole("radio", { name: "高", exact: true }),
  ).toBeChecked();
  await expect(trigger).toContainText("Gemini Carbon高");

  // 4. Cross-provider: Carbon (high, top) -> Codex GPT-6 (max + ultra) => max (NOT high, NOT ultra)!
  await rail.getByRole("radio", { name: "Codex", exact: true }).click();
  await expect(
    efforts.getByRole("radio", { name: "最大", exact: true }),
  ).toBeChecked();
  await expect(trigger).toContainText("GPT-6最大");

  // 5. Explicit ultra stays ultra on another model with ultra, and steps down to xhigh on Neon.
  await efforts.getByRole("radio", { name: "极高", exact: true }).click();
  await expect(trigger).toContainText("GPT-6极高");
  await trigger.click();
  await picker.getByRole("button", { name: "GPT-6 Pro", exact: true }).click();
  await expect(
    efforts.getByRole("radio", { name: "极高", exact: true }),
  ).toBeChecked();

  // Switch back to Antigravity Neon via Favorites -> ultra steps down to Neon's ceiling (xhigh).
  await page.evaluate(() => {
    localStorage.setItem("lever:starred-models:antigravity", '["gemini-neon"]');
  });
  await page.keyboard.press("Escape");
  await trigger.click();
  await rail.getByRole("radio", { name: "收藏", exact: true }).click();
  await picker
    .getByRole("button", { name: "Gemini Neon · Antigravity", exact: true })
    .click();
  await expect(
    efforts.getByRole("radio", { name: "更高", exact: true }),
  ).toBeChecked();
  await expect(trigger).toContainText("Gemini Neon更高");
});
