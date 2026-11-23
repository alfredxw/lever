import { tabPane, type Pane, type PaneTab } from "./workspacePanes.ts";

export type TabVisit = { id: string; order: number };
export type TabLeftOrder = Record<string, number>;

export type PaneWorkspaceState<T extends PaneTab = PaneTab> = {
  tabs: T[];
  selected: string;
  sideSelected?: string;
  tabHistory?: TabVisit[];
  tabLeftOrder?: TabLeftOrder;
};

export type EvictableTab<T extends PaneTab = PaneTab> = {
  agentId: string;
  tab: T;
  order: number;
};

const panes: readonly Pane[] = ["main", "side"];

const paneSelectionId = (workspace: PaneWorkspaceState, pane: Pane) =>
  pane === "main" ? workspace.selected : workspace.sideSelected;

/**
 * Recency order for an inactive tab within its pane:
 * prefers when the user last left that tab (`tabLeftOrder`), falling back to
 * legacy `tabHistory` order for workspaces persisted before `tabLeftOrder`.
 */
export function tabLeftRecency(
  workspace: Pick<PaneWorkspaceState, "tabHistory" | "tabLeftOrder">,
  tabId: string,
): number {
  const left = workspace.tabLeftOrder?.[tabId];
  if (typeof left === "number" && Number.isFinite(left)) return left;
  const legacy = workspace.tabHistory?.find((visit) => visit.id === tabId);
  return legacy ? legacy.order : Number.MIN_SAFE_INTEGER;
}

/**
 * Most recently left tab among `tabs` within a pane, used when a pane's
 * selected tab closes or moves to the other pane.
 */
export function mostRecentlyLeftTab<T extends PaneTab>(
  tabs: readonly T[],
  workspace: Pick<PaneWorkspaceState, "tabHistory" | "tabLeftOrder">,
): T | undefined {
  let best: T | undefined;
  let bestOrder = -Infinity;
  for (const tab of tabs) {
    const left = workspace.tabLeftOrder?.[tab.id];
    const hasLeft = typeof left === "number" && Number.isFinite(left);
    const legacy = hasLeft
      ? undefined
      : workspace.tabHistory?.find((visit) => visit.id === tab.id);
    if (!hasLeft && !legacy) continue;
    const order = hasLeft ? left : legacy!.order;
    if (order > bestOrder) {
      best = tab;
      bestOrder = order;
    }
  }
  return best;
}

export function selectedPaneTab<T extends PaneTab>(
  workspace: PaneWorkspaceState<T>,
  pane: Pane,
): T | undefined {
  const tabs = workspace.tabs.filter((tab) => tabPane(tab) === pane);
  return (
    tabs.find((tab) => tab.id === paneSelectionId(workspace, pane)) ??
    mostRecentlyLeftTab(tabs, workspace) ??
    tabs[0]
  );
}

/**
 * Carry an inactive tab's leave order forward when its ID changes in place
 * (for example, when a draft tab becomes a persisted Chat).
 */
export function migrateTabLeftOrder(
  workspace: Pick<PaneWorkspaceState, "tabHistory" | "tabLeftOrder">,
  oldId: string,
  newId: string,
): TabLeftOrder | undefined {
  if (oldId === newId) return workspace.tabLeftOrder;
  const current = workspace.tabLeftOrder;
  if (current && oldId in current) {
    const next: TabLeftOrder = {};
    for (const [id, leftOrder] of Object.entries(current)) {
      next[id === oldId ? newId : id] = leftOrder;
    }
    return next;
  }
  const legacy = workspace.tabHistory?.find((visit) => visit.id === oldId);
  if (legacy) {
    return { ...current, [newId]: legacy.order };
  }
  return current;
}

/**
 * Advance per-tab leave order when a workspace transitions from `current` to
 * `next`. Only leaving a pane's selected tab records a leave timestamp;
 * focusing between panes or background message activity never updates it.
 */
export function updateTabLeftOrder({
  current,
  next,
  prevMainId,
  prevSideId,
  nextMainId,
  nextSideId,
  order,
}: {
  current: PaneWorkspaceState;
  next: PaneWorkspaceState;
  prevMainId?: string;
  prevSideId?: string;
  nextMainId?: string;
  nextSideId?: string;
  order: number;
}): { tabLeftOrder: TabLeftOrder | undefined; order: number } {
  const open = new Set(next.tabs.map((tab) => tab.id));
  const prevOpen = new Set(current.tabs.map((tab) => tab.id));
  const selectedIds = new Set(
    [nextMainId, nextSideId].filter((id): id is string => !!id),
  );

  const nextLeft: TabLeftOrder = {};
  if (next.tabLeftOrder) {
    for (const [id, leftOrder] of Object.entries(next.tabLeftOrder)) {
      if (
        open.has(id) &&
        !selectedIds.has(id) &&
        typeof leftOrder === "number" &&
        Number.isFinite(leftOrder)
      ) {
        nextLeft[id] = leftOrder;
      }
    }
  }

  let nextOrder = order;
  const recordLeft = (id: string | undefined) => {
    if (!id || !open.has(id) || selectedIds.has(id)) return;
    nextOrder += 1;
    nextLeft[id] = nextOrder;
  };

  if (prevMainId && prevMainId !== nextMainId) recordLeft(prevMainId);
  if (prevSideId && prevSideId !== nextSideId) recordLeft(prevSideId);

  // A tab appended directly into the background (e.g. a draft sent from an
  // empty pane while the user switched tabs) starts at the current sequence
  // rather than appearing older than tabs left earlier.
  if (next.tabs.length > current.tabs.length) {
    for (const tab of next.tabs) {
      if (
        !prevOpen.has(tab.id) &&
        !selectedIds.has(tab.id) &&
        !(tab.id in nextLeft)
      ) {
        recordLeft(tab.id);
      }
    }
  }

  return {
    tabLeftOrder: Object.keys(nextLeft).length > 0 ? nextLeft : undefined,
    order: nextOrder,
  };
}

/**
 * Return tabs that exceed `limit` when counted independently per Agent and per
 * pane (`main` / `side`). Each pane's currently selected tab is protected, and
 * inactive tabs that were left earliest are closed first.
 */
export function tabsExceedingPaneLimit<T extends PaneTab>(
  workspaces: Record<string, PaneWorkspaceState<T>>,
  limit: number,
  skip?: ReadonlySet<string>,
): EvictableTab<T>[] {
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  const toClose: EvictableTab<T>[] = [];
  for (const [agentId, workspace] of Object.entries(workspaces)) {
    if (!agentId || workspace.tabs.length <= limit) continue;
    const indexById = new Map(
      workspace.tabs.map((tab, index) => [tab.id, index]),
    );
    for (const pane of panes) {
      const paneTabs = workspace.tabs.filter(
        (tab) => tabPane(tab) === pane && !skip?.has(tab.id),
      );
      const excess = paneTabs.length - limit;
      if (excess <= 0) continue;
      const activeId = selectedPaneTab(workspace, pane)?.id;
      const victims = paneTabs
        .filter((tab) => tab.id !== activeId)
        .map((tab) => ({
          agentId,
          tab,
          order: tabLeftRecency(workspace, tab.id),
          index: indexById.get(tab.id) ?? 0,
        }))
        .sort((a, b) => a.order - b.order || a.index - b.index)
        .slice(0, excess)
        .reverse()
        .map(({ agentId, tab, order }) => ({ agentId, tab, order }));
      toClose.push(...victims);
    }
  }
  return toClose;
}

/**
 * Sort tabs in a single pane most-recent-first for reopen history when closing
 * multiple tabs in that pane.
 */
export function sortPaneTabsMostRecentFirst<T extends PaneTab>(
  workspace: PaneWorkspaceState<T>,
  pane: Pane,
  tabs: readonly T[],
): T[] {
  const activeId = selectedPaneTab(workspace, pane)?.id;
  const indexById = new Map(
    workspace.tabs.map((tab, index) => [tab.id, index]),
  );
  return [...tabs].sort((a, b) => {
    const orderA =
      a.id === activeId ? Infinity : tabLeftRecency(workspace, a.id);
    const orderB =
      b.id === activeId ? Infinity : tabLeftRecency(workspace, b.id);
    return (
      orderB - orderA ||
      (indexById.get(b.id) ?? 0) - (indexById.get(a.id) ?? 0)
    );
  });
}
