import { displayChatTitle } from "@/features/chat/conversationTitle";
import type { TFunction } from "i18next";
import { useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronDown, History, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, Chat, Conversation } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import {
  ImagePreview,
  ImagePreviewProvider,
} from "@/features/chat/ImagePreview";
import { NewChatComposer } from "@/features/chat/NewChat";
import { toolTab } from "./WorkspaceActions";
import { tabIcons } from "./WorkspaceTabs";
import type { WorkspaceTab } from "./useWorkspaces";

const recentPageSize = 5;
const tools = ["files", "profile", "terminal"] as const;

type RecentConversation = {
  chatId: string;
  topicId?: string;
  title: string;
  lastActive: number;
};

function recentConversations(
  agentId: string,
  chats: Chat[],
  conversations: Conversation[],
  t: TFunction,
): RecentConversation[] {
  const byChatId = new Map(
    chats.map((chat) => [
      chat.id,
      {
        chatId: chat.id,
        title: displayChatTitle(chat, t),
        lastActive: Date.parse(chat.updatedAt) || 0,
      },
    ]),
  );
  const topics: RecentConversation[] = [];
  for (const conversation of conversations) {
    if (conversation.agentId !== agentId) continue;
    const chat = byChatId.get(conversation.chatId);
    if (!chat) continue;
    const lastActive = Date.parse(conversation.messageAt) || 0;
    if (conversation.kind === "main") {
      chat.lastActive = Math.max(chat.lastActive, lastActive);
    } else if (conversation.kind === "topic") {
      topics.push({
        chatId: conversation.chatId,
        topicId: conversation.id,
        title: conversation.title,
        lastActive,
      });
    }
  }
  return [...byChatId.values(), ...topics].sort(
    (a, b) => b.lastActive - a.lastActive,
  );
}

export function WorkspaceStart({
  agent,
  agents,
  chats,
  conversations,
  visible,
  hasDraft,
  onFocus,
  onOpenDraft,
  onConversation,
  onOpen,
  onSent,
}: {
  agent: Agent;
  agents: Agent[];
  chats: Chat[];
  conversations: Conversation[];
  visible: boolean;
  hasDraft: boolean;
  onFocus: () => void;
  onOpenDraft: () => void;
  onConversation: (chatId: string, topicId?: string) => void;
  onOpen: (tab: WorkspaceTab) => void;
  onSent: (chatId: string) => void;
}) {
  const { t } = useTranslation();
  const openDraft = !agent.archived && hasDraft;
  const [limit, setLimit] = useState(recentPageSize);
  const list = useRef<HTMLUListElement>(null);
  const recent = useMemo(
    () => recentConversations(agent.id, chats, conversations, t),
    [agent.id, chats, conversations, t],
  );
  function loadMore() {
    setLimit(limit + recentPageSize);
    requestAnimationFrame(() =>
      list.current?.children.item(limit)?.querySelector("button")?.focus(),
    );
  }
  return (
    <div
      className="workspace-start"
      data-pane="main"
      inert={!visible}
      aria-hidden={!visible}
      onPointerDown={onFocus}
      onFocusCapture={onFocus}
    >
      <ImagePreviewProvider>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto px-(--page-gutter) pt-6 pb-[clamp(24px,8vh,80px)]">
          <div className="mx-auto my-auto w-full max-w-[40rem] shrink-0">
            <header className="mb-4 flex items-center gap-3">
              <AgentAvatar agent={agent} />
              <div className="min-w-0">
                <h2
                  className="truncate text-lg leading-tight font-semibold tracking-tight outline-none"
                  title={agent.name}
                  tabIndex={-1}
                >
                  {agent.name}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t("workspace.label")}
                </p>
              </div>
            </header>
            {!agent.archived && !hasDraft && (
              <NewChatComposer
                agent={agent}
                agents={agents}
                visible={visible}
                onSent={onSent}
              />
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {openDraft && (
                <Button type="button" size="sm" onClick={onOpenDraft}>
                  <MessageCircle aria-hidden="true" />
                  {t("workspace.openDraft")}
                </Button>
              )}
              {tools.map((kind) => {
                const Icon = tabIcons[kind];
                const label = t(`workspace.${kind}`);
                return (
                  <Button
                    key={kind}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("workspace.openTool", { tool: label })}
                    onClick={() => onOpen(toolTab(kind))}
                  >
                    <Icon aria-hidden="true" />
                    {label}
                  </Button>
                );
              })}
            </div>
            {recent.length > 0 && (
              <section className="mt-6" aria-labelledby="workspace-recent">
                <h3
                  id="workspace-recent"
                  className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"
                >
                  <History className="size-3.5" aria-hidden="true" />
                  {t("workspace.recentConversations")}
                </h3>
                <ul
                  ref={list}
                  className="divide-y divide-(--surface-border) rounded-xl border border-(--surface-border) bg-(--panel-background)"
                >
                  {recent.slice(0, limit).map(({ chatId, topicId, title }) => {
                    const Icon = tabIcons[topicId ? "topic" : "chat"];
                    const label = title || t("chat.topic");
                    return (
                      <li key={topicId ?? chatId} className="p-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-10 w-full justify-start gap-3 px-3 text-left"
                          title={label}
                          onClick={() => onConversation(chatId, topicId)}
                        >
                          <Icon
                            className="text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {label}
                          </span>
                          <span className="text-xs font-normal text-muted-foreground">
                            {t(topicId ? "chat.topic" : "workspace.chat")}
                          </span>
                          <ArrowRight
                            className="size-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                {recent.length > limit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 text-muted-foreground"
                    onClick={loadMore}
                  >
                    {t("workspace.loadMoreConversations")}
                    <ChevronDown aria-hidden="true" />
                  </Button>
                )}
              </section>
            )}
          </div>
        </div>
        <ImagePreview />
      </ImagePreviewProvider>
    </div>
  );
}
