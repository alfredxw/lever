import {
  Check,
  CircleAlert,
  CircleHelp,
  CirclePause,
  Clock,
  Columns2,
  CornerDownRight,
  EyeOff,
  History,
  InfinityIcon,
  LoaderCircle,
  MessageCircle,
  Plus,
  Search,
  Send,
  SquareKanban,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { Agent } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { usePreferences } from "@/features/settings/Preferences";
import { binding, formatShortcut } from "@/features/settings/shortcuts";
import { cn } from "@/lib/utils";
import {
  buildChatHistory,
  filterChatHistory,
  type ChatHistoryEntry,
  type ChatHistoryOverview,
  type ChatSourceBadge,
  type ChatSourceFilter,
} from "./chatHistoryModel";
import type { WorkspaceTab } from "./useWorkspaces";

export function ChatSourceIcon({
  badge,
  size = 14,
  className,
}: {
  badge: ChatSourceBadge;
  size?: number;
  className?: string;
}) {
  switch (badge) {
    case "larkx":
    case "feishu":
    case "channel":
      return <Send size={size} className={className} aria-hidden="true" />;
    case "automation":
      return (
        <InfinityIcon size={size} className={className} aria-hidden="true" />
      );
    case "task":
      return (
        <SquareKanban size={size} className={className} aria-hidden="true" />
      );
    case "delegation":
      return (
        <CornerDownRight
          size={size}
          className={className}
          aria-hidden="true"
        />
      );
    case "comparison":
      return <Columns2 size={size} className={className} aria-hidden="true" />;
    default:
      return (
        <MessageCircle size={size} className={className} aria-hidden="true" />
      );
  }
}

export function chatSourceBadgeLabel(
  badge: ChatSourceBadge,
  t: TFunction,
): string {
  if (badge === "user") return "";
  return t(`chatHistory.badge.${badge}`);
}

function formatHistoryTime(timestamp: string, locale: string) {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  const now = new Date();
  const text =
    date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year:
            date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
  const full = date.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return { text, full };
}

export function ChatHistoryPopover({
  agent,
  overview,
  readCursors,
  openTabs,
  activeTabId,
  canSplit,
  onSelectChat,
  onNewChat,
  onSearchMessages,
  onPrefetchChat,
}: {
  agent: Agent;
  overview?: ChatHistoryOverview;
  readCursors: Record<string, number>;
  openTabs: readonly WorkspaceTab[];
  activeTabId?: string;
  canSplit: boolean;
  onSelectChat: (chatId: string, mode?: "keep" | "other") => void;
  onNewChat: () => void;
  onSearchMessages: (trigger: HTMLElement | null) => void;
  onPrefetchChat?: (chatId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { preferences } = usePreferences();
  const searchShortcut = binding(preferences.shortcutOverrides, "search");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ChatSourceFilter>("all");
  const [query, setQuery] = useState("");
  const [showQuiet, setShowQuiet] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const openTabIds = useMemo(
    () =>
      new Set(
        openTabs
          .filter((tab) => tab.kind === "chat")
          .map((tab) => tab.id),
      ),
    [openTabs],
  );

  const history = useMemo(
    () =>
      buildChatHistory({
        agentId: agent.id,
        overview,
        readCursors,
        openTabIds,
        activeTabId,
        titleOf: (chat) => displayChatTitle(chat, t),
        sourceLabelOf: (badge) => chatSourceBadgeLabel(badge, t),
      }),
    [agent.id, overview, readCursors, openTabIds, activeTabId, t],
  );

  const effectiveFilter: ChatSourceFilter = history.sourceFilters.some(
    (item) => item.id === filter,
  )
    ? filter
    : "all";

  const { entries: visibleEntries, hiddenQuietCount } = useMemo(
    () =>
      filterChatHistory({
        entries: history.entries,
        filter: effectiveFilter,
        query,
        showQuiet,
      }),
    [history.entries, effectiveFilter, query, showQuiet],
  );

  const boundedIndex =
    visibleEntries.length > 0
      ? Math.min(activeIndex, visibleEntries.length - 1)
      : -1;

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setFilter("all");
      setQuery("");
      setShowQuiet(false);
      setActiveIndex(0);
    }
  }

  function selectEntry(entry: ChatHistoryEntry, mode?: "keep" | "other") {
    setOpen(false);
    onSelectChat(entry.chat.id, mode);
  }

  function scrollActiveIntoView(index: number) {
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-history-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!visibleEntries.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = (boundedIndex + 1) % visibleEntries.length;
      setActiveIndex(next);
      scrollActiveIntoView(next);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        (boundedIndex - 1 + visibleEntries.length) % visibleEntries.length;
      setActiveIndex(next);
      scrollActiveIntoView(next);
    } else if (event.key === "Home" && event.target !== inputRef.current) {
      event.preventDefault();
      setActiveIndex(0);
      scrollActiveIntoView(0);
    } else if (event.key === "End" && event.target !== inputRef.current) {
      event.preventDefault();
      const last = visibleEntries.length - 1;
      setActiveIndex(last);
      scrollActiveIntoView(last);
    } else if (event.key === "Enter" && event.target === inputRef.current) {
      const target = visibleEntries[boundedIndex];
      if (!target) return;
      event.preventDefault();
      selectEntry(
        target,
        canSplit && (event.metaKey || event.ctrlKey) ? "other" : "keep",
      );
    }
  }

  const triggerLabel = t("chatHistory.trigger");
  const dialogLabel = t("chatHistory.label", { name: agent.name });

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          className={cn(
            "relative",
            open && "bg-control-selected text-foreground",
          )}
          aria-label={triggerLabel}
          aria-haspopup="dialog"
          title={triggerLabel}
        >
          <History aria-hidden="true" />
          {history.triggerAlert && (
            <span
              className="chat-history-trigger-dot"
              data-alert={history.triggerAlert}
              aria-hidden="true"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={7}
        aria-label={dialogLabel}
        className="chat-history-popover"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="chat-history-search">
          <Search
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            className="chat-history-input"
            value={query}
            placeholder={t("chatHistory.filterPlaceholder")}
            aria-label={t("chatHistory.filterPlaceholder")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("chatHistory.clearFilter")}
              title={t("chatHistory.clearFilter")}
              onClick={() => {
                setQuery("");
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          )}
          <span className="chat-history-agent-pill" title={agent.name}>
            {agent.name}
          </span>
        </div>

        {history.sourceFilters.length >= 2 && (
          <div className="chat-history-filters">
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              value={effectiveFilter}
              onValueChange={(value) => {
                if (!value) return;
                setFilter(value as ChatSourceFilter);
                setActiveIndex(0);
              }}
              aria-label={t("chatHistory.filterSources")}
              className="w-full justify-start"
            >
              {history.sourceFilters.map((item) => (
                <ToggleGroupItem
                  key={item.id}
                  value={item.id}
                  className="chat-history-filter-pill"
                >
                  <span>{t(`chatHistory.source.${item.id}`)}</span>
                  <span className="chat-history-filter-count tabular-nums">
                    {item.count}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )}

        <div
          ref={listRef}
          className="chat-history-list"
          role="listbox"
          aria-label={dialogLabel}
        >
          {visibleEntries.length === 0 ? (
            <div className="chat-history-empty">
              <span>
                {t(
                  history.entries.length === 0
                    ? "chatHistory.empty"
                    : "chatHistory.emptyFiltered",
                )}
              </span>
              {history.entries.length > 0 && (
                <span className="chat-history-empty-hint">
                  {t("chatHistory.emptyFilteredHint")}
                </span>
              )}
            </div>
          ) : (
            visibleEntries.map((entry, index) => {
              const isCurrent = entry.tabState === "active";
              const isActive = index === boundedIndex;
              const formattedTime = formatHistoryTime(
                entry.lastActivityAt,
                i18n.language,
              );
              const StatusIcon =
                entry.status === "waiting_user" || entry.status === "paused"
                  ? CirclePause
                  : entry.status === "waiting_blocked"
                    ? CircleAlert
                    : entry.status === "waiting"
                      ? Clock
                      : entry.status === "unknown"
                        ? CircleHelp
                        : entry.status === "running"
                          ? LoaderCircle
                          : undefined;
              const statusLabel =
                entry.status === "waiting_blocked"
                  ? t("after.statusBlocked")
                  : entry.status === "waiting"
                    ? t("after.statusWaiting")
                    : entry.status
                      ? t(`status.${entry.status}`, {
                          defaultValue: entry.status,
                        })
                      : "";
              const hasMeta =
                Boolean(entry.sourceLabel) ||
                entry.topicCount > 0 ||
                Boolean(entry.preview);

              return (
                <div
                  key={entry.chat.id}
                  data-history-index={index}
                  data-chat-id={entry.chat.id}
                  className={cn(
                    "chat-history-row",
                    isCurrent && "is-current",
                    isActive && "is-active",
                  )}
                  onPointerEnter={() => {
                    if (activeIndex !== index) setActiveIndex(index);
                    onPrefetchChat?.(entry.chat.id);
                  }}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className="chat-history-row-main"
                    title={
                      [entry.title, entry.sourceLabel, entry.preview]
                        .filter(Boolean)
                        .join("\n")
                    }
                    onFocus={() => {
                      setActiveIndex(index);
                      onPrefetchChat?.(entry.chat.id);
                    }}
                    onClick={() => selectEntry(entry, "keep")}
                  >
                    <span className="chat-history-row-icon">
                      <ChatSourceIcon badge={entry.sourceBadge} size={14} />
                    </span>
                    <span className="chat-history-row-body">
                      <span className="chat-history-row-top">
                        <span className="chat-history-row-title truncate">
                          {entry.title}
                        </span>
                        {StatusIcon && (
                          <StatusIcon
                            className={cn(
                              "size-3.5 shrink-0",
                              entry.status === "waiting_user" &&
                                "text-(--status-attention)",
                              entry.status === "waiting_blocked" &&
                                "text-destructive",
                              entry.status !== "waiting_user" &&
                                entry.status !== "waiting_blocked" &&
                                "text-muted-foreground",
                              StatusIcon === LoaderCircle &&
                                "animate-spin motion-reduce:animate-none",
                            )}
                            role="img"
                            aria-label={statusLabel}
                          />
                        )}
                        {!StatusIcon && entry.unread && (
                          <span
                            className="agent-unread shrink-0"
                            role="img"
                            aria-label={t("agents.unread")}
                          />
                        )}
                      </span>
                      {hasMeta && (
                        <span className="chat-history-row-meta">
                          {entry.sourceLabel && (
                            <span className="chat-history-source-chip">
                              {entry.sourceLabel}
                            </span>
                          )}
                          {entry.topicCount > 0 && (
                            <span className="shrink-0 tabular-nums">
                              {t("chatHistory.topics", {
                                count: entry.topicCount,
                              })}
                            </span>
                          )}
                          {entry.topicCount > 0 && entry.preview && (
                            <span
                              className="chat-history-row-sep"
                              aria-hidden="true"
                            >
                              ·
                            </span>
                          )}
                          {entry.preview && (
                            <span className="chat-history-row-preview truncate">
                              {entry.preview}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>

                  <div className="chat-history-row-trail">
                    {canSplit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="chat-history-split-action"
                        aria-label={t("chatHistory.openInOtherPane")}
                        title={t("chatHistory.openInOtherPane")}
                        onClick={() => selectEntry(entry, "other")}
                      >
                        <Columns2 aria-hidden="true" />
                      </Button>
                    )}
                    {formattedTime && (
                      <time
                        className={cn(
                          "chat-history-time tabular-nums",
                          canSplit && "chat-history-time-swappable",
                        )}
                        dateTime={entry.lastActivityAt}
                        title={formattedTime.full}
                      >
                        {formattedTime.text}
                      </time>
                    )}
                    {entry.tabState === "active" ? (
                      <span
                        className="chat-history-tab-mark"
                        title={t("chatHistory.currentTab")}
                        aria-label={t("chatHistory.currentTab")}
                      >
                        <Check size={13} aria-hidden="true" />
                      </span>
                    ) : entry.tabState === "open" ? (
                      <span
                        className="chat-history-tab-mark"
                        title={t("chatHistory.openTab")}
                        aria-label={t("chatHistory.openTab")}
                      >
                        <span className="chat-history-open-dot" />
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}

          {hiddenQuietCount > 0 && (
            <button
              type="button"
              className="chat-history-quiet-toggle"
              onClick={() => setShowQuiet(true)}
            >
              <EyeOff size={13} aria-hidden="true" />
              <span>
                {t("chatHistory.showQuiet", { count: hiddenQuietCount })}
              </span>
            </button>
          )}
        </div>

        <div className="chat-history-footer">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={agent.archived}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setOpen(false);
              onNewChat();
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {t("workspace.newChat")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setOpen(false);
              onSearchMessages(triggerRef.current);
            }}
          >
            <Search data-icon="inline-start" aria-hidden="true" />
            <span>{t("chatHistory.searchAllMessages")}</span>
            {searchShortcut && (
              <kbd className="chat-history-kbd" aria-hidden="true">
                {formatShortcut(searchShortcut)}
              </kbd>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
