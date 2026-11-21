import { useState } from "react";
import type { WorkspaceTab } from "./useWorkspaces";

const retainedConversationCount = 6;
type ConversationTab = WorkspaceTab & { kind: "chat" | "topic" };
type ConversationPanel = { agentId: string; tab: ConversationTab };

export function isConversationTab(tab?: WorkspaceTab): tab is ConversationTab {
  return tab?.kind === "chat" || tab?.kind === "topic";
}

export function useRecentConversations(
  agentId: string,
  main?: WorkspaceTab,
  side?: WorkspaceTab,
) {
  const mainConversation = isConversationTab(main) ? main : undefined;
  const sideConversation = isConversationTab(side) ? side : undefined;
  const [recent, setRecent] = useState<ConversationPanel[]>([]);
  const visible = [mainConversation, sideConversation].flatMap((tab) =>
    tab ? [{ agentId, tab }] : [],
  );
  if (visible.some(({ tab }, index) => recent[index]?.tab !== tab)) {
    // Evict old panels in the same render that selects the next conversation.
    setRecent(
      [
        ...visible,
        ...recent.filter(({ tab }) =>
          visible.every((entry) => entry.tab.id !== tab.id),
        ),
      ].slice(0, retainedConversationCount),
    );
  }
  function forgetClosed(
    agentId: string,
    ids: ReadonlySet<string>,
    tabs: WorkspaceTab[],
  ) {
    const hasConversation = tabs.some(
      (tab) => isConversationTab(tab) && !ids.has(tab.id),
    );
    setRecent((current) =>
      current.filter(
        (entry) =>
          entry.agentId !== agentId ||
          (hasConversation && !ids.has(entry.tab.id)),
      ),
    );
  }
  return { recent, forgetClosed };
}
