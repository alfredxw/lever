import type { WorkbenchOverview } from "@/components/workbench/workbenchOverview";
import { useQuery } from "@tanstack/react-query";
import {
  CircleHelp,
  CirclePause,
  Eraser,
  LoaderCircle,
  Pin,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { active, api } from "@/api/client";
import type {
  Conversation,
  SharedConversation,
  SharedConversations,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { tabIcons } from "@/components/workbench/WorkspaceTabs";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isWorking } from "@/features/chat/RunStatus";
import {
  sharedConversationKey,
  sharedConversationsPath,
} from "@/features/chat/sharedConversations";
import { useEventCallback } from "@/hooks/useEventCallback";
import { cn } from "@/lib/utils";

import { pinId, type useRecentState } from "./useRecentState";
import type { MenuTarget } from "./AgentSidebarMenus";
import {
  rowMenuHandlers,
  type MenuAnchor,
} from "@/components/ui/action-context-menu";
import { displayChatTitle } from "@/features/chat/conversationTitle";

type RecentTarget = Extract<MenuTarget, { kind: "conversation" | "shared" }>;
type RecentEntry = {
  source: Conversation | SharedConversation;
  id: string;
  title: string;
  origin: string;
  updatedAt: string;
  status?: string;
  sequence?: number;
  finishedAt?: string;
};

export function RecentConversations({
  overview,
  visible,
  selected,
  readCursors,
  onConversation,
  onShared,
  recent,
  onMenu,
}: {
  overview?: WorkbenchOverview;
  visible: boolean;
  recent: ReturnType<typeof useRecentState>;
  onMenu: (anchor: MenuAnchor, target: MenuTarget) => void;
  selected?: string;
  readCursors: Record<string, number>;
  onConversation: (conversation: Conversation) => void;
  onShared: (conversation: SharedConversation) => void;
}) {
  const { t, i18n } = useTranslation();
  const { pins, cleared, pinnedIds, setPinned, clearConversations } = recent;
  const [today, setToday] = useState(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  });
  useEffect(() => {
    const next = new Date(today);
    next.setDate(next.getDate() + 1);
    const timer = window.setTimeout(
      () => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        setToday(date);
      },
      Math.max(0, next.getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [today]);
  const sources = useQuery({
    queryKey: ["shared-conversations"],
    queryFn: ({ signal }) =>
      api<SharedConversations>(
        sharedConversationsPath,
        undefined,
        "GET",
        signal,
      ),
    enabled: visible,
    refetchOnWindowFocus: true,
    refetchInterval: visible ? 3000 : false,
    staleTime: 0,
    retry: false,
  });
  const openEntry = useEventCallback((target: RecentTarget) => {
    if (target.kind === "shared") onShared(target.session);
    else onConversation(target.conversation);
  });
  const { groups, priority } = useMemo(() => {
    const agents = new Map(overview?.agents.map((agent) => [agent.id, agent]));
    const chats = new Map(overview?.chats.map((chat) => [chat.id, chat]));
    const pending = new Set(
      overview?.requests.map((request) => request.sessionId),
    );
    const runs = new Map(
      overview?.runs
        .filter((run) => active(run.status))
        .map((run) => [run.sessionId, run.status]),
    );
    const entries = (overview?.conversations ?? []).flatMap<RecentEntry>(
      (conversation) => {
        const agent = agents.get(conversation.agentId);
        const chat = chats.get(conversation.chatId);
        if (!agent || agent.archived || !chat) return [];
        const topic = conversation.kind === "topic";
        const messageAt = conversation.messageAt || chat.updatedAt;
        const sequence = conversation.unreadSequence;
        // Older saved activity predates the completion timestamp.
        const finishedAt =
          conversation.finishedAt ?? (sequence ? messageAt : undefined);
        return [
          {
            source: conversation,
            id: conversation.id,
            title: topic
              ? conversation.title || t("chat.topic")
              : displayChatTitle(chat, t),
            origin: topic
              ? `${agent.name} · ${displayChatTitle(chat, t)}`
              : agent.name,
            updatedAt:
              finishedAt && Date.parse(finishedAt) > Date.parse(messageAt)
                ? finishedAt
                : messageAt,
            status: pending.has(conversation.id)
              ? "waiting_user"
              : runs.get(conversation.id),
            sequence,
            finishedAt,
          },
        ];
      },
    );
    // A pinned native conversation can age out of the native recent list.
    const shared = new Map<string, SharedConversation>();
    for (const pin of pins) {
      if (typeof pin !== "string")
        shared.set(sharedConversationKey(pin), { ...pin, activity: undefined });
    }
    for (const session of sources.data?.conversations ?? [])
      shared.set(sharedConversationKey(session), session);
    for (const [id, session] of shared) {
      const directory = session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
      entries.push({
        id,
        source: session,
        title: session.title || t("shared.untitled"),
        origin: directory,
        updatedAt: session.updatedAt,
        status: session.activity?.status,
      });
    }
    entries.sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
    const todayKey = today.toDateString();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = yesterday.toDateString();
    const priority: RecentEntry[] = [];
    const pinned = new Map<string, RecentEntry>();
    const dates = new Map<string, { title: string; entries: RecentEntry[] }>();
    for (const entry of entries) {
      if (pinnedIds.has(entry.id)) {
        pinned.set(entry.id, entry);
      } else if (
        entry.status ||
        (entry.finishedAt &&
          Date.parse(entry.finishedAt) >= today.getTime() &&
          (entry.sequence ?? 0) > (cleared[entry.id] ?? 0))
      ) {
        priority.push(entry);
      } else {
        const date = new Date(entry.updatedAt);
        const day = date.toDateString();
        const group = dates.get(day);
        if (group) {
          group.entries.push(entry);
          continue;
        }
        const title =
          day === todayKey
            ? t("agents.recentToday")
            : day === yesterdayKey
              ? t("agents.recentYesterday")
              : Number.isFinite(date.getTime())
                ? date.toLocaleDateString(i18n.language, {
                    month: "short",
                    day: "numeric",
                    ...(date.getFullYear() !== today.getFullYear() && {
                      year: "numeric",
                    }),
                  })
                : t("agents.recentEarlier");
        dates.set(day, { title, entries: [entry] });
      }
    }
    const groups = [
      { id: "priority", title: t("agents.recentPriority"), entries: priority },
      {
        id: "pinned",
        title: t("agents.recentPinned"),
        entries: pins.flatMap((pin) => {
          const entry = pinned.get(pinId(pin));
          return entry ? [entry] : [];
        }),
      },
      ...Array.from(dates, ([id, group]) => ({ id, ...group })),
    ];
    return { groups: groups.filter((group) => group.entries.length), priority };
  }, [
    overview,
    sources.data,
    pins,
    pinnedIds,
    cleared,
    today,
    i18n.language,
    t,
  ]);
  const isUnread = (entry: RecentEntry) =>
    (entry.sequence ?? 0) > (readCursors[entry.id] ?? 0);
  const clearable = priority.flatMap((entry) =>
    !entry.status && !isUnread(entry) && !("runtime" in entry.source)
      ? [entry.source]
      : [],
  );
  const clearLabel = t("agents.clearReadChats");
  return (
    <TooltipProvider delayDuration={350}>
      {!overview || (sources.isLoading && !groups.length) ? <Loading /> : null}
      {groups.map(({ id, title, entries }) => (
        <section key={id} aria-label={title} className="not-first:mt-3">
          <div className="flex h-8 items-center justify-between gap-2 px-2 text-muted-foreground">
            <h2 className="truncate text-xs font-medium">{title}</h2>
            {id === "priority" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={clearLabel}
                      disabled={!clearable.length}
                      onClick={() => clearConversations(clearable)}
                    >
                      <Eraser />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{clearLabel}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <ul>
            {entries.map((entry) => (
              <RecentConversationRow
                key={entry.id}
                t={t}
                id={entry.id}
                source={entry.source}
                title={entry.title}
                origin={entry.origin}
                status={entry.status}
                selected={selected === entry.id}
                unread={isUnread(entry)}
                isPinned={pinnedIds.has(entry.id)}
                setPinned={setPinned}
                onOpen={openEntry}
                onMenu={onMenu}
              />
            ))}
          </ul>
        </section>
      ))}
      {overview && !sources.isLoading && !groups.length && (
        <p className="sidebar-empty">{t("shared.empty")}</p>
      )}
      {sources.error && (
        <ErrorNotice
          error={sources.error}
          retry={() => void sources.refetch()}
        />
      )}
      {!!sources.data?.unavailable.length && (
        <p role="status" className="sidebar-empty">
          {t("shared.sourceUnavailable", {
            sources: sources.data.unavailable.join(", "),
          })}
        </p>
      )}
    </TooltipProvider>
  );
}

const RecentConversationRow = memo(function RecentConversationRow({
  t,
  id,
  source,
  title,
  origin,
  status,
  selected,
  unread,
  isPinned,
  setPinned,
  onOpen,
  onMenu,
}: Pick<RecentEntry, "id" | "source" | "title" | "origin" | "status"> & {
  t: TFunction;
  selected: boolean;
  unread: boolean;
  isPinned: boolean;
  setPinned: ReturnType<typeof useRecentState>["setPinned"];
  onOpen: (target: RecentTarget) => void;
  onMenu: (anchor: MenuAnchor, target: MenuTarget) => void;
}) {
  const target: RecentTarget =
    "runtime" in source
      ? { kind: "shared", session: source }
      : { kind: "conversation", conversation: source };
  const ConversationIcon =
    tabIcons[
      target.kind === "conversation" && target.conversation.kind === "topic"
        ? "topic"
        : "chat"
    ];
  const summary = source.preview || origin;
  const pinLabel = t(
    isPinned ? "agents.unpinConversation" : "agents.pinConversation",
  );
  const pinButtonId = `recent-pin-${encodeURIComponent(id)}`;
  const StatusIcon =
    status === "waiting_user"
      ? CirclePause
      : status === "unknown"
        ? CircleHelp
        : status && isWorking(status)
          ? LoaderCircle
          : undefined;
  return (
    <li className="recent-row relative">
      <button
        type="button"
        className={cn(
          "agent-contact conversation-contact recent-conversation",
          selected && "selected",
        )}
        aria-current={selected ? "true" : undefined}
        data-session-id={id}
        title={[
          title,
          target.kind === "shared" ? target.session.cwd || origin : origin,
        ]
          .filter(Boolean)
          .join("\n")}
        {...rowMenuHandlers((anchor) => onMenu(anchor, target))}
        onClick={() => onOpen(target)}
      >
        <span className="conversation-content">
          <span className="contact-name">
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
              {target.kind === "shared" ? (
                <RuntimeIcon provider={target.session.runtime} size={12} />
              ) : (
                <ConversationIcon size={12} />
              )}
            </span>
            <span className="flex h-[1lh] min-w-0 flex-1 flex-wrap gap-x-1.5 overflow-hidden">
              <span className="max-w-full truncate">{title}</span>
              {source.preview && origin && (
                <span className="max-w-full truncate font-normal text-muted-foreground">
                  {origin}
                </span>
              )}
            </span>
            {unread && (
              <span
                className="agent-unread shrink-0"
                role="img"
                aria-label={t("agents.unread")}
              />
            )}
            {StatusIcon && (
              <StatusIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground",
                  StatusIcon === LoaderCircle &&
                    "animate-spin motion-reduce:animate-none",
                )}
                aria-label={t(`status.${status}`)}
                role="img"
              />
            )}
          </span>
          {summary && (
            <span className="conversation-origin">
              <span
                className={cn(
                  "min-w-0",
                  source.preview ? "line-clamp-2 wrap-anywhere" : "truncate",
                )}
              >
                {summary}
              </span>
            </span>
          )}
        </span>
      </button>
      <Toggle
        id={pinButtonId}
        size="sm"
        className="recent-pin absolute end-1 top-1 size-7 min-w-0 p-0 text-muted-foreground"
        pressed={isPinned}
        aria-label={pinLabel}
        title={pinLabel}
        onPressedChange={(pressed) => {
          const focused = document
            .getElementById(pinButtonId)
            ?.matches(":focus-visible");
          setPinned(target.kind === "shared" ? target.session : id, pressed);
          if (focused)
            window.requestAnimationFrame(() =>
              document.getElementById(pinButtonId)?.focus(),
            );
        }}
      >
        <Pin className={cn(isPinned && "fill-current")} />
      </Toggle>
    </li>
  );
});
