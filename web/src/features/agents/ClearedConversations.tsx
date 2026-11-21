import { useState, type RefObject } from "react";
import { ChevronDown, MessagesSquare, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, Chat, Conversation } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  rowMenuHandlers,
  type MenuAnchor,
} from "@/components/ui/action-context-menu";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";

const archivePageSize = 5;

type ClearedConversation = {
  agent: Agent;
  chat: Chat;
  conversation: Conversation;
  title: string;
};

export function ClearedConversations({
  groups,
  selectedAgent,
  selectedSession,
  expandedTrigger,
  onConversation,
  onMenu,
  onRestore,
}: {
  groups: ReadonlyMap<string, ClearedConversation[]>;
  selectedAgent: string;
  selectedSession?: string;
  expandedTrigger: RefObject<HTMLButtonElement | null>;
  onConversation: (conversation: Conversation) => void;
  onMenu: (anchor: MenuAnchor, conversation: Conversation) => void;
  onRestore: (id: string) => void;
}) {
  const { t } = useTranslation();
  const restoreLabel = t("agents.restoreConversation");
  const [expandedAgent, setExpandedAgent] = useState<string | null>();
  const [limits, setLimits] = useState<Record<string, number>>({});
  if (!groups.size) {
    return (
      <Empty>
        <EmptyDescription>
          {t("agents.noClearedConversations")}
        </EmptyDescription>
      </Empty>
    );
  }
  const preferred = expandedAgent ?? selectedAgent;
  const openAgent = groups.has(preferred)
    ? preferred
    : groups.keys().next().value;
  return Array.from(groups, ([id, items]) => {
    const { agent } = items[0];
    const open = expandedAgent !== null && openAgent === id;
    const limit = limits[id] ?? archivePageSize;
    return (
      <Collapsible
        key={id}
        data-agent-id={id}
        open={open}
        onOpenChange={(expanded) => setExpandedAgent(expanded ? id : null)}
      >
        <CollapsibleTrigger
          className="agent-contact conversation-contact min-h-10"
          ref={open ? expandedTrigger : undefined}
          title={agent.name}
        >
          <AgentAvatar agent={agent} size="sm" />
          <span className="contact-name min-w-0 flex-1">
            <span className="truncate">{agent.name}</span>
          </span>
          {agent.archived && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("common.archived")}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground",
              !open && "-rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent asChild>
          <ul className="agent-activity-list cleared-conversation-list">
            {items.slice(0, limit).map(({ chat, conversation, title }) => {
              const topic = conversation.kind === "topic";
              const label = title || t("chat.topic");
              const parentChat = topic ? displayChatTitle(chat, t) : "";
              const preview =
                (conversation.preview !== label && conversation.preview) ||
                parentChat;
              const selected = selectedSession === conversation.id;
              return (
                <li key={conversation.id} className="agent-activity-row">
                  <button
                    type="button"
                    className={cn(
                      "agent-contact conversation-contact min-h-10",
                      selected && "selected",
                    )}
                    data-session-id={conversation.id}
                    aria-current={selected ? "true" : undefined}
                    title={parentChat ? `${label}\n${parentChat}` : label}
                    onClick={() => onConversation(conversation)}
                    {...(!agent.archived
                      ? rowMenuHandlers((anchor) =>
                          onMenu(anchor, conversation),
                        )
                      : {})}
                  >
                    <span className="conversation-content">
                      <span className="contact-name">
                        {topic && (
                          <MessagesSquare
                            size={12}
                            className="shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                        <span className="truncate">{label}</span>
                      </span>
                      {preview && (
                        <span className="conversation-origin">
                          <span className="truncate">{preview}</span>
                        </span>
                      )}
                    </span>
                  </button>
                  {!agent.archived && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="agent-activity-action text-muted-foreground"
                      aria-label={restoreLabel}
                      title={restoreLabel}
                      onClick={() => onRestore(conversation.id)}
                    >
                      <RotateCcw aria-hidden="true" />
                    </Button>
                  )}
                </li>
              );
            })}
            {items.length > limit && (
              <li>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground"
                  onClick={(event) => {
                    const list = event.currentTarget.closest("ul");
                    setLimits((current) => ({
                      ...current,
                      [id]: limit + archivePageSize,
                    }));
                    requestAnimationFrame(() =>
                      list?.children
                        .item(limit)
                        ?.querySelector("button")
                        ?.focus(),
                    );
                  }}
                >
                  {t("agents.showMoreClearedConversations")}
                </Button>
              </li>
            )}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    );
  });
}
