import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Overview } from "../src/api/types.gen";

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
  return runGit(dir, ["rev-parse", "HEAD"]);
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

test("top-bar Git status popover shows uncommitted stats, repos, and jumps to Diff in single and split views", async ({
  page,
}) => {
  const { otherScope } = context();
  const temp = mkdtempSync(join(tmpdir(), "lever-git-status-"));
  const repoA = join(temp, "alpha-repo");
  const repoB = join(temp, "beta-repo");
  try {
    execFileSync("mkdir", ["-p", repoA, repoB]);

    initTempRepo(repoA, "feature/git-popover");
    const commitsA: string[] = [];
    for (let i = 1; i <= 7; i++) {
      commitsA.push(
        commitFile(
          repoA,
          "app.txt",
          `line 1\nline 2\nversion ${i}\n`,
          `Commit A-${i}`,
        ),
      );
    }
    // Uncommitted edits in repoA: replace 1 line and add 2 lines (+3 -1) plus 1 untracked line (+1) => +4 -1 across 2 files
    writeFileSync(
      join(repoA, "app.txt"),
      "line 1\nline 2\nversion updated\nextra one\nextra two\n",
    );
    writeFileSync(join(repoA, "notes.txt"), "brand new note\n");

    initTempRepo(repoB, "main");
    const commitB1 = commitFile(repoB, "readme.md", "# Beta\n", "Init Beta");

    // 1. Non-Git scope hides Git status control
    await createAgent(page, "Git 面板测试", otherScope);
    const gitTrigger = page.getByRole("button", {
      name: "Git 状态",
      exact: true,
    });
    await expect(gitTrigger).toHaveCount(0);

    // 2. Attach both Git repos to the Agent's Scope
    const overview = (await (
      await page.request.get("/api/overview")
    ).json()) as Overview;
    const agent = overview.agents.find((item) => item.name === "Git 面板测试")!;
    const updated = await page.request.put(`/api/agents/${agent.id}`, {
      data: {
        ...agent,
        profile: {
          ...agent.profile,
          primaryRootId: "alpha",
          roots: [
            { id: "alpha", path: repoA },
            { id: "beta", path: repoB },
          ],
        },
      },
    });
    expect(updated.ok(), await updated.text()).toBeTruthy();

    // Trigger appears with aggregated +4 −1 stats, replaces standalone Diff button, and sits before More tools with no dividers
    await expect(gitTrigger).toBeVisible();
    await expect(gitTrigger).toContainText("+4");
    await expect(gitTrigger).toContainText("−1");
    await expect(
      page.getByRole("button", { name: "变更", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator(".workspace-panel-controls .tab-action-divider"),
    ).toHaveCount(0);

    const mainStrip = page.locator('.tab-strip[data-pane="main"]');
    const notesButton = mainStrip.getByRole("button", {
      name: "笔记",
      exact: true,
    });
    const moreTools = mainStrip.getByRole("button", {
      name: "更多工具",
      exact: true,
    });
    const sideToggle = page.getByRole("button", {
      name: "展开侧边分栏",
      exact: true,
    });
    const notesBox = (await notesButton.boundingBox())!;
    const gitBox = (await gitTrigger.boundingBox())!;
    const moreBox = (await moreTools.boundingBox())!;
    const sideToggleBox = (await sideToggle.boundingBox())!;
    expect(notesBox.x + notesBox.width).toBeLessThanOrEqual(gitBox.x + 1);
    expect(gitBox.x + gitBox.width).toBeLessThanOrEqual(moreBox.x + 1);
    expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(sideToggleBox.x + 1);

    // Focus-visible has no ring/outline glow
    await gitTrigger.focus();
    const focusStyle = await gitTrigger.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outlineStyle: s.outlineStyle, boxShadow: s.boxShadow };
    });
    expect(focusStyle.outlineStyle).toBe("none");
    expect(focusStyle.boxShadow).toBe("none");

    // 3. Open popover in single-column mode
    await gitTrigger.click();
    const popover = page.locator(".git-status-popover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("代码仓库");
    await expect(popover).toContainText("feature/git-popover");
    await expect(popover).toContainText("未提交改动");
    await expect(popover).toContainText("2 个改动文件");
    // Shows 5 recent commits initially, expandable to 7
    const commitRows = popover.locator(".git-status-commit-row");
    await expect(commitRows).toHaveCount(5);
    await expect(commitRows.first()).toContainText("Commit A-7");
    await expect(commitRows.first().locator("time")).toHaveCount(1);
    await popover.getByRole("button", { name: "再显示 2 条提交" }).click();
    await expect(commitRows).toHaveCount(7);
    await popover.getByRole("button", { name: "收起提交列表" }).click();
    await expect(commitRows).toHaveCount(5);

    // 4. Switch to second repo (clean) inside the popover and jump to its commit diff
    await popover.getByRole("option", { name: /beta-repo/ }).click();
    await expect(popover).toContainText("工作区无改动");
    await expect(commitRows).toHaveCount(1);
    await expect(commitRows.first()).toContainText("Init Beta");

    const commitDiffRequest = page.waitForResponse(
      (res) =>
        res.url().includes(`/agents/${agent.id}/diff?`) &&
        new URL(res.url()).searchParams.get("mode") === "committed" &&
        new URL(res.url()).searchParams.get("root") === "beta" &&
        new URL(res.url()).searchParams.get("head") === commitB1,
    );
    await commitRows.first().click();
    expect((await commitDiffRequest).ok()).toBeTruthy();
    await expect(popover).not.toBeVisible();
    await expect(page.locator(".diff-commit-hash")).toHaveText(
      commitB1.slice(0, 7),
    );

    // 5. Commit click opened Diff in the side pane (dual-column split view); verify Git status stays accessible & jumps to working diff
    await expect(gitTrigger).toBeVisible();
    await expect(gitTrigger).toContainText("+4");
    await expect(gitTrigger).toContainText("−1");
    await expect(
      page.locator(".workspace-panel-controls .tab-action-divider"),
    ).toHaveCount(0);

    const sideAdd = page
      .locator('.tab-strip[data-pane="side"]')
      .getByRole("button", { name: "打开标签", exact: true });
    const maximizeButton = page.getByRole("button", {
      name: "最大化面板",
      exact: true,
    });
    await expect(sideAdd).toBeVisible();
    const sideAddBox = (await sideAdd.boundingBox())!;
    const splitGitBox = (await gitTrigger.boundingBox())!;
    const maximizeBox = (await maximizeButton.boundingBox())!;
    expect(sideAddBox.x + sideAddBox.width).toBeLessThanOrEqual(
      splitGitBox.x + 1,
    );
    expect(splitGitBox.x + splitGitBox.width).toBeLessThanOrEqual(
      maximizeBox.x + 1,
    );

    await gitTrigger.click();
    await expect(popover).toBeVisible();
    await popover.getByRole("option", { name: /alpha-repo/ }).click();
    const workingDiffRequest = page.waitForResponse(
      (res) =>
        res.url().includes(`/agents/${agent.id}/diff?`) &&
        new URL(res.url()).searchParams.get("mode") === "working" &&
        new URL(res.url()).searchParams.get("root") === "alpha",
    );
    await popover.locator(".git-status-action-row").click();
    expect((await workingDiffRequest).ok()).toBeTruthy();
    await expect(popover).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "变更范围", exact: true }),
    ).toContainText("未提交");

    // 6. Collapse back to single-column view and verify Git status returns before More tools with no overlap
    await page.getByRole("button", { name: "收起侧边分栏", exact: true }).click();
    await expect(gitTrigger).toBeVisible();
    await expect(gitTrigger).toContainText("+4");
    const collapsedGitBox = (await gitTrigger.boundingBox())!;
    const collapsedMoreBox = (await moreTools.boundingBox())!;
    const collapsedSideBox = (await sideToggle.boundingBox())!;
    expect(collapsedGitBox.x + collapsedGitBox.width).toBeLessThanOrEqual(
      collapsedMoreBox.x + 1,
    );
    expect(collapsedMoreBox.x + collapsedMoreBox.width).toBeLessThanOrEqual(
      collapsedSideBox.x + 1,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
