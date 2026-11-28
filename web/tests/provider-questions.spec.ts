import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Agent, Run } from "../src/api/types.gen";

function testFixture() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

async function createAgent(
  request: APIRequestContext,
  name: string,
  provider: string,
  scope: string,
): Promise<Agent> {
  const res = await request.post("/api/agents", {
    data: {
      name,
      profile: {
        provider,
        roots: [{ id: "root", path: scope }],
        primaryRootId: "root",
      },
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function sendMain(
  request: APIRequestContext,
  agentId: string,
  text: string,
  chatId?: string,
): Promise<Run> {
  const res = await request.post("/api/messages", {
    data: {
      commandId: crypto.randomUUID(),
      ...(chatId ? { chatId } : { agentId }),
      operation: "main",
      text,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function waitRunStatus(
  request: APIRequestContext,
  runId: string,
  status: string,
): Promise<Run> {
  let latest: Run | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/runs/${runId}`);
        expect(res.ok()).toBeTruthy();
        latest = (await res.json()) as Run;
        return latest.status;
      },
      { timeout: 15_000 },
    )
    .toBe(status);
  return latest!;
}

function runText(run: Run) {
  return run.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("\n");
}

test("docked provider question component works across Antigravity/ACP, Claude, Codex, and Pi", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { url, scope } = testFixture();
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);

  // 1. Antigravity ask_question (ACP elicitation/create) + interaction_*
  const agAgent = await createAgent(
    page.request,
    "Question Antigravity",
    "antigravity",
    scope,
  );
  const agRun = await sendMain(
    page.request,
    agAgent.id,
    "[agy-ask-question]",
  );
  await waitRunStatus(page.request, agRun.id, "waiting_user");

  await page.reload();
  await page
    .getByRole("button", { name: agAgent.name, exact: true })
    .first()
    .click();

  const panel = page.locator('[data-question-panel="docked"]:visible');
  await expect(panel).toBeVisible();
  // Question is docked above composer and not duplicated inline inside the timeline.
  await expect(
    page.locator('.run-content [data-kind="question"]:visible'),
  ).toHaveCount(0);

  await expect(panel).toContainText("Which database should we use?");
  await expect(panel.locator("[data-question-step]")).toHaveText("1/2");
  // Choice-only question omits custom text input.
  await expect(panel.locator("textarea, input")).toHaveCount(0);

  // Selecting single-select option on Q1 auto-advances to Q2.
  await panel.getByRole("radio", { name: /Postgres/ }).click();
  await expect(panel.locator("[data-question-step]")).toHaveText("2/2");
  await expect(panel).toContainText("Deploy to staging first?");
  await expect(panel).toContainText("可选");

  // Companion _other field allows typing custom text and submitting with Enter.
  const agInput = panel.locator("textarea");
  await expect(agInput).toBeVisible();
  await agInput.fill("Only on Fridays");
  await agInput.press("Enter");
  await expect(panel).toHaveCount(0);

  const agDone = await waitRunStatus(page.request, agRun.id, "completed");
  expect(runText(agDone)).toContain('"q1":"Postgres"');
  expect(runText(agDone)).toContain('"q2_other":"Only on Fridays"');

  // Legacy interaction_* renders as a choice-only docked question.
  const interRun = await sendMain(
    page.request,
    agAgent.id,
    "[agy-interaction]",
    agRun.chatId,
  );
  await waitRunStatus(page.request, interRun.id, "waiting_user");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Pick a deployment target");
  await expect(panel.locator("textarea, input")).toHaveCount(0);
  await panel.getByRole("radio", { name: /Staging/ }).click();
  await panel.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(panel).toHaveCount(0);
  const interDone = await waitRunStatus(page.request, interRun.id, "completed");
  expect(runText(interDone)).toContain('"optionId":"target:staging"');

  // 2. Claude AskUserQuestion (header, markdown preview, digit shortcut, multi-select, Previous/Next)
  const claudeAgent = await createAgent(
    page.request,
    "Question Claude",
    "claude",
    scope,
  );
  const claudeRun = await sendMain(
    page.request,
    claudeAgent.id,
    "[claude-question]",
  );
  await waitRunStatus(page.request, claudeRun.id, "waiting_user");

  await page
    .getByRole("button", { name: claudeAgent.name, exact: true })
    .first()
    .click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Auth");
  await expect(panel).toContainText("useOAuth()");
  await expect(panel.locator("[data-question-step]")).toHaveText("1/2");

  // Digit key shortcut selects option 1 and auto-advances to Q2.
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("1");
  await expect(panel.locator("[data-question-step]")).toHaveText("2/2");
  await expect(panel).toContainText("Scopes");

  await panel.getByRole("checkbox", { name: /read/ }).click();
  await panel.getByRole("checkbox", { name: /write/ }).click();

  // Navigate back to verify Q1 selection persisted, then return and submit.
  await panel.getByRole("button", { name: "上一题", exact: true }).click();
  await expect(panel.getByRole("radio", { name: /OAuth/ })).toBeChecked();
  await panel.getByRole("button", { name: "下一题", exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: /read/ })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: /write/ })).toBeChecked();
  await panel.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(panel).toHaveCount(0);

  const claudeDone = await waitRunStatus(
    page.request,
    claudeRun.id,
    "completed",
  );
  expect(runText(claudeDone)).toContain('"Which auth method?":"OAuth"');
  expect(runText(claudeDone)).toContain('"Select scopes":"read, write"');

  // 3. Codex multi-question with collapse/expand and isSecret password input
  const codexAgent = await createAgent(
    page.request,
    "Question Codex",
    "codex",
    scope,
  );
  const codexRun = await sendMain(
    page.request,
    codexAgent.id,
    "[question-multi]",
  );
  await waitRunStatus(page.request, codexRun.id, "waiting_user");

  await page
    .getByRole("button", { name: codexAgent.name, exact: true })
    .first()
    .click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Rollout");

  // Collapse and expand header cleanly.
  await panel.getByRole("button", { name: "收起提问" }).first().click();
  await expect(panel.getByRole("radio", { name: /Canary/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "展开提问" }).first().click();
  await expect(panel.getByRole("radio", { name: /Canary/ })).toBeVisible();

  await panel.getByRole("radio", { name: /Canary/ }).click();
  await expect(panel.locator("[data-question-step]")).toHaveText("2/2");
  const secretInput = panel.locator('input[type="password"]');
  await expect(secretInput).toBeVisible();
  await secretInput.fill("s3cr3t");
  await secretInput.press("Enter");
  await expect(panel).toHaveCount(0);

  const codexDone = await waitRunStatus(page.request, codexRun.id, "completed");
  expect(runText(codexDone)).toContain("Canary");
  expect(runText(codexDone)).toContain("s3cr3t");

  // 4. Pi select (choice-only) and editor (initialAnswer prefill + dismiss)
  const piAgent = await createAgent(page.request, "Question Pi", "pi", scope);
  const piSelectRun = await sendMain(page.request, piAgent.id, "[pi-select]");
  await waitRunStatus(page.request, piSelectRun.id, "waiting_user");

  await page
    .getByRole("button", { name: piAgent.name, exact: true })
    .first()
    .click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Choose a release channel");
  await expect(panel.locator("textarea, input")).toHaveCount(0);
  await panel.getByRole("radio", { name: /Beta/ }).click();
  await panel.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(panel).toHaveCount(0);

  const piSelectDone = await waitRunStatus(
    page.request,
    piSelectRun.id,
    "completed",
  );
  expect(runText(piSelectDone)).toContain('"value":"Beta"');

  const piEditorRun = await sendMain(
    page.request,
    piAgent.id,
    "[pi-editor]",
    piSelectRun.chatId,
  );
  await waitRunStatus(page.request, piEditorRun.id, "waiting_user");
  await expect(panel).toBeVisible();
  await expect(panel.locator("textarea")).toHaveValue("Initial notes");
  await panel.getByRole("button", { name: "忽略此提问", exact: true }).click();
  await expect(panel).toHaveCount(0);

  const piEditorDone = await waitRunStatus(
    page.request,
    piEditorRun.id,
    "completed",
  );
  expect(runText(piEditorDone)).toContain('"cancelled":true');
});
