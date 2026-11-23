export type Pane = "main" | "side";
export type PaneTab = { id: string; pane?: Pane };

export const tabPane = (tab: PaneTab): Pane => tab.pane ?? "main";
export const oppositePane = (pane: Pane): Pane =>
  pane === "side" ? "main" : "side";

/**
 * Default pane for opening a tab when the caller does not pin a pane:
 * keep an existing tab in place, otherwise fill an empty main pane before
 * falling back to the currently active pane.
 */
export function defaultOpenPane(
  tabs: readonly PaneTab[],
  activePane: Pane | undefined,
  id: string,
  preferredPane?: Pane,
): Pane {
  if (preferredPane) return preferredPane;
  const existing = tabs.find((item) => item.id === id);
  if (existing) return tabPane(existing);
  const hasMainTab = tabs.some((item) => tabPane(item) === "main");
  return hasMainTab ? (activePane ?? "main") : "main";
}

/**
 * Primary navigation entries (Chats and new Chats opened from the sidebar,
 * search, or other top-level pages) keep an already-open tab in place and
 * otherwise default to the main pane rather than crowding the companion pane.
 */
export function primaryTabPane(
  tabs: readonly PaneTab[],
  id: string,
  preferredPane?: Pane,
): Pane {
  if (preferredPane) return preferredPane;
  const existing = tabs.find((item) => item.id === id);
  return existing ? tabPane(existing) : "main";
}

/**
 * Companion details (file links, skills, turn diffs, Git diffs) open opposite
 * their originating pane when known, or in the side pane once main has tabs.
 */
export function companionPane(
  tabs: readonly PaneTab[],
  sourcePane?: Pane,
): Pane {
  if (sourcePane) return oppositePane(sourcePane);
  return tabs.some((item) => tabPane(item) === "main") ? "side" : "main";
}

/**
 * Resolve where a Topic and (optionally) its parent Chat should appear.
 * When revealing the Topic in its parent Chat, guarantee they occupy opposite
 * panes so the Topic never covers the Chat it is meant to reveal.
 */
export function resolveTopicPanes({
  tabs,
  chatId,
  topicTabId,
  preferredPane,
  revealInChat,
}: {
  tabs: readonly PaneTab[];
  chatId: string;
  topicTabId: string;
  preferredPane?: Pane;
  revealInChat: boolean;
}): { topicPane: Pane; chatPane?: Pane } {
  const existing = tabs.find((item) => item.id === topicTabId);
  const source = tabs.find((item) => item.id === chatId);
  const existingPane = existing ? tabPane(existing) : undefined;
  const sourcePane = source ? tabPane(source) : undefined;

  if (revealInChat && !preferredPane) {
    if (existingPane && sourcePane && existingPane === sourcePane) {
      return { chatPane: "main", topicPane: "side" };
    }
    const topicPane = existingPane ?? (sourcePane === "side" ? "main" : "side");
    const chatPane = sourcePane ?? oppositePane(topicPane);
    return { chatPane, topicPane };
  }

  const topicPane =
    preferredPane ??
    (existingPane ?? (sourcePane === "main" ? "side" : "main"));
  const chatPane = revealInChat
    ? sourcePane && sourcePane !== topicPane
      ? sourcePane
      : oppositePane(topicPane)
    : undefined;
  return { chatPane, topicPane };
}

/**
 * Resolve where a parent Chat should appear when locating a Topic or comparison.
 * Keep the Chat opposite an open source Topic tab; otherwise default to main.
 */
export function locateChatPane({
  tabs,
  chatId,
  sourceTopicTabId,
}: {
  tabs: readonly PaneTab[];
  chatId: string;
  sourceTopicTabId?: string;
}): Pane {
  const source = sourceTopicTabId
    ? tabs.find((item) => item.id === sourceTopicTabId)
    : undefined;
  const existing = tabs.find((item) => item.id === chatId);
  if (source) {
    const sourcePane = tabPane(source);
    if (existing && tabPane(existing) !== sourcePane) return tabPane(existing);
    return oppositePane(sourcePane);
  }
  return existing ? tabPane(existing) : "main";
}
