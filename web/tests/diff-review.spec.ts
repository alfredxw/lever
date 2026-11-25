import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Overview } from "../src/api/types.gen";

function context() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    scope: string;
    otherScope: string;
  };
}

function runGit(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

function initTempRepo(dir: string, branch = "main") {
  runGit(dir, ["init", "-q", "-b", branch]);
  runGit(dir, ["config", "user.name", "Fixture"]);
  runGit(dir, ["config", "user.email", "fixture@example.invalid"]);
}

function commitFile(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  runGit(dir, ["add", file]);
  runGit(dir, ["commit", "-qm", msg]);
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

async function clickGutterPlusForLine(
  page: Page,
  filePath: string,
  lineNumber: number,
) {
  const container = page
    .locator("diffs-container")
    .filter({ has: page.locator(`header.diff-file-header[data-path="${filePath}"]`) });
  await expect(container).toBeVisible();
  const lineCell = container
    .locator(`[data-column-number="${lineNumber}"]`)
    .last();
  await expect(lineCell).toBeVisible();
  await lineCell.hover();
  const plus = container.locator("[data-utility-button]");
  await expect(plus).toBeVisible();
  await plus.click();
}

test("supports batch inline review comments, viewed markers, stale detection, and composer submission across working and branch Diff modes", async ({
  page,
}) => {
  const { otherScope } = context();
  const temp = mkdtempSync(join(tmpdir(), "lever-diff-review-"));
  const repo = join(temp, "review-repo");
  try {
    execFileSync("mkdir", ["-p", repo]);
    initTempRepo(repo, "main");
    commitFile(
      repo,
      "alpha.ts",
      [
        "export function greet(name: string) {",
        "  const trimmed = name.trim();",
        "  return `Hello, ${trimmed}`;",
        "}",
        "",
      ].join("\n"),
      "Initial alpha",
    );
    commitFile(
      repo,
      "beta.ts",
      [
        "export function add(a: number, b: number) {",
        "  return a + b;",
        "}",
        "",
      ].join("\n"),
      "Initial beta",
    );

    // Create feature branch with a committed change for branch-diff review verification
    runGit(repo, ["checkout", "-qb", "feature/review"]);
    commitFile(
      repo,
      "branch.ts",
      ["export const branchFlag = true;", "export const version = 2;", ""].join(
        "\n",
      ),
      "Add branch file",
    );

    // Uncommitted working changes across two files
    writeFileSync(
      join(repo, "alpha.ts"),
      [
        "export function greet(name: string) {",
        "  const trimmed = name.trim();",
        "  if (!trimmed) return 'Hello!';",
        "  return `Hi, ${trimmed}!`;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(repo, "beta.ts"),
      [
        "export function add(a: number, b: number) {",
        "  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;",
        "  return a + b;",
        "}",
        "",
      ].join("\n"),
    );

    await createAgent(page, "批量审阅测试", otherScope);
    const overview = (await (
      await page.request.get("/api/overview")
    ).json()) as Overview;
    const agent = overview.agents.find((item) => item.name === "批量审阅测试")!;
    const updated = await page.request.put(`/api/agents/${agent.id}`, {
      data: {
        ...agent,
        profile: {
          ...agent.profile,
          primaryRootId: "repo",
          roots: [{ id: "repo", path: repo }],
        },
      },
    });
    expect(updated.ok(), await updated.text()).toBeTruthy();

    // Open uncommitted (working) diff via top-bar Git status popover
    await page.getByRole("button", { name: "Git 状态", exact: true }).click();
    await page.locator(".git-status-popover .git-status-action-row").click();
    await expect(
      page.getByRole("button", { name: "变更范围", exact: true }),
    ).toContainText("未提交");
    await expect(
      page.locator('header.diff-file-header[data-path="alpha.ts"]'),
    ).toBeVisible();
    await expect(
      page.locator('header.diff-file-header[data-path="beta.ts"]'),
    ).toBeVisible();

    // 1. Add inline comment on alpha.ts via gutter '+' button and keyboard shortcut save
    await clickGutterPlusForLine(page, "alpha.ts", 3);
    const editor = page.locator(".diff-annotation-editor textarea");
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await editor.fill("空字符串场景建议直接抛出校验错误");
    await editor.press("ControlOrMeta+Enter");
    await expect(editor).toHaveCount(0);
    await expect(page.locator(".diff-annotation-body").first()).toHaveText(
      "空字符串场景建议直接抛出校验错误",
    );

    // 2. Edit the saved comment in place
    await page.getByRole("button", { name: "编辑批注", exact: true }).click();
    const editBox = page.locator(".diff-annotation-editor textarea");
    await expect(editBox).toBeVisible();
    await editBox.fill("空字符串场景应显式返回默认称呼或抛错");
    await page
      .locator(".diff-annotation-editor")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.locator(".diff-annotation-body").first()).toHaveText(
      "空字符串场景应显式返回默认称呼或抛错",
    );

    // 3. Add a second comment on beta.ts via line number selection -> header "添加批注"
    const betaContainer = page
      .locator("diffs-container")
      .filter({ has: page.locator('header.diff-file-header[data-path="beta.ts"]') });
    await betaContainer.locator('[data-column-number="2"]').last().click();
    const betaHeader = page.locator(
      'header.diff-file-header[data-path="beta.ts"]',
    );
    await expect(
      betaHeader.getByRole("button", { name: "添加批注", exact: true }),
    ).toBeVisible();
    await expect(
      betaHeader.getByRole("button", { name: "反馈这段变更", exact: true }),
    ).toBeVisible();
    await betaHeader
      .getByRole("button", { name: "添加批注", exact: true })
      .click();
    const betaEditor = page.locator(".diff-annotation-editor textarea");
    await expect(betaEditor).toBeVisible();
    await betaEditor.fill("NaN 或 Infinity 静默返回 0 可能掩盖上游问题");
    await page
      .locator(".diff-annotation-editor")
      .getByRole("button", { name: "保存批注", exact: true })
      .click();

    await expect(
      page.getByRole("button", { name: "提交审阅 (2)", exact: true }),
    ).toBeVisible();

    // Verify no focus ring/glow on review buttons
    const submitForFocus = page.getByRole("button", {
      name: "提交审阅 (2)",
      exact: true,
    });
    await submitForFocus.focus();
    const submitFocusStyle = await submitForFocus.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outlineStyle: s.outlineStyle, boxShadow: s.boxShadow };
    });
    expect(submitFocusStyle.outlineStyle).toBe("none");
    expect(submitFocusStyle.boxShadow).toBe("none");

    // Capture visual check screenshots in light and dark themes
    await page.screenshot({ path: "../output/e2e/diff-review-inline.png" });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: "../output/e2e/diff-review-dark.png" });
    await page.evaluate(() =>
      document.documentElement.classList.remove("dark"),
    );

    // 4. Mark alpha.ts as viewed -> collapses file & updates sidebar progress (1/2)
    const alphaHeader = page.locator(
      'header.diff-file-header[data-path="alpha.ts"]',
    );
    const alphaViewed = alphaHeader.locator(".diff-viewed-toggle");
    await alphaViewed.click();
    await expect(alphaViewed).toHaveAttribute("aria-pressed", "true");
    await expect(alphaHeader.locator(".diff-file-title")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(page.locator(".diff-list-heading")).toContainText("1/2");

    // 5. Reload page -> verify comments and viewed state persist from localStorage
    await page.reload();
    await expect(
      page.getByRole("button", { name: "提交审阅 (2)", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('header.diff-file-header[data-path="alpha.ts"]')
        .locator(".diff-viewed-toggle"),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".diff-list-heading")).toContainText("1/2");

    // 6. Modify alpha.ts on disk and refresh -> viewed resets & stale anchor is flagged as Outdated
    writeFileSync(
      join(repo, "alpha.ts"),
      [
        "export function greet(name: string) {",
        "  const trimmed = name.trim();",
        "  const fallback = 'Guest';",
        "  return `Hi, ${trimmed || fallback}!`;",
        "}",
        "",
      ].join("\n"),
    );
    await page.getByRole("button", { name: "刷新变更", exact: true }).click();
    await expect(
      page
        .locator('header.diff-file-header[data-path="alpha.ts"]')
        .locator(".diff-viewed-toggle"),
    ).toHaveAttribute("aria-pressed", "false");

    await page
      .getByRole("button", { name: "2 条审阅批注", exact: true })
      .click();
    const reviewPopover = page.locator(".diff-review-popover");
    await expect(reviewPopover).toBeVisible();
    await expect(reviewPopover).toContainText("已变更");
    await expect(reviewPopover).toContainText(
      "NaN 或 Infinity 静默返回 0 可能掩盖上游问题",
    );
    await page.keyboard.press("Escape");

    // 7. Switch to branch comparison mode -> independent scope supports commenting too
    await page.getByRole("button", { name: "变更范围", exact: true }).click();
    await page
      .getByRole("menuitemradio", { name: "分支", exact: true })
      .click();
    await expect(
      page.locator('header.diff-file-header[data-path="branch.ts"]'),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "提交审阅 (2)", exact: true }),
    ).toHaveCount(0);

    await clickGutterPlusForLine(page, "branch.ts", 2);
    const branchEditor = page.locator(".diff-annotation-editor textarea");
    await expect(branchEditor).toBeVisible();
    await branchEditor.fill("版本号请改为读取构建常量");
    await branchEditor.press("ControlOrMeta+Enter");
    await expect(
      page.getByRole("button", { name: "提交审阅 (1)", exact: true }),
    ).toBeVisible();

    // 8. Switch back to uncommitted mode and submit the 2 accumulated comments to Composer
    await page.getByRole("button", { name: "变更范围", exact: true }).click();
    await page
      .getByRole("menuitemradio", { name: "未提交", exact: true })
      .click();
    const submitBtn = page.getByRole("button", {
      name: "提交审阅 (2)",
      exact: true,
    });
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    const composer = page.getByRole("textbox", {
      name: "发送消息",
      exact: true,
    });
    await expect(composer).toContainText("代码审阅 · 未提交（2 条批注）");
    await expect(composer).toContainText("alpha.ts");
    await expect(composer).toContainText("空字符串场景应显式返回默认称呼或抛错");
    await expect(composer).toContainText("beta.ts");
    await expect(composer).toContainText(
      "NaN 或 Infinity 静默返回 0 可能掩盖上游问题",
    );
    await expect(submitBtn).toHaveCount(0);

    // 9. Undo button in toast restores submitted comments
    const undoBtn = page.getByRole("button", { name: "撤销", exact: true });
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();
    await expect(
      page.getByRole("button", { name: "提交审阅 (2)", exact: true }),
    ).toBeVisible();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
