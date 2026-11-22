import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canPauseReply,
  interruptReply,
  resumeReply,
} from "@/features/chat/runControls";
import { active, api, queryClient } from "@/api/client";
import type { Agent, Conversation, SharedConversation } from "@/api/types.gen";
import {
  ActionContextMenu,
  type MenuAction,
  type MenuAnchor,
} from "@/components/ui/action-context-menu";
import {
  RenameConversationDialog,
  type RenameTarget,
} from "@/features/chat/RenameConversationDialog";
import { toolTab } from "@/components/workbench/WorkspaceActions";
import type { WorkspaceTab } from "@/components/workbench/useWorkspaces";
import type { WorkbenchOverview } from "@/components/workbench/workbenchOverview";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { pinId, type useRecentState } from "./useRecentState";

export type OpenConversationMode = "keep" | "other";
export type SidebarNavigation = {
  onConversation: (
    conversation: Conversation,
    mode?: OpenConversationMode,
  ) => void;
  onShared: (session: SharedConversation) => void;
  onLocate: (conversation: Conversation) => void;
  tabState: (conversation: Conversation) => "closed" | "preview" | "open";
  canSplit: boolean;
  onNewChat: (agentId: string) => void;
  onDuplicate: (source: Agent) => void;
  onChat: (agent: Agent) => void;
  onOpen: (tab: WorkspaceTab, agentId: string) => void;
};

export type MenuTarget =
  | {
      kind: "agent";
      agent: Agent;
      hasChats: boolean;
      unread: Conversation[];
      clearable: Conversation[];
    }
  | {
      kind: "conversation";
      conversation: Conversation;
      clearable?: boolean;
      restorable?: boolean;
    }
  | { kind: "shared"; session: SharedConversation };

export function AgentSidebarMenus({
  menu,
  close,
  navigation,
  overview,
  recent,
  readCursors,
  markRead,
  clear,
  restore,
}: {
  menu?: { anchor: MenuAnchor; target: MenuTarget };
  close: () => void;
  navigation: SidebarNavigation;
  overview?: WorkbenchOverview;
  recent: ReturnType<typeof useRecentState>;
  readCursors: Record<string, number>;
  markRead: (items: Conversation[]) => void;
  clear: (conversations: Conversation[]) => void;
  restore: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState<RenameTarget>();
  if (renaming)
    return (
      <RenameConversationDialog
        target={renaming}
        onClose={() => setRenaming(undefined)}
      />
    );
  if (!menu || !overview) return null;
  const { target, anchor } = menu;
  const groups: MenuAction[][] = [];
  let label: string;
  function group(...items: (MenuAction | false | undefined)[]) {
    const actions = items.filter((item): item is MenuAction => !!item);
    if (actions.length) groups.push(actions);
  }
  function pin(
    entry: string | SharedConversation,
    pinLabel = t("agents.pinToRecent"),
  ): MenuAction {
    const pinned = recent.pinnedIds.has(pinId(entry));
    return {
      id: "pin",
      label: pinned ? t("agents.unpinConversation") : pinLabel,
      run: () => recent.setPinned(entry, !pinned),
    };
  }
  if (target.kind === "agent") {
    const { agent, hasChats, unread, clearable } = target;
    label = agent.name;
    const archive: MenuAction = {
      id: agent.archived ? "restore" : "archive",
      label: t(agent.archived ? "profile.restore" : "profile.archive"),
      disabled:
        !agent.archived &&
        overview.runs.some(
          (run) =>
            run.agentId === agent.id &&
            (active(run.status) || (run.waiting && !run.waitingBlocked)),
        ),
      run: async () => {
        await api(
          "/agents/" + agent.id,
          { ...agent, archived: !agent.archived },
          "PUT",
        );
        await queryClient.invalidateQueries({ queryKey: ["overview"] });
      },
    };
    group(
      agent.archived
        ? archive
        : {
            id: "new-chat",
            label: t("agents.newChat"),
            run: () => navigation.onNewChat(agent.id),
          },
      hasChats && {
        id: "last-chat",
        label: t(
          agent.archived ? "agents.openHistoryChat" : "agents.continueLastChat",
        ),
        run: () => navigation.onChat(agent),
      },
    );
    group(
      {
        id: "files",
        label: t("agents.workspaceFiles"),
        run: () => navigation.onOpen(toolTab("files"), agent.id),
      },
      !agent.archived && {
        id: "terminal",
        label: t("agents.workspaceTerminal"),
        run: () => navigation.onOpen(toolTab("terminal"), agent.id),
      },
      {
        id: "profile",
        label: t("profile.title"),
        run: () => navigation.onOpen(toolTab("profile"), agent.id),
      },
      {
        id: "duplicate",
        label: `${t("agents.duplicate")}…`,
        run: () => navigation.onDuplicate(agent),
      },
    );
    group(
      unread.length > 0 && {
        id: "mark-all-read",
        label: t("agents.markAllRead"),
        run: () => markRead(unread),
      },
      clearable.length > 0 && {
        id: "clear-read",
        label: t("agents.clearReadActivity"),
        run: () => clear(clearable),
      },
    );
    group(!agent.archived && archive);
  } else if (target.kind === "shared") {
    label = target.session.title || t("shared.untitled");
    group({
      id: "open",
      label: t("agents.openConversation"),
      run: () => navigation.onShared(target.session),
    });
    group(pin(target.session));
  } else {
    const { conversation } = target;
    const chat = overview.chats.find((item) => item.id === conversation.chatId);
    if (!chat) return null;
    const topic = conversation.kind === "topic";
    const archived = overview.agents.some(
      (agent) => agent.id === conversation.agentId && agent.archived,
    );
    label = topic
      ? conversation.title || t("chat.topic")
      : displayChatTitle(chat, t);
    const state = navigation.tabState(conversation);
    const run =
      overview.runs.find(
        (item) =>
          item.sessionId === conversation.id &&
          (active(item.status) || item.status === "paused"),
      ) ??
      overview.runs.find(
        (item) => item.sessionId === conversation.id && item.waiting,
      );
    group(
      {
        id: "open",
        label: t(
          state === "preview"
            ? "workspace.keepTabOpen"
            : state === "open"
              ? "agents.openConversation"
              : "agents.openNewTab",
        ),
        run: () => navigation.onConversation(conversation, "keep"),
      },
      navigation.canSplit && {
        id: "open-other",
        label: t("agents.openOtherPane"),
        run: () => navigation.onConversation(conversation, "other"),
      },
      topic && {
        id: "locate",
        label: t(
          conversation.comparison ? "comparison.back" : "chat.locateTopic",
        ),
        run: () => navigation.onLocate(conversation),
      },
    );
    group(
      {
        id: "rename",
        label: t("agents.renameConversation") + "…",
        run: () =>
          setRenaming({
            chatId: conversation.chatId,
            topicId: topic ? conversation.id : undefined,
            title: label,
            trigger: anchor.trigger,
          }),
      },
      pin(conversation.id, topic ? t("chat.pinTopic") : undefined),
      conversation.unreadSequence > (readCursors[conversation.id] ?? 0) && {
        id: "mark-read",
        label: t("agents.markRead"),
        run: () => markRead([conversation]),
      },
      target.clearable && {
        id: "clear",
        label: t("agents.clearFromActivity"),
        run: () => clear([conversation]),
      },
      target.restorable && {
        id: "restore",
        label: t("agents.restoreConversation"),
        restoreFocus: false,
        run: () => restore(conversation.id),
      },
    );
    group(
      !archived && run?.status === "paused" && {
        id: "resume",
        label: t("chat.resumeReply"),
        run: () => resumeReply(run),
      },
      run &&
        ["starting", "running", "waiting_user"].includes(run.status) && {
          id: "stop",
          label: t(
            canPauseReply(run) ? "chat.pauseReply" : "agents.stopExecution",
          ),
          run: () => interruptReply(run),
        },
      !archived &&
        run?.waiting && {
          id: "cancel-waiting",
          label: t("after.cancelWaiting"),
          run: async () => {
            await api(`/runs/${run.id}/queue`, { action: "remove" });
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["overview"] }),
              queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
              queryClient.invalidateQueries({
                queryKey: ["session", run.sessionId],
              }),
            ]);
          },
        },
    );
  }
  const actions = groups.flatMap<MenuAction | null>((items, i) =>
    i ? [null, ...items] : items,
  );
  return (
    <ActionContextMenu
      label={label}
      actions={actions}
      point={anchor}
      onClose={(restoreFocus) => {
        close();
        if (restoreFocus) anchor.trigger.focus({ preventScroll: true });
      }}
    />
  );
}
