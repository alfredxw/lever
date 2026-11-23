import { useEffect, useEffectEvent, useState } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import type { FileSelection } from "@/features/files/filePaths";
import type {
  HostFileSource,
  SkillFileSource,
} from "@/features/files/fileSource";
import type { TabKind } from "./WorkspaceTabs";
import type { TurnSelection } from "@/features/diff/TurnChanges";
import type { DiffTarget } from "@/features/diff/useGitSummary";
import type { SharedConversationRef } from "@/features/chat/sharedConversations";

import type { TerminalLayout } from "@/features/terminal/terminalSession";
import { defaultOpenPane, tabPane, type Pane } from "./workspacePanes";
import {
  migrateTabLeftOrder,
  mostRecentlyLeftTab,
  selectedPaneTab,
  updateTabLeftOrder,
  type TabLeftOrder,
  type TabVisit,
} from "./workspaceTabLimits";

export type { Pane };
export type WorkspaceTab = {
  id: string;
  title: string;
  pane?: Pane;
  diff?: TurnSelection;
  diffTarget?: DiffTarget;
  reviewChatId?: string;
  sessionId?: string;
  workingCopyId?: string;
  terminalLayout?: TerminalLayout;
} & (
  | {
      kind: "topic";
      topic: { chatId: string; sessionId: string };
      file?: never;
    }
  | {
      kind: "shared";
      shared: SharedConversationRef;
      file?: never;
      topic?: never;
    }
  | {
      kind: "browser";
      url?: string;
      htmlPreview?: string;
      sourceConversation?: string;
      file?: never;
      topic?: never;
    }
  | {
      kind: "chat";
      expandedTopicId?: string;
      file?: never;
      topic?: never;
    }
  | {
      kind: Exclude<TabKind, "chat" | "topic" | "shared" | "browser">;
      file?: FileSelection & { source?: SkillFileSource | HostFileSource };
      topic?: never;
    }
);
export type Workspace = {
  tabs: WorkspaceTab[];
  selected: string;
  sideSelected?: string;
  previews?: Partial<Record<Pane, string>>;
  tabHistory?: TabVisit[];
  tabLeftOrder?: TabLeftOrder;
  sideVisible?: boolean;
  sideMaximized?: boolean;
  activePane?: Pane;
  lastChatId?: string;
  splitRatio?: number;
};
type Workspaces = Record<string, Workspace>;
type WorkspaceState = { workspaces: Workspaces; order: number };
export const paneOf = (tab: WorkspaceTab): Pane => tabPane(tab);
const selectionKey = (pane: Pane) =>
  pane === "main" ? "selected" : "sideSelected";

function recentTab(tabs: WorkspaceTab[], history: TabVisit[] = []) {
  for (const { id } of history) {
    const tab = tabs.find((item) => item.id === id);
    if (tab) return tab;
  }
}

function selectPaneTab(
  workspace: Workspace,
  id: string,
  pane: Pane,
  activatePane = true,
): Workspace {
  return {
    ...workspace,
    [selectionKey(pane)]: id,
    ...(pane === "side" && { sideVisible: true }),
    ...(activatePane && {
      activePane: pane,
      ...(pane === "main" && { sideMaximized: false }),
    }),
  };
}

function keepTabOpen(workspace: Workspace, id: string): Workspace {
  const previews = workspace.previews;
  if (previews?.main === id)
    return { ...workspace, previews: { ...previews, main: undefined } };
  if (previews?.side === id)
    return { ...workspace, previews: { ...previews, side: undefined } };
  return workspace;
}

function selectedTab(workspace: Workspace, pane: Pane) {
  return selectedPaneTab(workspace, pane);
}

export function workspaceView(workspace: Workspace, compact: boolean) {
  const mainTab = selectedTab(workspace, "main");
  const sideTab = selectedTab(workspace, "side");
  const sideVisible = !!sideTab && workspace.sideVisible !== false;
  const sideMaximized = sideVisible && workspace.sideMaximized === true;
  const activePane = sideMaximized
    ? "side"
    : sideVisible
      ? (workspace.activePane ?? "main")
      : "main";
  const activeTab = activePane === "side" ? sideTab : mainTab;
  const compactTopic =
    compact && (mainTab?.kind === "topic" || sideTab?.kind === "topic");
  const split = sideVisible && !(compactTopic && activePane === "main");
  const maximized =
    split && (sideMaximized || (compactTopic && activePane === "side"));
  return {
    mainTab,
    sideTab,
    sideVisible,
    activePane,
    activeTab,
    compactTopic,
    split,
    maximized,
  };
}

function readWorkspaces(): WorkspaceState {
  try {
    const saved: Record<
      string,
      Omit<Workspace, "tabHistory"> & { tabHistory?: (TabVisit | string)[] }
    > = JSON.parse(localStorage.getItem("lever:workspaces") ?? "{}");
    let order = 0;
    const workspaces = Object.fromEntries(
      Object.entries(saved).map(([id, workspace]) => {
        // Older workspaces only recorded the order within each Agent.
        const tabHistory = workspace.tabHistory?.map((entry, index) => {
          const visit =
            typeof entry === "string" ? { id: entry, order: -index } : entry;
          order = Math.max(order, visit.order);
          return visit;
        });
        const leftEntries =
          workspace.tabLeftOrder && typeof workspace.tabLeftOrder === "object"
            ? Object.entries(workspace.tabLeftOrder).filter(
                (entry): entry is [string, number] => {
                  if (
                    typeof entry[1] !== "number" ||
                    !Number.isFinite(entry[1])
                  )
                    return false;
                  order = Math.max(order, entry[1]);
                  return true;
                },
              )
            : [];
        const tabLeftOrder =
          leftEntries.length > 0
            ? Object.fromEntries(leftEntries)
            : undefined;
        return [id, { ...workspace, tabHistory, tabLeftOrder }];
      }),
    );
    return { workspaces, order };
  } catch {
    return { workspaces: {}, order: 0 };
  }
}

export function useWorkspaces(agentId: string, fallback: Workspace) {
  const [{ workspaces }, setState] = useState(readWorkspaces);
  const workspace = workspaces[agentId] ?? fallback;
  useEffect(() => {
    localStorage.setItem("lever:workspaces", JSON.stringify(workspaces));
  }, [workspaces]);

  function update(
    change: (current: Workspace) => Workspace,
    id = agentId,
    visit = false,
  ) {
    setState((state) => {
      const all = state.workspaces;
      const current =
        all[id] ?? (id === agentId ? fallback : { tabs: [], selected: "" });
      const next = change(current);
      if (next === current && !visit) return state;
      const prevView = workspaceView(current, false);
      const {
        mainTab,
        sideTab,
        sideVisible,
        activePane,
        activeTab,
        maximized: sideMaximized,
      } = workspaceView(next, false);
      const { tabLeftOrder, order: orderAfterLeave } =
        next === current
          ? { tabLeftOrder: current.tabLeftOrder, order: state.order }
          : updateTabLeftOrder({
              current,
              next,
              prevMainId: prevView.mainTab?.id,
              prevSideId: prevView.sideTab?.id,
              nextMainId: mainTab?.id,
              nextSideId: sideTab?.id,
              order: state.order,
            });
      const previous = next.tabHistory ? undefined : prevView.activeTab;
      const open = new Set(next.tabs.map((tab) => tab.id));
      const latest = next.tabHistory?.[0];
      const recordVisit =
        visit &&
        activeTab &&
        (orderAfterLeave === 0 ||
          latest?.id !== activeTab.id ||
          latest.order !== orderAfterLeave);
      if (next === current && !recordVisit) return state;
      const order = recordVisit ? orderAfterLeave + 1 : orderAfterLeave;
      const tabHistory = (
        next.tabHistory ?? (previous ? [{ id: previous.id, order: 0 }] : [])
      ).filter(
        ({ id }) => open.has(id) && (!recordVisit || id !== activeTab.id),
      );
      if (recordVisit) tabHistory.unshift({ id: activeTab.id, order });
      return {
        order,
        workspaces: {
          ...all,
          [id]: {
            ...next,
            lastChatId:
              activeTab?.kind === "chat"
                ? activeTab.id
                : activeTab?.kind === "topic"
                  ? activeTab.topic.chatId
                  : current.lastChatId,
            selected: mainTab?.id ?? "",
            sideSelected: sideTab?.id,
            tabHistory,
            tabLeftOrder,
            sideVisible,
            sideMaximized,
            activePane,
          },
        },
      };
    });
  }

  const activeId = workspaceView(workspace, false).activeTab?.id;
  const visitActiveTab = useEffectEvent(() => {
    if (activeId) update((current) => current, agentId, true);
  });
  useEffect(() => {
    visitActiveTab();
  }, [agentId, activeId]);

  return {
    workspaces,
    workspace,
    openTab(
      tab: WorkspaceTab,
      id = agentId,
      pane?: Pane,
      {
        canPreview,
        activatePane = true,
      }: {
        canPreview?: (tab: WorkspaceTab) => boolean;
        activatePane?: boolean;
      } = {},
    ) {
      update(
        (current) => {
          const existing = current.tabs.find((item) => item.id === tab.id);
          const target = defaultOpenPane(
            current.tabs,
            current.activePane,
            tab.id,
            pane,
          );
          if (existing) {
            const workspace =
              target !== paneOf(existing) || !canPreview?.(tab)
                ? keepTabOpen(current, tab.id)
                : current;
            const tabs = current.tabs.map((item) => {
              if (item.id !== tab.id) return item;
              const next = {
                ...item,
                diff: tab.diff ?? item.diff,
                diffTarget: tab.diffTarget ?? item.diffTarget,
                pane: target,
              };
              if (next.kind === "files" && tab.file) next.file = tab.file;
              if (next.kind === "shared") next.title = tab.title;
              if (
                next.kind === "browser" &&
                tab.kind === "browser" &&
                tab.htmlPreview
              ) {
                next.htmlPreview = tab.htmlPreview;
                next.title = tab.title;
              }
              return next;
            });
            return selectPaneTab(
              { ...workspace, tabs },
              tab.id,
              target,
              activatePane,
            );
          }

          const previous =
            canPreview &&
            current.tabs.find((item) => item.id === current.previews?.[target]);
          const opened = { ...tab, pane: target };
          const tabs =
            previous && canPreview(previous)
              ? current.tabs.map((item) => (item === previous ? opened : item))
              : [...current.tabs, opened];
          const previews = canPreview
            ? {
                ...current.previews,
                [target]: canPreview(tab) ? tab.id : undefined,
              }
            : current.previews;
          return selectPaneTab(
            { ...current, tabs, previews },
            tab.id,
            target,
            activatePane,
          );
        },
        id,
        activatePane,
      );
    },
    keepTab(id: string, targetAgentId = agentId) {
      update((current) => keepTabOpen(current, id), targetAgentId);
    },
    replaceTab(
      id: string,
      tab: WorkspaceTab,
      targetAgentId = agentId,
      fallbackPane?: Pane,
    ) {
      update((workspace) => {
        const kept = keepTabOpen(workspace, id);
        // A browser opened from a draft keeps targeting the resulting Chat.
        const current =
          id !== tab.id
            ? {
                ...kept,
                tabs: kept.tabs.map((item) =>
                  item.kind === "browser" && item.sourceConversation === id
                    ? { ...item, sourceConversation: tab.id }
                    : item,
                ),
              }
            : kept;
        const existing = current.tabs.find((item) => item.id === id);
        if (id !== tab.id && current.tabs.some((item) => item.id === tab.id)) {
          const kept = keepTabOpen(current, tab.id);
          return existing
            ? {
                ...kept,
                tabs: current.tabs.filter((item) => item !== existing),
              }
            : kept;
        }
        // The empty pane can submit without an open draft tab. Keep whichever
        // tab or pane the user may have switched to while the send was pending.
        if (!existing)
          return fallbackPane
            ? {
                ...current,
                tabs: [...current.tabs, { ...tab, pane: fallbackPane }],
              }
            : current;
        return {
          ...current,
          tabs: current.tabs.map((item) =>
            item.id === id ? { ...tab, pane: paneOf(item) } : item,
          ),
          selected: current.selected === id ? tab.id : current.selected,
          sideSelected:
            current.sideSelected === id ? tab.id : current.sideSelected,
          tabHistory: current.tabHistory?.map((visit) =>
            visit.id === id ? { ...visit, id: tab.id } : visit,
          ),
          tabLeftOrder: migrateTabLeftOrder(current, id, tab.id),
        };
      }, targetAgentId);
    },
    setChatTopic(agentId: string, chatId: string, expandedTopicId?: string) {
      update((current) => {
        const tab = current.tabs.find((item) => item.id === chatId);
        if (tab?.kind !== "chat" || tab.expandedTopicId === expandedTopicId)
          return current;
        return {
          ...current,
          tabs: current.tabs.map((item) =>
            item === tab ? { ...tab, expandedTopicId } : item,
          ),
        };
      }, agentId);
    },
    updateBrowserLocation(
      agent: string,
      id: string,
      url: string,
      title: string,
    ) {
      update((current) => {
        const tab = current.tabs.find((item) => item.id === id);
        if (tab?.kind !== "browser" || (tab.url === url && tab.title === title))
          return current;
        return {
          ...current,
          tabs: current.tabs.map((item) =>
            item === tab ? { ...tab, url, title } : item,
          ),
        };
      }, agent);
    },
    updateTerminalLayout(
      agent: string,
      id: string,
      change: (layout: TerminalLayout) => TerminalLayout,
    ) {
      update(
        (current) => ({
          ...current,
          tabs: current.tabs.map((tab) =>
            tab.kind === "terminal" && tab.id === id
              ? { ...tab, terminalLayout: change(tab.terminalLayout ?? { id }) }
              : tab,
          ),
        }),
        agent,
      );
    },
    selectTab(id: string) {
      update(
        (current) => {
          const tab = current.tabs.find((item) => item.id === id);
          return tab ? selectPaneTab(current, id, paneOf(tab)) : current;
        },
        agentId,
        true,
      );
    },
    focusPane(pane: Pane) {
      update((current) =>
        current.activePane === pane
          ? current
          : { ...current, activePane: pane },
      );
    },
    closeTabs(ids: ReadonlySet<string>, targetAgentId = agentId) {
      update((current) => {
        const tabs = current.tabs.filter((tab) => !ids.has(tab.id));
        if (tabs.length === current.tabs.length) return current;
        const previews = current.previews && {
          main: ids.has(current.previews.main ?? "")
            ? undefined
            : current.previews.main,
          side: ids.has(current.previews.side ?? "")
            ? undefined
            : current.previews.side,
        };
        const next = { ...current, tabs, previews };
        const { mainTab, sideTab, sideVisible, activeTab } = workspaceView(
          current,
          false,
        );
        for (const selected of [mainTab, sideTab]) {
          if (!selected || !ids.has(selected.id)) continue;
          const pane = paneOf(selected);
          const remaining = tabs.filter((tab) => paneOf(tab) === pane);
          const index = current.tabs
            .slice(0, current.tabs.indexOf(selected))
            .filter((tab) => paneOf(tab) === pane && !ids.has(tab.id)).length;
          const replacement =
            mostRecentlyLeftTab(remaining, current) ??
            remaining[Math.min(index, remaining.length - 1)];
          next[selectionKey(pane)] = replacement?.id ?? "";
        }
        if (!activeTab || !ids.has(activeTab.id)) return next;

        const pane = paneOf(activeTab);
        const replacement = selectedTab(next, pane);
        const other = sideVisible
          ? selectedTab(next, pane === "main" ? "side" : "main")
          : undefined;
        const previous =
          recentTab(
            [replacement, other].filter((tab) => tab !== undefined),
            current.tabHistory,
          ) ??
          replacement ??
          other;
        return previous
          ? selectPaneTab(next, previous.id, paneOf(previous))
          : next;
      }, targetAgentId);
    },
    moveTab(id: string, pane: Pane, targetId?: string) {
      update((current) => {
        const source = current.tabs.find((tab) => tab.id === id);
        if (!source) return current;
        const tabs = current.tabs.map((tab) =>
          tab.id === id ? { ...tab, pane } : tab,
        );
        const from = tabs.findIndex((tab) => tab.id === id);
        const to = targetId
          ? tabs.findIndex((tab) => tab.id === targetId && paneOf(tab) === pane)
          : tabs.length - 1;
        if (to < 0) return current;
        return {
          ...keepTabOpen(current, id),
          tabs: arrayMove(tabs, from, to),
          ...(pane === "side" && { sideVisible: true }),
          ...(pane === "main" && { sideMaximized: false }),
          ...(paneOf(source) !== pane && {
            [selectionKey(pane)]: id,
            activePane: pane,
          }),
        };
      });
    },
    toggleSidePane() {
      update((current) => ({
        ...current,
        sideVisible: current.sideVisible === false,
      }));
    },
    toggleSideMaximized() {
      update((current) => ({
        ...current,
        sideMaximized: !current.sideMaximized,
      }));
    },
    resizePanes(splitRatio: number) {
      update((current) => ({ ...current, splitRatio }));
    },
  };
}
