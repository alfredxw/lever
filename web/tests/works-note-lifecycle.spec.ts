import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type {
  Agent,
  ChatView,
  Run,
  TaskExecution,
  TaskNote,
} from "../src/api/types.gen";

test("sidebar note actions preserve a task and its Chat through archive and restore", async ({
  page,
}) => {
  const { url, scope } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
  await page.goto(url);
  await page.waitForURL((address) => !address.hash);
  const originalTitle = "Z Lifecycle fixture";
  const renamedTitle = "Renamed workflow note";
  const taskTitle = "Verify the recovered workflow";
  const taskId = crypto.randomUUID();
  const create = (title: string) =>
    page.request.post("/api/tasks/notes", {
      data: { id: crypto.randomUUID(), title },
    });
  const response = await create(originalTitle);
  expect(response.ok()).toBeTruthy();
  const created: TaskNote = await response.json();
  const path = "/api/tasks/notes/" + created.id;
  const seeded = await page.request.put(path, {
    data: {
      ...created,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { taskId },
            content: [{ type: "text", text: taskTitle }],
          },
        ],
      },
    },
  });
  expect(seeded.ok()).toBeTruthy();
  const agentResponse = await page.request.post("/api/agents", {
    data: {
      name: "Note Lifecycle Agent",
      profile: {
        provider: "codex",
        model: "gpt-test",
        permission: "ask",
        primaryRootId: "root",
        roots: [{ id: "root", path: scope }],
      },
    },
  });
  expect(agentResponse.ok()).toBeTruthy();
  const agent: Agent = await agentResponse.json();

  await page.reload();
  const works = page.getByRole("button", { name: "Works", exact: true });
  await works.click();
  const sidebar = page.locator("#task-sidebar");
  const noteButton = (title: string) =>
    sidebar.getByRole("button", { name: title, exact: true });
  const action = async (title: string, name: string) => {
    await noteButton(title).click({ button: "right" });
    await page
      .getByRole("menu", { name: title, exact: true })
      .getByRole("menuitem", { name, exact: true })
      .click();
  };
  await noteButton("工作笔记").click();
  const headers = sidebar.locator(".task-nav-row > .task-nav-parent");
  const sourcesHeader = noteButton("来源");
  for (const cancel of [true, false]) {
    await sourcesHeader.hover({ position: { x: 25, y: 15 } });
    const to = (await noteButton("Board").boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(to.x + 25, to.y + to.height / 2, { steps: 16 });
    await expect(
      sidebar.getByRole("status").filter({
        hasText: "Draggable item sources was moved over droppable area board",
      }),
    ).toHaveCount(1);
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(headers).toHaveText(
      cancel ? ["Board", "笔记", "来源"] : ["来源", "Board", "笔记"],
    );
    await expect(sourcesHeader).toHaveAttribute("aria-expanded", "true");
    await expect(noteButton("工作笔记")).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
  await noteButton(originalTitle).press("Shift+F10");
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const rename = sidebar.getByRole("textbox", { name: "重命名" });
  await expect(rename).toBeFocused();
  await rename.fill("Cancelled");
  await rename.press("Escape");
  await expect(noteButton(originalTitle)).toBeFocused();
  await action(originalTitle, "重命名");
  await rename.fill(renamedTitle);
  await rename.press("Enter");
  await expect(noteButton(renamedTitle)).toBeVisible();
  await expect(noteButton("工作笔记")).toHaveAttribute("aria-current", "page");

  const saved: TaskNote = await (await page.request.get(path)).json();
  const dispatch = await page.request.post("/api/tasks/dispatch", {
    data: {
      noteId: saved.id,
      taskId,
      version: saved.version,
      commandId: crypto.randomUUID(),
      agentId: agent.id,
      title: taskTitle,
      text: taskTitle,
    },
  });
  expect(dispatch.ok()).toBeTruthy();
  const run: Run = await dispatch.json();

  await action(renamedTitle, "归档");
  await expect(noteButton("已归档")).toHaveAttribute("aria-expanded", "false");
  await expect(noteButton(renamedTitle)).toBeHidden();
  const board = noteButton("全部");
  await board.click();
  const card = page
    .locator(".task-board-card")
    .getByRole("button", { name: new RegExp(taskTitle) });
  await card.click();
  await page.getByRole("button", { name: "定位原文", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "工作笔记", exact: true });
  await expect(editor).toContainText(taskTitle);
  await expect(noteButton("已归档")).toHaveAttribute("aria-expanded", "true");
  await expect(noteButton(renamedTitle)).toHaveAttribute(
    "aria-current",
    "page",
  );

  await action(renamedTitle, "恢复");
  await expect(noteButton("已归档")).toBeHidden();
  await action(renamedTitle, "归档");
  await expect(noteButton("已归档")).toHaveAttribute("aria-expanded", "true");

  await action(renamedTitle, "删除笔记…");
  const confirm = page.getByRole("dialog", { name: "删除笔记" });
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(noteButton(renamedTitle)).toBeVisible();
  await action(renamedTitle, "删除笔记…");
  await confirm.getByRole("button", { name: "删除笔记" }).click();
  await expect(confirm).toBeHidden();
  await expect(noteButton(renamedTitle)).toBeHidden();
  await board.click();
  await expect(card).toHaveCount(0);
  expect((await page.request.get(path)).status()).toBe(404);
  const chat: ChatView = await (
    await page.request.get("/api/chats/" + run.chatId)
  ).json();
  expect(chat.sessions.find(({ id }) => id === run.sessionId)?.taskId).toBe(
    taskId,
  );

  // A second note can use the vacated filename. Restore must keep both files.
  const replacement = await create(originalTitle);
  expect(replacement.ok()).toBeTruthy();
  const other: TaskNote = await replacement.json();
  expect(other.path).toBe(created.path);
  await page.reload();
  await works.click();
  await expect(headers).toHaveText(["来源", "Board", "笔记"]);
  await noteButton("最近删除").click();
  await sidebar.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(noteButton(renamedTitle)).toBeVisible();
  const restored: TaskNote = await (await page.request.get(path)).json();
  expect(restored.state).toBe("active");
  expect(restored.path).not.toBe(other.path);
  expect(restored.content).toEqual(saved.content);
  const executions: TaskExecution[] = await (
    await page.request.get("/api/tasks/executions")
  ).json();
  expect(executions.find((item) => item.taskId === taskId)?.chatId).toBe(
    run.chatId,
  );
  await board.click();
  await expect(card).toBeVisible();
});
