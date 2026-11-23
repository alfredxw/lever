import assert from "node:assert/strict";
import test from "node:test";
import type { Pane, PaneTab } from "../src/components/workbench/workspacePanes.ts";
import {
  migrateTabLeftOrder,
  mostRecentlyLeftTab,
  selectedPaneTab,
  sortPaneTabsMostRecentFirst,
  tabsExceedingPaneLimit,
  updateTabLeftOrder,
  type PaneWorkspaceState,
} from "../src/components/workbench/workspaceTabLimits.ts";

function transition(
  current: PaneWorkspaceState,
  next: PaneWorkspaceState,
  order: number,
): { workspace: PaneWorkspaceState; order: number } {
  const prevMainId = selectedPaneTab(current, "main")?.id;
  const prevSideId = selectedPaneTab(current, "side")?.id;
  const nextMainId = selectedPaneTab(next, "main")?.id;
  const nextSideId = selectedPaneTab(next, "side")?.id;
  const updated = updateTabLeftOrder({
    current,
    next,
    prevMainId,
    prevSideId,
    nextMainId,
    nextSideId,
    order,
  });
  return {
    workspace: {
      ...next,
      selected: nextMainId ?? "",
      sideSelected: nextSideId,
      tabLeftOrder: updated.tabLeftOrder,
    },
    order: updated.order,
  };
}

function openInPane(
  workspace: PaneWorkspaceState,
  id: string,
  pane: Pane,
  order: number,
): { workspace: PaneWorkspaceState; order: number } {
  const existing = workspace.tabs.find((tab) => tab.id === id);
  const tabs: PaneTab[] = existing
    ? workspace.tabs.map((tab) => (tab.id === id ? { ...tab, pane } : tab))
    : [...workspace.tabs, { id, pane }];
  return transition(
    workspace,
    {
      ...workspace,
      tabs,
      selected: pane === "main" ? id : workspace.selected,
      sideSelected: pane === "side" ? id : workspace.sideSelected,
    },
    order,
  );
}

test("pane limit counts each Agent and left/right pane independently", () => {
  const workspaces: Record<string, PaneWorkspaceState> = {
    "agent-a": {
      tabs: [
        { id: "a-main-1", pane: "main" },
        { id: "a-main-2", pane: "main" },
        { id: "a-side-1", pane: "side" },
        { id: "a-side-2", pane: "side" },
        { id: "a-side-3", pane: "side" },
      ],
      selected: "a-main-2",
      sideSelected: "a-side-3",
      tabLeftOrder: {
        "a-main-1": 1,
        "a-side-1": 2,
        "a-side-2": 3,
      },
    },
    "agent-b": {
      tabs: [
        { id: "b-main-1", pane: "main" },
        { id: "b-main-2", pane: "main" },
        { id: "b-side-1", pane: "side" },
        { id: "b-side-2", pane: "side" },
      ],
      selected: "b-main-2",
      sideSelected: "b-side-2",
      tabLeftOrder: {
        "b-main-1": 4,
        "b-side-1": 5,
      },
    },
  };

  // Opening a 3rd tab in agent-a's side pane only trims agent-a's side pane.
  assert.deepEqual(
    tabsExceedingPaneLimit(workspaces, 2).map(
      ({ agentId, tab }) => `${agentId}:${tab.id}`,
    ),
    ["agent-a:a-side-1"],
  );

  // Limit of 1 still allows split view (one selected tab per pane) in every Agent.
  assert.deepEqual(
    tabsExceedingPaneLimit(workspaces, 1).map(
      ({ agentId, tab }) => `${agentId}:${tab.id}`,
    ),
    [
      "agent-a:a-main-1",
      "agent-a:a-side-2",
      "agent-a:a-side-1",
      "agent-b:b-main-1",
      "agent-b:b-side-1",
    ],
  );
});

test("eviction closes the earliest-left tab in that pane and protects each pane's selected tab", () => {
  let order = 0;
  let ws: PaneWorkspaceState = { tabs: [], selected: "" };

  // Open main tabs A -> B -> C (leaves A at 1, B at 2; C selected).
  ({ workspace: ws, order } = openInPane(ws, "A", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "B", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "C", "main", order));
  assert.deepEqual(ws.tabLeftOrder, { A: 1, B: 2 });

  // Revisit A (leaves C at 3; A is now selected, not left).
  ({ workspace: ws, order } = openInPane(ws, "A", "main", order));
  assert.deepEqual(ws.tabLeftOrder, { B: 2, C: 3 });

  // Open side tabs S1 -> S2 -> S3: main pane's selected tab A and leave orders stay intact.
  ({ workspace: ws, order } = openInPane(ws, "S1", "side", order));
  ({ workspace: ws, order } = openInPane(ws, "S2", "side", order));
  ({ workspace: ws, order } = openInPane(ws, "S3", "side", order));
  assert.deepEqual(ws.tabLeftOrder, { B: 2, C: 3, S1: 4, S2: 5 });

  // Open main tab D (leaves A at 6; D is selected).
  // Main inactive tabs left order: B (2) < C (3) < A (6).
  ({ workspace: ws, order } = openInPane(ws, "D", "main", order));
  assert.deepEqual(ws.tabLeftOrder, { B: 2, C: 3, S1: 4, S2: 5, A: 6 });

  // Limit 3 trims B in main (earliest left) and leaves side pane (3 tabs) untouched.
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: ws }, 3).map(({ tab }) => tab.id),
    ["B"],
  );

  // Limit 2 trims C and B in main (returned most-recent-first for reopen history)
  // and S1 in side (earliest left in side). A (left at 6) and D (selected) remain in main.
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: ws }, 2).map(({ tab }) => tab.id),
    ["C", "B", "S1"],
  );
});

test("non-selection updates and draft-to-chat renames do not refresh leave order", () => {
  let order = 0;
  let ws: PaneWorkspaceState = { tabs: [], selected: "" };

  ({ workspace: ws, order } = openInPane(ws, "draft-1", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "chat-2", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "chat-3", "main", order));
  assert.deepEqual(ws.tabLeftOrder, { "draft-1": 1, "chat-2": 2 });

  // Non-selection update (e.g. new messages / expandedTopicId / focusPane): leave order unchanged.
  ({ workspace: ws, order } = transition(ws, { ...ws }, order));
  assert.deepEqual(ws.tabLeftOrder, { "draft-1": 1, "chat-2": 2 });

  // Background draft finishes sending and is renamed to chat-1: inherits draft-1's original leave order (1).
  const renamed: PaneWorkspaceState = {
    ...ws,
    tabs: ws.tabs.map((tab) =>
      tab.id === "draft-1" ? { ...tab, id: "chat-1" } : tab,
    ),
    tabLeftOrder: migrateTabLeftOrder(ws, "draft-1", "chat-1"),
  };
  ({ workspace: ws, order } = transition(ws, renamed, order));
  assert.deepEqual(ws.tabLeftOrder, { "chat-1": 1, "chat-2": 2 });
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: ws }, 2).map(({ tab }) => tab.id),
    ["chat-1"],
  );
});

test("moving a tab across panes records the destination pane's outgoing tab as left", () => {
  let order = 0;
  let ws: PaneWorkspaceState = { tabs: [], selected: "" };

  ({ workspace: ws, order } = openInPane(ws, "m1", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "m2", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "s1", "side", order));
  ({ workspace: ws, order } = openInPane(ws, "s2", "side", order));
  assert.deepEqual(ws.tabLeftOrder, { m1: 1, s1: 2 });

  // Move selected main tab m2 into side pane:
  // - main falls back to m1 (becomes selected, cleared from tabLeftOrder)
  // - side replaces s2 with m2 (s2 is recorded as left at 3)
  ({ workspace: ws, order } = openInPane(ws, "m2", "side", order));
  assert.equal(ws.selected, "m1");
  assert.equal(ws.sideSelected, "m2");
  assert.deepEqual(ws.tabLeftOrder, { s1: 2, s2: 3 });

  // Side pane at limit 2 evicts s1 (left at 2), keeping s2 (just left at 3) and m2 (selected).
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: ws }, 2).map(({ tab }) => tab.id),
    ["s1"],
  );
});

test("background tab appended via fallbackPane starts at current leave order instead of oldest", () => {
  let order = 0;
  let ws: PaneWorkspaceState = { tabs: [], selected: "" };

  ({ workspace: ws, order } = openInPane(ws, "m1", "main", order));
  ({ workspace: ws, order } = openInPane(ws, "m2", "main", order));
  assert.deepEqual(ws.tabLeftOrder, { m1: 1 });

  // Append newly created chat in background while m2 stays selected.
  ({ workspace: ws, order } = transition(
    ws,
    { ...ws, tabs: [...ws.tabs, { id: "m3", pane: "main" }] },
    order,
  ));
  assert.equal(ws.selected, "m2");
  assert.deepEqual(ws.tabLeftOrder, { m1: 1, m3: 2 });

  // Evicting down to 2 closes m1 (left earlier at 1), keeping brand-new m3 and selected m2.
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: ws }, 2).map(({ tab }) => tab.id),
    ["m1"],
  );
});

test("legacy workspaces without tabLeftOrder fall back to tabHistory and tab order", () => {
  const legacy: PaneWorkspaceState = {
    tabs: [
      { id: "m1", pane: "main" },
      { id: "m2", pane: "main" },
      { id: "m3", pane: "main" },
      { id: "m4", pane: "main" },
    ],
    selected: "m4",
    tabHistory: [
      { id: "m4", order: 10 },
      { id: "m2", order: 8 },
      { id: "m3", order: 5 },
    ],
  };

  // m1 has no history (-Infinity) -> evicted first; then m3 (5); m2 (8) and selected m4 remain.
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: legacy }, 2).map(({ tab }) => tab.id),
    ["m3", "m1"],
  );
  assert.equal(
    mostRecentlyLeftTab(
      legacy.tabs.filter((t) => t.id !== "m4"),
      legacy,
    )?.id,
    "m2",
  );

  // Once a tab is left under the new model (order > legacy max), it outranks legacy tabs.
  const { workspace: next } = openInPane(legacy, "m1", "main", 10);
  assert.deepEqual(next.tabLeftOrder, { m4: 11 });
  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: next }, 3).map(({ tab }) => tab.id),
    ["m3"],
  );
});

test("skip excludes closing terminals and sortPaneTabsMostRecentFirst prioritizes selected then latest left", () => {
  const ws: PaneWorkspaceState = {
    tabs: [
      { id: "term-1", pane: "main" },
      { id: "m1", pane: "main" },
      { id: "m2", pane: "main" },
      { id: "m3", pane: "main" },
    ],
    selected: "m3",
    tabLeftOrder: { "term-1": 1, m1: 2, m2: 3 },
  };

  assert.deepEqual(
    tabsExceedingPaneLimit({ a1: ws }, 3, new Set(["term-1"])),
    [],
  );
  assert.deepEqual(
    sortPaneTabsMostRecentFirst(ws, "main", ws.tabs).map((tab) => tab.id),
    ["m3", "m2", "m1", "term-1"],
  );
});
