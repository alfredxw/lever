import type { WorkbenchOverview } from "@/components/workbench/workbenchOverview";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  CirclePause,
  Clock,
  Eraser,
  Folders,
  LoaderCircle,
  MessageCircle,
  Pin,
  Plus,
  Search,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Agent, Conversation } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  rowMenuHandlers,
  type MenuAnchor,
} from "@/components/ui/action-context-menu";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import {
  AgentSidebarMenus,
  type MenuTarget,
  type SidebarNavigation,
} from "./AgentSidebarMenus";
import { pinId, type useRecentState } from "./useRecentState";
import type { AgentSort, useAgentOrder } from "./useAgentOrder";
import { isWorking } from "@/features/chat/RunStatus";
import { useEventCallback } from "@/hooks/useEventCallback";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { ClearedConversations } from "./ClearedConversations";
import { RecentConversations } from "./RecentConversations";
import { useProviders } from "@/features/runtime/queries";
import { usePreferences } from "@/features/settings/Preferences";
import {
  ariaShortcut,
  binding,
  formatShortcut,
} from "@/features/settings/shortcuts";

type AgentView = "all" | "recent" | "archived";

const SidebarListPanel = memo(
  function SidebarListPanel({
    value,
    active,
    children,
  }: {
    value: AgentView;
    active: boolean;
    children: () => ReactNode;
  }) {
    const [visited, setVisited] = useState(active);
    if (active && !visited) setVisited(true);
    return (
      <TabsContent
        value={value}
        forceMount
        hidden={!active}
        className="agent-list"
      >
        {(active || visited) && children()}
      </TabsContent>
    );
  },
  (previous, next) =>
    previous.value === next.value && !previous.active && !next.active,
);

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return groups;
}

export function AgentSidebar({
  overview,
  activity,
  ordering: { agents, sort, setSort, moveAgent },
  recent,
  selected,
  readCursors,
  selectedSessionId,
  visible,
  markRead,
  onSearch,
  onCreate,
  onChoose,
  onPreview,
  ...navigation
}: SidebarNavigation & {
  overview: UseQueryResult<WorkbenchOverview>;
  activity?: WorkbenchOverview;
  ordering: ReturnType<typeof useAgentOrder>;
  recent: ReturnType<typeof useRecentState>;
  selected: string;
  readCursors: Record<string, number>;
  selectedSessionId?: string;
  visible: boolean;
  markRead: (items: Conversation[]) => void;
  onSearch: MouseEventHandler<HTMLButtonElement>;
  onCreate: () => void;
  onChoose: (id: string) => void;
  onPreview: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { onShared, onOpen, onChat } = navigation;
  const onConversation = useEventCallback(navigation.onConversation);
  const [menu, setMenu] = useState<{
    anchor: MenuAnchor;
    target: MenuTarget;
  }>();
  const openMenu = useCallback(
    (anchor: MenuAnchor, target: MenuTarget) => setMenu({ anchor, target }),
    [],
  );
  const providers = useProviders();
  const { preferences } = usePreferences();
  const searchShortcut = binding(preferences.shortcutOverrides, "search");
  const [filter, setFilter] = useState<AgentView>(() =>
    localStorage.getItem("lever:agent-view") === "recent" ? "recent" : "all",
  );
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const archiveTab = useRef<HTMLButtonElement>(null);
  const expandedArchiveTrigger = useRef<HTMLButtonElement>(null);
  const { chats, runs, conversations, requests } = activity ?? {};

  const sidebarItems = useMemo(() => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const chatsById = new Map(chats?.map((chat) => [chat.id, chat]));
    const chatsByAgent = groupBy(chats ?? [], (chat) => chat.agentId);
    const runsByAgent = groupBy(runs ?? [], (run) => run.agentId);
    const runsBySession = groupBy(runs ?? [], (run) => run.sessionId);
    const activityByAgent = groupBy(
      conversations ?? [],
      (item) => item.agentId,
    );
    const pendingSessions = new Set(
      requests?.map((request) => request.sessionId),
    );
    const pinOrder = new Map(
      recent.pins.map((pin, index) => [pinId(pin), index]),
    );
    const unpinnedIndex = recent.pins.length;
    const conversationItems = (conversations ?? []).flatMap((conversation) => {
      const agent = agentsById.get(conversation.agentId);
      const chat = chatsById.get(conversation.chatId);
      if (!agent || !chat) return [];
      const title =
        conversation.kind === "main"
          ? displayChatTitle(chat, t)
          : conversation.title;
      const unread =
        conversation.unreadSequence > (readCursors[conversation.id] ?? 0);
      const sessionRuns = runsBySession.get(conversation.id);
      const run =
        sessionRuns?.find(
          (run) => run.status !== "queued" && run.status !== "paused",
        ) ?? sessionRuns?.find((run) => run.waiting);
      const pending = pendingSessions.has(conversation.id);
      const pinIndex =
        conversation.kind === "topic"
          ? pinOrder.get(conversation.id)
          : undefined;
      const readAndIdle = !unread && !run && !pending;
      return [
        {
          conversation,
          agent,
          chat,
          title,
          unread,
          run,
          pending,
          pinIndex,
          readAndIdle,
          canClear: readAndIdle && pinIndex === undefined,
        },
      ];
    });
    // Show pinned topics first and keep the order of the other activity rows.
    const activityItems = conversationItems
      .filter(
        ({ agent, conversation, unread, run, pending, pinIndex }) =>
          !agent.archived &&
          (pinIndex !== undefined ||
            unread ||
            run ||
            pending ||
            conversation.unreadSequence >
              (recent.cleared[conversation.id] ?? 0)),
      )
      .sort(
        (a, b) => (a.pinIndex ?? unpinnedIndex) - (b.pinIndex ?? unpinnedIndex),
      );
    const itemsByAgent = groupBy(activityItems, ({ agent }) => agent.id);
    // Clear records cover the activity seen at the time, until new work arrives.
    const cleared = conversationItems
      .filter(
        ({ readAndIdle, conversation: { id, unreadSequence } }) =>
          readAndIdle && unreadSequence <= (recent.cleared[id] ?? -1),
      )
      .map((item) => ({
        ...item,
        lastActivity: Math.max(
          Date.parse(item.conversation.messageAt || item.chat.updatedAt) || 0,
          Date.parse(item.conversation.finishedAt ?? "") || 0,
        ),
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const sorted = agents.map((agent) => {
      const chats = chatsByAgent.get(agent.id) ?? [];
      const runs = runsByAgent.get(agent.id) ?? [];
      const activity = activityByAgent.get(agent.id) ?? [];
      const conversations = itemsByAgent.get(agent.id) ?? [];
      return {
        agent,
        chats,
        conversations,
        clearable: conversations
          .filter(({ canClear }) => canClear)
          .map(({ conversation }) => conversation),
        activity: activity.reduce<Conversation | undefined>(
          (latest, item) =>
            item.messageAt > (latest?.messageAt ?? "") ? item : latest,
          undefined,
        ),
        unread: activity.some(
          (item) => item.unreadSequence > (readCursors[item.id] ?? 0),
        ),
        waiting: runs.filter(
          (run) =>
            run.status === "waiting_user" ||
            run.status === "unknown" ||
            run.waitingBlocked,
        ).length,
        working: runs.filter(
          (run) =>
            isWorking(run.status) || (run.waiting && !run.waitingBlocked),
        ).length,
      };
    });
    return {
      all: sorted.filter(({ agent }) => !agent.archived),
      archived: sorted.filter(({ agent }) => agent.archived),
      clearedGroups: groupBy(cleared, ({ agent }) => agent.id),
    };
  }, [
    agents,
    chats,
    runs,
    conversations,
    requests,
    readCursors,
    recent.cleared,
    recent.pins,
    t,
  ]);

  function selectView(view: AgentView) {
    if (view === filter) return;
    setFilter(view);
    setShowArchivedAgents(false);
  }
  useEffect(() => localStorage.setItem("lever:agent-view", filter), [filter]);

  function restoreConversation(id: string) {
    recent.restoreConversation(id);
    requestAnimationFrame(() =>
      (expandedArchiveTrigger.current ?? archiveTab.current)?.focus(),
    );
  }

  function unpinConversation(id: string, trigger: HTMLButtonElement) {
    if (trigger.matches(":focus-visible")) {
      const row = trigger.parentElement;
      const group = trigger.closest(".agent-group");
      requestAnimationFrame(() => {
        const target = row?.isConnected
          ? row.querySelector<HTMLButtonElement>(".agent-activity-item")
          : group?.querySelector<HTMLButtonElement>(".agent-select");
        target?.focus({ preventScroll: true });
      });
    }
    recent.setPinned(id, false);
  }

  const handleActivityAction = useEventCallback(
    (
      conversation: Conversation,
      pinned: boolean,
      trigger: HTMLButtonElement,
    ) => {
      if (pinned) unpinConversation(conversation.id, trigger);
      else recent.clearConversations([conversation]);
    },
  );

  const sensors = useSensors(
    // Only deliberate vertical movement should reorder this list; ignore click jitter.
    useSensor(MouseSensor, { activationConstraint: { distance: { y: 10 } } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  return (
    <Tabs
      className="agent-sidebar-content gap-0"
      value={filter}
      onValueChange={(value) => selectView(value as AgentView)}
    >
      <div className="sidebar-heading">
        <h1>{t("nav.agents")}</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("agents.create")}
          onClick={onCreate}
        >
          <Plus size={18} />
        </Button>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="sidebar-search-control mx-(--sidebar-gutter) mt-3 mb-2 justify-start text-muted-foreground"
        aria-label={t("conversationSearch.title")}
        aria-haspopup="dialog"
        aria-keyshortcuts={ariaShortcut(searchShortcut)}
        disabled={!overview.data}
        onClick={onSearch}
      >
        <Search data-icon="inline-start" />
        <span>{t("conversationSearch.trigger")}</span>
        {searchShortcut && (
          <kbd
            aria-hidden="true"
            className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-sans text-xs leading-none"
          >
            {formatShortcut(searchShortcut)}
          </kbd>
        )}
      </Button>
      <div className="sidebar-filters">
        <TabsList variant="line" aria-label={t("agents.views")}>
          <div className="flex gap-0.5">
            <TabsTrigger value="all">{t("agents.all")}</TabsTrigger>
            <TabsTrigger value="recent">{t("agents.recent")}</TabsTrigger>
          </div>
          <TabsTrigger
            ref={archiveTab}
            value="archived"
            title={t("common.archived")}
            className="agent-archive-tab"
          >
            <Archive aria-hidden="true" />
            <span className="sr-only">{t("common.archived")}</span>
          </TabsTrigger>
        </TabsList>
        {filter === "all" && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="col-start-2 row-start-1"
                aria-label={t("agents.sort")}
                title={t("agents.sort")}
              >
                <ArrowDownWideNarrow />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value) => setSort(value as AgentSort)}
              >
                <DropdownMenuRadioItem value="recent">
                  {t("agents.sortRecent")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">
                  {t("agents.sortName")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="manual">
                  {t("agents.sortManual")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <SidebarListPanel value="recent" active={filter === "recent"}>
        {() => (
          <RecentConversations
            overview={activity}
            visible={visible && filter === "recent"}
            selected={selectedSessionId}
            readCursors={readCursors}
            recent={recent}
            onMenu={openMenu}
            onConversation={onConversation}
            onShared={onShared}
          />
        )}
      </SidebarListPanel>
      <SidebarListPanel value="all" active={filter === "all"}>
        {() => renderDirectory("all")}
      </SidebarListPanel>
      <SidebarListPanel value="archived" active={filter === "archived"}>
        {() => renderDirectory("archived")}
      </SidebarListPanel>
      {filter === "archived" && (
        <div className="shrink-0 px-(--sidebar-gutter)">
          <Separator />
          <Button
            variant="ghost"
            className="my-1 w-full justify-start"
            onClick={() => setShowArchivedAgents((shown) => !shown)}
          >
            {showArchivedAgents ? (
              <>
                <ChevronLeft data-icon="inline-start" />
                {t("agents.backToArchivedConversations")}
              </>
            ) : (
              <>
                {t("agents.archivedAgents")}
                <ChevronRight
                  className="ms-auto text-muted-foreground"
                  data-icon="inline-end"
                />
              </>
            )}
          </Button>
        </div>
      )}
      <AgentSidebarMenus
        menu={menu}
        close={() => setMenu(undefined)}
        navigation={navigation}
        overview={overview.data}
        recent={recent}
        readCursors={readCursors}
        markRead={markRead}
        clear={recent.clearConversations}
        restore={restoreConversation}
      />
    </Tabs>
  );

  function renderDirectory(view: "all" | "archived") {
    const sorted = sidebarItems[view];
    const canReorder = view === "all";
    const showingCleared = view === "archived" && !showArchivedAgents;
    return (
      <>
        {overview.isPending && <Loading />}
        {overview.error && (
          <ErrorNotice
            error={overview.error}
            retry={() => void overview.refetch()}
          />
        )}
        {showingCleared ? (
          overview.data && (
            <ClearedConversations
              groups={sidebarItems.clearedGroups}
              selectedAgent={selected}
              selectedSession={selectedSessionId}
              expandedTrigger={expandedArchiveTrigger}
              onConversation={onConversation}
              onRestore={restoreConversation}
              onMenu={(anchor, conversation) =>
                openMenu(anchor, {
                  kind: "conversation",
                  conversation,
                  restorable: true,
                })
              }
            />
          )
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{
              screenReaderInstructions: {
                draggable: t("agents.dragInstructions"),
              },
            }}
            onDragEnd={({ active, over }) => {
              if (canReorder && over)
                moveAgent(String(active.id), String(over.id));
            }}
          >
            <SortableContext
              items={sorted.map(({ agent }) => agent.id)}
              strategy={verticalListSortingStrategy}
            >
              {sorted.map(
                ({
                  agent,
                  chats,
                  activity,
                  unread,
                  waiting,
                  working,
                  conversations,
                  clearable: agentClearable,
                }) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    selected={selected === agent.id}
                    canReorder={canReorder}
                    onMenu={(anchor) =>
                      openMenu(anchor, {
                        kind: "agent",
                        agent,
                        hasChats: chats.length > 0,
                        unread: conversations
                          .filter((item) => item.unread)
                          .map((item) => item.conversation),
                        clearable: agentClearable,
                      })
                    }
                    onChoose={() => onChoose(agent.id)}
                    onPreview={() => onPreview(agent.id)}
                    onProfile={() =>
                      onOpen(
                        {
                          id: "profile",
                          kind: "profile",
                          title: "profile",
                        },
                        agent.id,
                      )
                    }
                    preview={
                      activity?.preview ||
                      (providers.data?.find(
                        (provider) => provider.id === agent.profile.provider,
                      )?.name ??
                        agent.profile.provider)
                    }
                    unread={unread}
                    waiting={waiting}
                    working={working}
                    defaultExpanded={preferences.expandAgentActivity}
                    actions={
                      <>
                        {agentClearable.length > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("agents.clearAgentReadActivity", {
                              name: agent.name,
                            })}
                            title={t("agents.clearAgentReadActivity", {
                              name: agent.name,
                            })}
                            onClick={() =>
                              recent.clearConversations(agentClearable)
                            }
                          >
                            <Eraser data-icon="inline-start" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("agents.openFiles", {
                            name: agent.name,
                          })}
                          title={t("agents.openFiles", {
                            name: agent.name,
                          })}
                          onClick={() =>
                            onOpen(
                              {
                                id: "files",
                                kind: "files",
                                title: "files",
                              },
                              agent.id,
                            )
                          }
                        >
                          <Folders />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("agents.openChat", {
                            name: agent.name,
                          })}
                          title={t("agents.openChat", { name: agent.name })}
                          disabled={!chats.length && agent.archived}
                          onClick={() => onChat(agent)}
                        >
                          <MessageCircle />
                        </Button>
                      </>
                    }
                  >
                    {conversations.length > 0 &&
                      conversations.map(
                        ({
                          conversation,
                          chat,
                          title,
                          unread,
                          run,
                          pending,
                          pinIndex,
                          canClear,
                        }) => (
                          <AgentActivityRow
                            key={conversation.id}
                            t={t}
                            conversation={conversation}
                            chatTitle={chat.title}
                            title={title}
                            unread={unread}
                            runStatus={
                              run?.waiting
                                ? run.waitingBlocked
                                  ? "waiting_blocked"
                                  : "waiting"
                                : run?.status
                            }
                            pending={pending}
                            pinned={pinIndex !== undefined}
                            canClear={canClear}
                            selected={selectedSessionId === conversation.id}
                            onConversation={onConversation}
                            openMenu={openMenu}
                            onAction={handleActivityAction}
                          />
                        ),
                      )}
                  </AgentRow>
                ),
              )}
            </SortableContext>
          </DndContext>
        )}
        {!showingCleared && !overview.isPending && !sorted.length && (
          <p className="sidebar-empty">
            {t(view === "archived" ? "agents.noArchived" : "agents.first")}
          </p>
        )}
      </>
    );
  }
}

const AgentActivityRow = memo(function AgentActivityRow({
  t,
  conversation,
  chatTitle,
  title,
  unread,
  runStatus,
  pending,
  pinned,
  canClear,
  selected,
  onConversation,
  openMenu,
  onAction,
}: {
  t: TFunction;
  conversation: Conversation;
  chatTitle: string;
  title: string;
  unread: boolean;
  runStatus?: string;
  pending: boolean;
  pinned: boolean;
  canClear: boolean;
  selected: boolean;
  onConversation: SidebarNavigation["onConversation"];
  openMenu: (anchor: MenuAnchor, target: MenuTarget) => void;
  onAction: (
    conversation: Conversation,
    pinned: boolean,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  const working = !!runStatus && isWorking(runStatus);
  const waiting = runStatus === "waiting";
  const waitingBlocked = runStatus === "waiting_blocked";
  const StatusIcon =
    pending || runStatus === "waiting_user"
      ? CirclePause
      : waitingBlocked
        ? CircleAlert
        : waiting
          ? Clock
          : runStatus === "unknown"
            ? CircleHelp
            : working
              ? LoaderCircle
              : undefined;
  const label = title || t("chat.topic");
  const status = pending
    ? t("agents.pending")
    : waitingBlocked
      ? t("after.statusBlocked")
      : waiting
        ? t("after.statusWaiting")
        : runStatus
          ? t(`status.${runStatus}`)
          : "";
  const actionLabel = pinned
    ? t("agents.unpinConversation")
    : t("agents.clearActivity", { title: label });
  return (
    <li className="agent-activity-row">
      <button
        type="button"
        className={cn("agent-activity-item", selected && "selected")}
        data-session-id={conversation.id}
        aria-current={selected ? "true" : undefined}
        aria-label={label}
        title={[
          label,
          conversation.kind === "topic" ? chatTitle : "",
          status,
          unread ? t("agents.unread") : "",
        ]
          .filter(Boolean)
          .join("\n")}
        onClick={() => onConversation(conversation)}
        {...rowMenuHandlers((anchor) =>
          openMenu(anchor, {
            kind: "conversation",
            conversation,
            clearable: canClear,
          }),
        )}
      >
        <span className="truncate">{label}</span>
        {StatusIcon && (
          <StatusIcon
            className={cn(
              "agent-working",
              waitingBlocked && "agent-working-blocked",
              StatusIcon === LoaderCircle &&
                "animate-spin motion-reduce:animate-none",
            )}
            role="img"
            aria-label={status}
          />
        )}
        {unread && (
          <span
            className="agent-unread"
            role="img"
            aria-label={t("agents.unread")}
          />
        )}
      </button>
      {(pinned || canClear) && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            "agent-activity-action text-muted-foreground",
            pinned && "agent-activity-pin",
          )}
          aria-label={actionLabel}
          title={actionLabel}
          onClick={(event) =>
            onAction(conversation, pinned, event.currentTarget)
          }
        >
          {pinned ? <Pin className="fill-current" /> : <Eraser />}
        </Button>
      )}
    </li>
  );
});

function AgentRow({
  agent,
  selected,
  canReorder,
  preview,
  unread,
  waiting,
  working,
  defaultExpanded,
  children,
  actions,
  onChoose,
  onPreview,
  onProfile,
  onMenu,
}: {
  agent: Agent;
  selected: boolean;
  canReorder: boolean;
  preview: string;
  unread: boolean;
  waiting: number;
  working: number;
  defaultExpanded: boolean;
  children: React.ReactNode;
  actions: React.ReactNode;
  onChoose: () => void;
  onPreview: () => void;
  onProfile: () => void;
  onMenu: (anchor: MenuAnchor) => void;
}) {
  const { t } = useTranslation();
  const workingLabel = t("agents.workingCount", { count: working });
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id, disabled: !canReorder });
  return (
    <Collapsible
      key={String(defaultExpanded)}
      defaultOpen={defaultExpanded}
      ref={setNodeRef}
      className={cn("agent-group", isDragging && "dragging")}
      data-agent-id={agent.id}
      data-sortable={canReorder}
      style={{
        transform: CSS.Translate.toString(transform && { ...transform, x: 0 }),
        transition,
      }}
    >
      <div
        className={cn("agent-contact", selected && "selected")}
        {...listeners}
        {...rowMenuHandlers(onMenu)}
        onClick={onChoose}
        onPointerEnter={() => {
          if (!isDragging) onPreview();
        }}
      >
        <Button
          variant="ghost"
          className="agent-profile-trigger size-auto rounded-full border-0 p-0"
          aria-label={t("agents.openProfile", { name: agent.name })}
          title={t("agents.openProfile", { name: agent.name })}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onProfile();
          }}
        >
          <AgentAvatar agent={agent} />
        </Button>
        <div className="agent-contact-content">
          <button
            className="agent-select"
            data-menu-focus
            ref={setActivatorNodeRef}
            {...(canReorder ? attributes : {})}
            aria-label={agent.name}
            aria-current={selected ? "true" : undefined}
            onFocus={onPreview}
          >
            <span className="contact-name">
              <span className="truncate">{agent.name}</span>
            </span>
          </button>
          <div
            className="agent-quick-actions"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
          <div className="agent-contact-meta">
            <span className="contact-preview">{preview}</span>
            <span className="agent-contact-status">
              {waiting > 0 && (
                <span className="pending-mark">
                  {t("agents.pending")} {waiting}
                </span>
              )}
              {working > 0 && (
                <span
                  className="agent-working-count"
                  role="img"
                  aria-label={workingLabel}
                  title={workingLabel}
                >
                  <span className="agent-working-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span>{working}</span>
                </span>
              )}
              {unread && (
                <span
                  className="agent-unread"
                  role="img"
                  aria-label={t("agents.unread")}
                  title={t("agents.unread")}
                />
              )}
            </span>
            <span className="agent-activity-toggle-slot">
              {!!children && (
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="agent-activity-toggle"
                    aria-label={t("agents.toggleActivity", {
                      name: agent.name,
                    })}
                    title={t("agents.toggleActivity", { name: agent.name })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onTouchStart={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ChevronDown />
                  </Button>
                </CollapsibleTrigger>
              )}
            </span>
          </div>
        </div>
      </div>
      {!!children && (
        <CollapsibleContent>
          <ul className="agent-activity-list">{children}</ul>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
