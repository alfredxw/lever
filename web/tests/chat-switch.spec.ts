import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  Agent,
  Chat,
  ChatView,
  Overview,
  Run,
  Session,
} from "../src/api/types.gen";

const standardTurns = 52;
const timestamp = "2026-01-15T12:00:00Z";
const selection = { provider: "codex", model: "", effort: "", fast: false };
const reply = [
  "### Implementation",
  "Keep the response ordered so each step has a visible result.",
  "- Read the [configuration](https://example.com/configuration).",
  "- Run the checks and review the output.",
  "",
  "| Check | Result |",
  "| --- | --- |",
  "| Types | Passed |",
  "| Tests | Passed |",
  "",
  "```text",
  "build completed",
  "checks passed",
  "```",
  "",
  "The workspace is ready.",
].join("\n");

async function seedChats(
  page: Page,
  chatCount = 6,
  turnsPerChat = standardTurns,
  {
    sidebar,
    mixedHistory,
    pageSize,
  }: {
    sidebar?: "all" | "recent";
    mixedHistory?: boolean;
    pageSize?: number;
  } = {},
) {
  const { url, scope } = JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
  const agent: Agent = {
    id: "benchmark-agent",
    name: "Benchmark Agent",
    profile: {
      provider: selection.provider,
      model: selection.model,
      roots: [{ id: "root", path: scope }],
      primaryRootId: "root",
      permission: "ask",
      instructions: "",
      skills: [],
      delegations: [],
    },
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const chats: Chat[] = Array.from({ length: chatCount }, (_, index) => ({
    id: `benchmark-chat-${index}`,
    agentId: agent.id,
    title: `Chat ${index + 1}`,
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const overview: Overview = {
    cursor: sidebar ? 1 : 0,
    agents: [agent],
    chats,
    conversations: sidebar
      ? chats.map((chat) => ({
          id: `${chat.id}-main`,
          agentId: agent.id,
          chatId: chat.id,
          kind: "main",
          title: chat.title,
          preview: "The workspace is ready.",
          messageAt: timestamp,
          unreadSequence: 1,
        }))
      : [],
    runs: [],
    requests: [],
    dataDir: "",
    homeDir: "",
    deviceId: "fixture",
    deviceName: "fixture",
    platform: process.platform,
  };
  await page.route("**/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route(/\/api\/chats\/benchmark-chat-\d+(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const chat = chats.find((item) => url.pathname.endsWith(`/${item.id}`))!;
    const session: Session = {
      id: `${chat.id}-main`,
      agentId: agent.id,
      chatId: chat.id,
      kind: "main",
      nativeId: "",
      roots: agent.profile.roots,
      primaryRootId: agent.profile.primaryRootId,
      selection,
      createdAt: timestamp,
    };
    const limit = pageSize ?? Number(url.searchParams.get("limit") ?? 40);
    const before = Number(url.searchParams.get("before")) || turnsPerChat + 1;
    const first = Math.max(1, before - limit);
    const runs: Run[] = Array.from({ length: before - first }, (_, index) => {
      const sequence = first + index;
      return {
        id: `${chat.id}-${sequence}`,
        chatId: chat.id,
        sessionId:
          mixedHistory && sequence % 3
            ? `${chat.id}-topic-${sequence}`
            : session.id,
        agentId: agent.id,
        sequence,
        selection,
        input: `Review the workspace and summarize check ${sequence}.`,
        attachments: [],
        handoff: false,
        status: "completed",
        items: [
          {
            id: `answer-${sequence}`,
            kind: "text",
            title: "",
            text:
              mixedHistory && sequence % 3
                ? `Topic preview ${sequence}`
                : reply,
            status: "completed",
          },
        ],
        createdAt: timestamp,
        finishedAt: timestamp,
      };
    });
    const view: ChatView = {
      chat,
      sessions: [
        session,
        ...runs
          .filter((run) => run.sessionId !== session.id)
          .map(
            (run): Session => ({
              ...session,
              id: run.sessionId,
              kind: "topic",
            }),
          ),
      ],
      entries: runs.map(({ id, sequence, sessionId }) => ({
        sessionId,
        runId: id,
        kind: sessionId === session.id ? "main" : "topic",
        sequence,
        replyCount: 0,
      })),
      runs,
      requests: [],
      cursor: overview.cursor,
      hasMore: first > 1,
    };
    return route.fulfill({ json: view });
  });
  await page.route("**/api/chats/benchmark-chat-*/delegations", (route) =>
    route.fulfill({ json: { outgoing: {} } }),
  );
  await page.addInitScript(
    ({ agentId, chats, sidebar }) => {
      localStorage.setItem("lever:agent", agentId);
      if (sidebar) {
        localStorage.setItem("lever:agent-view", sidebar);
        return;
      }
      localStorage.setItem(
        "lever:workspaces",
        JSON.stringify({
          [agentId]: {
            tabs: chats.map(({ id, title }) => ({ id, title, kind: "chat" })),
            selected: chats[0].id,
          },
        }),
      );
    },
    { agentId: agent.id, chats, sidebar },
  );
  await page.goto(url);
  return chats;
}

async function switchChat(
  page: Page,
  chat: Chat,
  turnsPerChat = standardTurns,
  trigger = page.locator(`#tab-${chat.id}`),
) {
  const measurement = await trigger.evaluateHandle(
    (button, { id, newest }) => {
      const duration = new Promise<number>((resolve, reject) => {
        button.addEventListener(
          "click",
          () => {
            const started = performance.now();
            const ready = () => {
              const viewport = document
                .getElementById(`panel-${id}`)
                ?.querySelector(".chat-scroll");
              const answer = Array.from(
                viewport?.querySelectorAll(
                  `[data-run-id="${newest}"] .chat-response p`,
                ) ?? [],
              ).at(-1);
              if (
                document
                  .getElementById(`tab-${id}`)
                  ?.getAttribute("aria-selected") === "true" &&
                viewport &&
                answer &&
                getComputedStyle(viewport).visibility === "visible"
              ) {
                const view = viewport.getBoundingClientRect();
                const text = answer.getBoundingClientRect();
                if (
                  text.height > 0 &&
                  text.top >= view.top &&
                  text.bottom <= view.bottom
                ) {
                  // Wait one frame after the destination can be painted.
                  requestAnimationFrame(() =>
                    resolve(performance.now() - started),
                  );
                  return;
                }
              }
              if (performance.now() - started > 4_000)
                reject(new Error(`Latest message was not visible in ${id}`));
              else requestAnimationFrame(ready);
            };
            requestAnimationFrame(ready);
          },
          { once: true },
        );
      });
      return { duration };
    },
    { id: chat.id, newest: `${chat.id}-${turnsPerChat}` },
  );
  try {
    await trigger.click();
    return await measurement.evaluate(({ duration }) => duration);
  } finally {
    await measurement.dispose();
  }
}

function p90(samples: number[]) {
  return [...samples].sort((a, b) => a - b)[
    Math.ceil(samples.length * 0.9) - 1
  ];
}

async function readMiddleReply(panel: Locator) {
  const viewport = panel.locator(".chat-scroll");
  const id = await viewport.evaluate(async (node) => {
    node.scrollTop = node.scrollHeight / 2;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const middle = node.getBoundingClientRect().top + node.clientHeight / 2;
    return Array.from(node.querySelectorAll<HTMLElement>("[data-run-id]")).find(
      (item) => item.getBoundingClientRect().bottom >= middle,
    )!.dataset.runId;
  });
  const turn = panel.locator(`[data-run-id="${id}"]`);
  await turn.scrollIntoViewIfNeeded();
  const line = turn.getByText("The workspace is ready.");
  await line.scrollIntoViewIfNeeded();
  const offset = () =>
    line.evaluate(
      (element) =>
        element.getBoundingClientRect().top -
        element.closest(".chat-scroll")!.getBoundingClientRect().top,
    );
  const initialOffset = await offset();
  // Measuring earlier turns can change scrollTop while the text stays put.
  return async function expectReadingPosition() {
    await expect(line).toBeInViewport();
    await expect
      .poll(async () => Math.abs((await offset()) - initialOffset))
      .toBeLessThan(2);
  };
}

async function loadHistory(panel: Locator, chat: Chat, turns: number) {
  const viewport = panel.locator(".chat-scroll");
  for (let loaded = 12; loaded < turns; loaded += 40) {
    const anchor = panel.locator(
      `[data-run-id="${chat.id}-${turns - loaded + 1}"]`,
    );
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(anchor).toHaveAttribute(
      "data-index",
      String(Math.min(40, turns - loaded)),
    );
    await expect(anchor).toBeInViewport();
  }
  await panel.getByRole("button", { name: "回到最新消息" }).click();
  await expect
    .poll(() =>
      viewport.evaluate(
        (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
}

test.use({ trace: "off" });
test.skip(
  !!process.env.LEVER_TEST_DEV_ORIGIN,
  "Timing budgets use the production build.",
);

test("sidebars animate the actual widths of two long Chats and keep the latest replies visible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1130, height: 900 });
  const turns = 92;
  const chats = await seedChats(page, 2, turns, { pageSize: turns });
  await page
    .getByRole("tab", { name: chats[1].title, exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "移动到右侧面板" }).click();
  await page.locator(".workspace-layout").evaluate(async (node) => {
    await Promise.all(
      node.getAnimations().map((animation) => animation.finished),
    );
  });
  for (const chat of chats) {
    const panel = page.locator(`#panel-${chat.id}`);
    await expect(panel.locator(".run-content").first()).toBeVisible();
    await panel.locator(".chat-scroll").evaluate((scroll) => {
      scroll.scrollTop = scroll.scrollHeight;
    });
    const latest = panel.locator(`[data-run-id="${chat.id}-${turns}"]`);
    await expect(latest).toHaveAttribute("data-index", String(turns - 1));
    await expect(latest).toBeInViewport();
  }

  const toggle = (button: Locator, reduced = false) =>
    button.evaluate(
      async (element, { reduced, runId }) => {
        const layout =
          document.querySelector<HTMLElement>(".workspace-layout")!;
        const sidebar = document.getElementById("agent-sidebar")!;
        const target =
          element.getAttribute("aria-controls") === sidebar.id
            ? sidebar
            : layout;
        const panes = Array.from(
          layout.querySelectorAll<HTMLElement>(".tab-strip[data-pane]"),
        );
        const measure = () => ({
          list: sidebar.offsetWidth,
          workspace: layout.clientWidth,
          headers: panes.map((header) => header.offsetWidth),
          chats: panes.map(
            (header) =>
              layout.querySelector<HTMLElement>(
                `.tab-panel[data-pane="${header.dataset.pane}"][data-visible="true"] .chat-scroll`,
              )?.offsetWidth ?? 0,
          ),
          lineHeight:
            layout.querySelector<HTMLElement>(
              `[data-run-id="${runId}"] .chat-response p`,
            )?.offsetHeight ?? 0,
        });
        const before = measure();
        (element as HTMLButtonElement).click();
        await Promise.resolve();
        const transition = target
          .getAnimations()
          .find(
            (animation) =>
              (animation as CSSTransition).transitionProperty ===
              "grid-template-columns",
          );
        if (reduced && transition)
          throw new Error("Unexpected width animation with reduced motion");
        if (!reduced && !transition) throw new Error("Missing width animation");
        const during = [];
        if (transition) {
          transition.pause();
          const duration = Number(transition.effect!.getTiming().duration);
          for (const progress of [0.12, 0.35, 0.65]) {
            transition.currentTime = duration * progress;
            during.push(measure());
          }
          transition.finish();
        }
        return { before, during, after: measure() };
      },
      { reduced, runId: `${chats[0].id}-${turns}` },
    );

  const sidebar = page.locator('button[aria-controls="agent-sidebar"]');
  const { before: split, during, after: wider } = await toggle(sidebar);
  expect(wider.list).toBe(0);
  expect(wider.workspace).toBe(split.workspace + split.list);
  for (const frame of during) {
    expect(frame.chats).toEqual(frame.headers);
    for (const [index, width] of frame.chats.entries()) {
      expect(width).toBeGreaterThan(split.chats[index]);
      expect(width).toBeLessThan(wider.chats[index]);
    }
  }
  expect((await toggle(sidebar)).after.chats).toEqual(split.chats);

  const close = page.getByRole("button", { name: "收起侧边分栏", exact: true });
  const open = page.getByRole("button", { name: "展开侧边分栏", exact: true });
  const { during: closing, after: single } = await toggle(close);
  expect(single.chats).toEqual([split.workspace, 0]);
  expect(
    closing.some(
      (frame) =>
        frame.chats[0] > split.chats[0] &&
        frame.chats[0] < single.chats[0] &&
        frame.lineHeight > 0 &&
        frame.lineHeight < split.lineHeight,
    ),
  ).toBe(true);
  expect((await toggle(open)).after.chats).toEqual(split.chats);
  const maximize = await toggle(
    page.getByRole("button", { name: "最大化面板" }),
  );
  expect(maximize.after.chats).toEqual([0, split.workspace]);
  expect(
    (await toggle(page.getByRole("button", { name: "还原面板大小" }))).after
      .chats,
  ).toEqual(split.chats);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect((await toggle(sidebar, true)).after.list).toBe(0);
  expect((await toggle(sidebar, true)).after.chats).toEqual(split.chats);
  expect((await toggle(close, true)).after.chats).toEqual(single.chats);
  expect((await toggle(open, true)).after.chats).toEqual(split.chats);
  for (const chat of chats)
    await expect(
      page.locator(`[data-run-id="${chat.id}-${turns}"]`),
    ).toBeInViewport();
});

test("a mixed-height timeline prepends in place and jumps to the measured end in one click", async ({
  page,
}) => {
  const turns = 92;
  const [chat] = await seedChats(page, 1, turns, { mixedHistory: true });
  const panel = page.locator(`#panel-${chat.id}`);
  const viewport = panel.locator(".chat-scroll");
  const latest = panel.locator(`[data-message-id="${chat.id}-${turns}"]`);
  const jump = panel.getByRole("button", { name: "回到最新消息" });
  const gap = () =>
    viewport.evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    );
  const requests: number[] = [];
  let release: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    /\/api\/chats\/benchmark-chat-0\?before=[1-9]/,
    async (route) => {
      requests.push(
        Number(new URL(route.request().url()).searchParams.get("before")),
      );
      await gate;
      await route.fallback();
    },
  );
  await expect(latest).toBeInViewport();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await viewport.evaluate((node) => {
    node.scrollTop = 80;
  });
  await expect.poll(() => requests).toEqual([81]);
  const anchor = panel.locator(`[data-message-id="${chat.id}-81"]`);
  const offset = () =>
    anchor.evaluate(
      (row) =>
        row.getBoundingClientRect().top -
        row.closest(".chat-scroll")!.getBoundingClientRect().top,
    );
  const before = await offset();
  release!();
  await expect(anchor).toHaveAttribute("data-index", "40");
  await expect
    .poll(async () => Math.abs((await offset()) - before))
    .toBeLessThan(2);
  for (const fraction of [0.2, 0.85, 0.32, 0.95, 0.25]) {
    const coverage = await viewport.evaluate(async (node, fraction) => {
      node.scrollTop = fraction * (node.scrollHeight - node.clientHeight);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const view = node.getBoundingClientRect();
      const rows = Array.from(
        node.querySelectorAll<HTMLElement>("[data-message-id]"),
      );
      const painted = rows.reduce((sum, row) => {
        if (!row.innerText.trim()) return sum;
        const rect = row.getBoundingClientRect();
        return (
          sum +
          Math.max(
            0,
            Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top),
          )
        );
      }, 0);
      return { rows: rows.length, fraction: painted / view.height };
    }, fraction);
    expect(coverage.rows).toBeLessThan(20);
    expect(coverage.fraction).toBeGreaterThan(0.5);
  }
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await viewport.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect.poll(() => requests).toEqual([81, 41]);
  await jump.click();
  await expect(latest).toBeInViewport();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  release!();
  await expect(latest).toHaveAttribute("data-index", String(turns - 1));
  const height = await viewport.evaluate((node) => node.scrollHeight);
  await latest.locator(".user-message").evaluate((node) => {
    node.style.paddingBottom = "360px";
  });
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollHeight))
    .toBeGreaterThan(height + 300);
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(jump).toBeHidden();
  expect(requests).toEqual([81, 41]);
});

test("keeps first-open and retained Chat switches within the latency budget", async ({
  browserName,
  page,
}, testInfo) => {
  const chats = await seedChats(page);
  const panel = (chat: Chat) => page.locator(`#panel-${chat.id}`);
  await expect(
    panel(chats[0]).getByText("The workspace is ready.").last(),
  ).toBeVisible();
  await loadHistory(panel(chats[0]), chats[0], standardTurns);

  const cold: number[] = [];
  const warm: number[] = [];
  for (const chat of chats.slice(1)) {
    cold.push(await switchChat(page, chat));
    await loadHistory(panel(chat), chat, standardTurns);
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const chat of chats) warm.push(await switchChat(page, chat));
  }
  const result = { cold, warm, coldP90: p90(cold), warmP90: p90(warm) };
  await testInfo.attach("chat-switch", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  console.log(
    `Chat switch P90: first open ${result.coldP90.toFixed(1)} ms, retained ${result.warmP90.toFixed(1)} ms`,
  );
  const budget =
    browserName === "webkit"
      ? { cold: 200, warm: 140 }
      : { cold: 180, warm: 100 };
  expect
    .soft(result.coldP90, "First-open P90 (ms)")
    .toBeLessThanOrEqual(budget.cold);
  expect
    .soft(result.warmP90, "Retained P90 (ms)")
    .toBeLessThanOrEqual(budget.warm);

  const lastChat = chats.at(-1)!;
  const expectReadingPosition = await readMiddleReply(panel(lastChat));
  await page.locator(`#tab-${chats[0].id}`).click();
  await page.locator(`#tab-${lastChat.id}`).click();
  await expectReadingPosition();
});

test("reopens long histories beyond the retained tabs without rebuilding every reply", async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const turns = 132;
  const chats = await seedChats(page, 12, turns);
  const retained = 6;
  const first: number[] = [];
  const warm: number[] = [];
  const reopened: number[] = [];
  for (const [index, chat] of chats.entries()) {
    const panel = page.locator(`#panel-${chat.id}`);
    if (index) first.push(await switchChat(page, chat, turns));
    await loadHistory(panel, chat, turns);
  }
  for (const chat of chats.slice(-retained))
    warm.push(await switchChat(page, chat, turns));
  const nodes = await page.locator("body *").count();
  for (const chat of chats.slice(0, retained))
    reopened.push(await switchChat(page, chat, turns));
  const timings = {
    first: p90(first),
    retained: p90(warm),
    reopened: p90(reopened),
    nodes,
  };
  await testInfo.attach("long-chat-switch", {
    body: JSON.stringify(timings),
    contentType: "application/json",
  });
  console.log("Long Chat switch P90 (ms)", timings);
  expect(timings.reopened).toBeLessThanOrEqual(
    browserName === "webkit" ? 220 : 180,
  );
  const panel = page.locator(`#panel-${chats[retained - 1].id}`);
  expect(await panel.locator(".run-content").count()).toBeLessThan(turns / 2);
  expect(await panel.locator(".chat-response").count()).toBeLessThan(turns / 2);
  await panel.locator(".chat-scroll").evaluate((node) => {
    node.scrollTop = 0;
  });
  const oldest = panel.locator('[data-index="0"]');
  await expect(oldest.getByText("The workspace is ready.")).toBeVisible();

  const expectReadingPosition = await readMiddleReply(panel);
  for (const chat of chats.slice(-retained)) {
    await page.locator(`#tab-${chat.id}`).click();
  }
  await expect(panel.locator(".run-content")).toHaveCount(0);
  await page.locator(`#tab-${chats[retained - 1].id}`).click();
  await expectReadingPosition();
});

test("Recent reuses its scan and refreshes after returning to stale data", async ({
  page,
}) => {
  await page.clock.install();
  let scans = 0;
  await page.route("**/api/shared-conversations", (route) => {
    scans++;
    return route.fulfill({
      json: {
        conversations: [
          {
            id: "scan-result",
            provider: "codex",
            runtime: "codex",
            title: "扫描结果",
            cwd: "/example",
            updatedAt: timestamp,
          },
        ],
        unavailable: [],
      },
    });
  });
  await seedChats(page, 3, 1, { sidebar: "all" });
  const views = page.locator("#agent-sidebar").getByRole("tablist");
  const recent = views.getByRole("tab", { name: "最近", exact: true });
  const all = views.getByRole("tab", { name: "全部", exact: true });
  await expect(all).toHaveAttribute("aria-selected", "true");
  expect(scans).toBe(0);
  await recent.click();
  await expect(
    page.locator(
      '#agent-sidebar button[data-session-id="shared:codex:scan-result"]',
    ),
  ).toBeVisible();
  const initialScans = scans;
  await all.click();
  await recent.click();
  expect(scans).toBe(initialScans);
  await all.click();
  await page.clock.fastForward(10_000);
  expect(scans).toBe(initialScans);
  await recent.click();
  await expect.poll(() => scans).toBe(initialScans + 1);
});

test("switches populated sidebar views without losing the reading position", async ({
  page,
  browserName,
}, testInfo) => {
  const chats = await seedChats(page, 600, 12, { sidebar: "all" });
  const sidebar = page.locator("#agent-sidebar");
  const all = sidebar.getByRole("tab", { name: "全部", exact: true });
  const recent = sidebar.getByRole("tab", { name: "最近", exact: true });
  const archive = sidebar.getByRole("tab", { name: "已归档", exact: true });
  const list = sidebar.getByRole("tabpanel");
  await expect(list.locator("[data-session-id]")).toHaveCount(600);
  const position = await list.evaluate((panel) => {
    panel.scrollTop = 450;
    return panel.scrollTop;
  });
  expect(position).toBeGreaterThan(0);
  await recent.click();
  await expect(list.locator("[data-session-id]")).toHaveCount(600);
  const timings: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    for (const tab of [archive, all, recent]) {
      const measurement = await tab.evaluateHandle((button) => ({
        duration: new Promise<number>((resolve, reject) => {
          button.addEventListener(
            "pointerdown",
            () => {
              const start = performance.now();
              const ready = () => {
                const panel = document.getElementById(
                  button.getAttribute("aria-controls")!,
                );
                if (
                  button.getAttribute("aria-selected") === "true" &&
                  panel?.offsetHeight
                ) {
                  requestAnimationFrame(() =>
                    resolve(performance.now() - start),
                  );
                } else if (performance.now() - start > 4_000) {
                  reject(
                    new Error(`Sidebar did not show ${button.textContent}`),
                  );
                } else requestAnimationFrame(ready);
              };
              requestAnimationFrame(ready);
            },
            { once: true },
          );
        }),
      }));
      try {
        await tab.click();
        timings.push(await measurement.evaluate(({ duration }) => duration));
      } finally {
        await measurement.dispose();
      }
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(list).toHaveAttribute(
        "aria-labelledby",
        (await tab.getAttribute("id"))!,
      );
    }
  }
  console.log(
    `600-conversation sidebar view switch P90: ${p90(timings).toFixed(1)} ms`,
  );
  await testInfo.attach("sidebar-view-switch", {
    body: JSON.stringify(timings),
    contentType: "application/json",
  });
  await all.click();
  await expect
    .poll(() => list.evaluate((panel) => panel.scrollTop))
    .toBe(position);
  expect(p90(timings)).toBeLessThanOrEqual(browserName === "webkit" ? 130 : 85);
  const toggle = list.locator(".agent-activity-toggle");
  await toggle.click();
  await recent.click();
  await all.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await recent.click();
  const oldest = list.locator(
    `button[data-session-id="${chats.at(-1)!.id}-main"]`,
  );
  await expect(oldest).toHaveAccessibleName(/The workspace is ready/);
  await list.evaluate((panel) => panel.scrollTo(0, panel.scrollHeight));
  await expect(oldest.locator(".conversation-origin")).toBeInViewport();
  await expect(oldest.locator(".contact-name svg")).toBeVisible();
});

for (const sidebar of ["all", "recent"] as const) {
  test(`switches long previews from a populated ${sidebar} sidebar`, async ({
    page,
    browserName,
  }) => {
    test.setTimeout(90_000);
    const turns = 132;
    const chats = await seedChats(page, 600, turns, { sidebar });
    const row = (chat: Chat) =>
      page.locator(`#agent-sidebar button[data-session-id="${chat.id}-main"]`);
    const panel = (chat: Chat) => page.locator(`#panel-${chat.id}`);
    const recent = chats.slice(4, 8);
    for (const chat of chats.slice(1, 8)) {
      await switchChat(page, chat, turns, row(chat));
      if (!recent.includes(chat)) continue;
      await loadHistory(panel(chat), chat, turns);
    }
    await expect(page.locator(".tab-strip [role=tab]")).toHaveCount(1);
    await expect(page.locator(".chat-panel")).toHaveCount(6);
    await expect(panel(chats[0])).toHaveCount(0);
    const warm: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      for (const chat of recent)
        warm.push(await switchChat(page, chat, turns, row(chat)));
    }
    console.log(
      `600-conversation ${sidebar} sidebar P90: ${p90(warm).toFixed(1)} ms`,
    );
    expect(p90(warm)).toBeLessThanOrEqual(browserName === "webkit" ? 140 : 100);
    const current = recent.at(-1)!;
    await expect(row(current)).toHaveAttribute("aria-current", "true");
    const expectReadingPosition = await readMiddleReply(panel(current));
    await row(recent[0]).click();
    await row(current).click();
    await expectReadingPosition();
    await page.locator(`#tab-${current.id}`).hover();
    await page.locator(".workspace-tab.selected .tab-close").click();
    await expect(page.locator(".chat-panel")).toHaveCount(0);
    const oldest = chats.at(-1)!;
    await row(oldest).focus();
    await row(oldest).press("Enter");
    await expect(
      panel(oldest).locator(`[data-run-id="${oldest.id}-${turns}"]`),
    ).toBeInViewport();
  });
}
