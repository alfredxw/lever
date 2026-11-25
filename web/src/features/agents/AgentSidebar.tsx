import type { WorkbenchOverview } from "@/components/workbench/workbenchOverview";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  CircleAlert,
  CircleHelp,
  CirclePause,
  Clock,
  Eraser,
  EyeOff,
  Folders,
  History,
  LoaderCircle,
  MessageCircle,
  Pin,
  Plus,
  RotateCcw,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
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
import { RecentConversations } from "./RecentConversations";
import { useProviders } from "@/features/runtime/queries";
import { usePreferences } from "@/features/settings/Preferences";
import {
  ariaShortcut,
  binding,
  formatShortcut,
} from "@/features/settings/shortcuts";

type AgentView = "all" | "recent";
const clearedPageSize = 5;

function formatClearedTime(timestamp: number, locale: string) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
}

const SidebarListPanel = memo(
  function SidebarListPanel({
    value,
    active,
    panelRef,
    children,
  }: {
    value: AgentView;
    active: boolean;
    panelRef?: RefObject<HTMLDivElement | null>;
    children: () => ReactNode;
  }) {
    const [visited, setVisited] = useState(active);
    if (active && !visited) setVisited(true);
    return (
      <TabsContent
        ref={panelRef}
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
  const { t, i18n } = useTranslation();
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
  const [showCleared, setShowCleared] = useState(false);
  const [clearedLimits, setClearedLimits] = useState<Record<string, number>>(
    {},
  );
  const [mutedCleared, setMutedCleared] = useState<Record<string, boolean>>({});
  const [lensCollapsed, setLensCollapsed] = useState<Record<string, boolean>>(
    {},
  );
  const sidebarRef = useRef<HTMLDivElement>(null);
  const allPanelRef = useRef<HTMLDivElement>(null);
  const clearedToggleRef = useRef<HTMLButtonElement>(null);
  const pendingScrollAnchorRef = useRef<{
    agentId: string;
    offset: number | null;
    revealGroup: boolean;
  } | null>(null);
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
      if (!agent || agent.archived || !chat) return [];
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
        ({ conversation, unread, run, pending, pinIndex }) =>
          pinIndex !== undefined ||
          unread ||
          run ||
          pending ||
          conversation.unreadSequence >
            (recent.cleared[conversation.id] ?? 0),
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
    const clearedByAgent = groupBy(cleared, ({ agent }) => agent.id);
    const all = agents
      .filter((agent) => !agent.archived)
      .map((agent) => {
        const agentChats = chatsByAgent.get(agent.id) ?? [];
        const agentRuns = runsByAgent.get(agent.id) ?? [];
        const agentActivity = activityByAgent.get(agent.id) ?? [];
        const agentConversations = itemsByAgent.get(agent.id) ?? [];
        return {
          agent,
          chats: agentChats,
          conversations: agentConversations,
          cleared: clearedByAgent.get(agent.id) ?? [],
          clearable: agentConversations
            .filter(({ canClear }) => canClear)
            .map(({ conversation }) => conversation),
          activity: agentActivity.reduce<Conversation | undefined>(
            (latest, item) =>
              item.messageAt > (latest?.messageAt ?? "") ? item : latest,
            undefined,
          ),
          unread: agentActivity.some(
            (item) => item.unreadSequence > (readCursors[item.id] ?? 0),
          ),
          waiting: agentRuns.filter(
            (run) =>
              run.status === "waiting_user" ||
              run.status === "unknown" ||
              run.waitingBlocked,
          ).length,
          working: agentRuns.filter(
            (run) =>
              isWorking(run.status) || (run.waiting && !run.waitingBlocked),
          ).length,
        };
      });
    return { all, totalCleared: cleared.length };
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

  const showingCleared =
    filter === "all" && showCleared && sidebarItems.totalCleared > 0;

  const captureScrollAnchor = useCallback(
    (agentId: string | undefined, revealGroup: boolean) => {
      if (!agentId) return;
      const panel = allPanelRef.current;
      if (!panel) return;
      const header = panel.querySelector<HTMLElement>(
        `[data-agent-id="${globalThis.CSS.escape(agentId)}"] > .agent-contact`,
      );
      if (!header) return;
      const panelRect = panel.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const visibleInPanel =
        headerRect.bottom > panelRect.top && headerRect.top < panelRect.bottom;
      pendingScrollAnchorRef.current = {
        agentId,
        offset: visibleInPanel ? headerRect.top - panelRect.top : null,
        revealGroup,
      };
    },
    [],
  );

  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (!anchor) return;
    pendingScrollAnchorRef.current = null;
    const panel = allPanelRef.current;
    if (!panel || panel.hidden) return;
    const group = panel.querySelector<HTMLElement>(
      `[data-agent-id="${globalThis.CSS.escape(anchor.agentId)}"]`,
    );
    const header = group?.querySelector<HTMLElement>(":scope > .agent-contact");
    if (!group || !header) return;
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const padding = 8;
    if (anchor.offset !== null) {
      panel.scrollTop += headerRect.top - panelRect.top - anchor.offset;
    } else {
      panel.scrollTop += headerRect.top - panelRect.top - padding;
    }
    if (anchor.revealGroup) {
      const nextHeaderRect = header.getBoundingClientRect();
      const groupRect = group.getBoundingClientRect();
      const overflowBottom = groupRect.bottom - (panelRect.bottom - padding);
      const headroomTop = nextHeaderRect.top - (panelRect.top + padding);
      if (overflowBottom > 0 && headroomTop > 0) {
        panel.scrollTop += Math.min(overflowBottom, headroomTop);
      }
    }
  }, [showingCleared, mutedCleared, lensCollapsed]);

  const closeClearedLens = useCallback(
    (restoreFocus = false, anchorAgentId?: string) => {
      captureScrollAnchor(anchorAgentId ?? selected, false);
      setShowCleared(false);
      setClearedLimits({});
      setMutedCleared({});
      setLensCollapsed({});
      if (restoreFocus) {
        requestAnimationFrame(() =>
          clearedToggleRef.current?.focus({ preventScroll: true }),
        );
      }
    },
    [captureScrollAnchor, selected],
  );

  const toggleClearedLens = useCallback(
    (next: boolean) => {
      if (next) {
        captureScrollAnchor(selected, true);
        setShowCleared(true);
      } else {
        closeClearedLens();
      }
    },
    [captureScrollAnchor, closeClearedLens, selected],
  );

  const revealAgentCleared = useCallback(
    (agentId: string) => {
      captureScrollAnchor(agentId, true);
      setFilter("all");
      setShowCleared(true);
      setMutedCleared((current) =>
        current[agentId] ? { ...current, [agentId]: false } : current,
      );
      setLensCollapsed((current) =>
        current[agentId] ? { ...current, [agentId]: false } : current,
      );
    },
    [captureScrollAnchor],
  );

  function selectView(view: AgentView) {
    if (view === filter) return;
    setFilter(view);
    if (view !== "all" && showCleared) closeClearedLens();
  }
  useEffect(() => localStorage.setItem("lever:agent-view", filter), [filter]);

  useEffect(() => {
    if (!visible || !showingCleared) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        menu ||
        document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, [contenteditable="true"], [role="textbox"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      const focusInsideSidebar =
        sidebarRef.current?.contains(document.activeElement) ?? false;
      closeClearedLens(focusInsideSidebar);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, showingCleared, menu, closeClearedLens]);

  const restoreConversation = useEventCallback(
    (id: string, agentId?: string) => {
      const fromClearedBlock =
        document.activeElement?.closest(".agent-cleared-block") !== null;
      const lastCleared = sidebarItems.totalCleared <= 1;
      recent.restoreConversation(id);
      if (lastCleared) {
        closeClearedLens(fromClearedBlock, agentId);
        return;
      }
      if (fromClearedBlock) {
        requestAnimationFrame(() => {
          const target =
            sidebarRef.current?.querySelector<HTMLButtonElement>(
              `[data-session-id="${globalThis.CSS.escape(id)}"]`,
            ) ??
            (agentId
              ? sidebarRef.current?.querySelector<HTMLButtonElement>(
                  `[data-agent-id="${globalThis.CSS.escape(agentId)}"] .agent-select`,
                )
              : null) ??
            clearedToggleRef.current;
          target?.focus({ preventScroll: true });
        });
      }
    },
  );

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
      ref={sidebarRef}
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
          <TabsTrigger value="all">{t("agents.all")}</TabsTrigger>
          <TabsTrigger value="recent">{t("agents.recent")}</TabsTrigger>
        </TabsList>
        {filter === "all" && (
          <div className="sidebar-filter-actions">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
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
            <Toggle
              ref={clearedToggleRef}
              size="sm"
              className="size-7 min-w-0 p-0 text-muted-foreground data-[state=on]:text-foreground"
              pressed={showingCleared}
              disabled={!sidebarItems.totalCleared && !showingCleared}
              aria-label={t("agents.showClearedConversations")}
              title={t(
                showingCleared
                  ? "agents.hideClearedConversations"
                  : "agents.showClearedConversations",
              )}
              onPressedChange={toggleClearedLens}
            >
              <History className="size-4" aria-hidden="true" />
            </Toggle>
          </div>
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
      <SidebarListPanel
        value="all"
        active={filter === "all"}
        panelRef={allPanelRef}
      >
        {() => renderDirectory()}
      </SidebarListPanel>
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
        revealCleared={revealAgentCleared}
      />
    </Tabs>
  );

  function renderDirectory() {
    const sorted = sidebarItems.all;
    return (
      <>
        {overview.isPending && <Loading />}
        {overview.error && (
          <ErrorNotice
            error={overview.error}
            retry={() => void overview.refetch()}
          />
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            screenReaderInstructions: {
              draggable: t("agents.dragInstructions"),
            },
          }}
          onDragEnd={({ active, over }) => {
            if (over) moveAgent(String(active.id), String(over.id));
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
                cleared,
                clearable: agentClearable,
              }) => {
                const lensActive = showingCleared && cleared.length > 0;
                const muted = !!mutedCleared[agent.id];
                const limit = clearedLimits[agent.id] ?? clearedPageSize;
                const visibleCleared =
                  lensActive && !muted ? cleared.slice(0, limit) : [];
                const remainingCleared = Math.max(
                  0,
                  cleared.length - visibleCleared.length,
                );
                const hasChildren = conversations.length > 0 || lensActive;
                return (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    selected={selected === agent.id}
                    open={lensActive ? !lensCollapsed[agent.id] : undefined}
                    onOpenChange={
                      lensActive
                        ? (expanded) =>
                            setLensCollapsed((current) => ({
                              ...current,
                              [agent.id]: !expanded,
                            }))
                        : undefined
                    }
                    clearedOnly={conversations.length === 0 && lensActive}
                    onMenu={(anchor) =>
                      openMenu(anchor, {
                        kind: "agent",
                        agent,
                        hasChats: chats.length > 0,
                        unread: conversations
                          .filter((item) => item.unread)
                          .map((item) => item.conversation),
                        clearable: agentClearable,
                        clearedCount: cleared.length,
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
                          onClick={() => onChat(agent)}
                        >
                          <MessageCircle />
                        </Button>
                      </>
                    }
                  >
                    {hasChildren && (
                      <>
                        {conversations.map(
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
                        {lensActive &&
                          (muted ? (
                            <li>
                              <button
                                type="button"
                                className="agent-cleared-muted-bar"
                                onClick={() =>
                                  setMutedCleared((current) => ({
                                    ...current,
                                    [agent.id]: false,
                                  }))
                                }
                              >
                                <span className="truncate tabular-nums">
                                  {t("agents.clearedHiddenCount", {
                                    count: cleared.length,
                                  })}
                                </span>
                                <span className="shrink-0">
                                  {t("settings.expanded")}
                                </span>
                              </button>
                            </li>
                          ) : (
                            <li
                              className={cn(
                                "agent-cleared-block",
                                !conversations.length && "no-active-above",
                              )}
                            >
                              <div className="agent-cleared-header">
                                <span className="truncate tabular-nums">
                                  {t("agents.clearedGroupCount", {
                                    shown: visibleCleared.length,
                                    total: cleared.length,
                                  })}
                                </span>
                                <button
                                  type="button"
                                  className="agent-cleared-mute"
                                  aria-label={t("agents.hideAgentCleared", {
                                    name: agent.name,
                                  })}
                                  title={t("agents.hideAgentCleared", {
                                    name: agent.name,
                                  })}
                                  onClick={() =>
                                    setMutedCleared((current) => ({
                                      ...current,
                                      [agent.id]: true,
                                    }))
                                  }
                                >
                                  <EyeOff aria-hidden="true" />
                                  <span>{t("agents.hideCleared")}</span>
                                </button>
                              </div>
                              <ul className="agent-cleared-list">
                                {visibleCleared.map(
                                  ({
                                    conversation,
                                    chat,
                                    title,
                                    lastActivity,
                                  }) => (
                                    <AgentClearedRow
                                      key={conversation.id}
                                      t={t}
                                      locale={i18n.language}
                                      conversation={conversation}
                                      chatTitle={displayChatTitle(chat, t)}
                                      title={title}
                                      lastActivity={lastActivity}
                                      selected={
                                        selectedSessionId === conversation.id
                                      }
                                      onConversation={onConversation}
                                      openMenu={openMenu}
                                      onRestore={restoreConversation}
                                    />
                                  ),
                                )}
                              </ul>
                              {remainingCleared > 0 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  className="agent-cleared-more"
                                  aria-label={t(
                                    "agents.showMoreClearedConversations",
                                  )}
                                  onClick={(event) => {
                                    const list = event.currentTarget
                                      .closest(".agent-cleared-block")
                                      ?.querySelector(".agent-cleared-list");
                                    setClearedLimits((current) => ({
                                      ...current,
                                      [agent.id]: limit + clearedPageSize,
                                    }));
                                    requestAnimationFrame(() =>
                                      list?.children
                                        .item(limit)
                                        ?.querySelector<HTMLButtonElement>(
                                          "button",
                                        )
                                        ?.focus({ preventScroll: true }),
                                    );
                                  }}
                                >
                                  <Plus
                                    className="size-3 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    {t("agents.showMoreClearedConversations")}
                                  </span>
                                  <span
                                    aria-hidden="true"
                                    className="ms-auto tabular-nums text-[11px] opacity-75"
                                  >
                                    {t("agents.clearedRemaining", {
                                      count: remainingCleared,
                                    })}
                                  </span>
                                </Button>
                              )}
                            </li>
                          ))}
                      </>
                    )}
                  </AgentRow>
                );
              },
            )}
          </SortableContext>
        </DndContext>
        {!overview.isPending && !sorted.length && (
          <p className="sidebar-empty">{t("agents.first")}</p>
        )}
      </>
    );
  }
}

const AgentClearedRow = memo(function AgentClearedRow({
  t,
  locale,
  conversation,
  chatTitle,
  title,
  lastActivity,
  selected,
  onConversation,
  openMenu,
  onRestore,
}: {
  t: TFunction;
  locale: string;
  conversation: Conversation;
  chatTitle: string;
  title: string;
  lastActivity: number;
  selected: boolean;
  onConversation: SidebarNavigation["onConversation"];
  openMenu: (anchor: MenuAnchor, target: MenuTarget) => void;
  onRestore: (id: string, agentId: string) => void;
}) {
  const label = title || t("chat.topic");
  const restoreLabel = t("agents.restoreConversation");
  const time = formatClearedTime(lastActivity, locale);
  return (
    <li className="agent-activity-row">
      <button
        type="button"
        className={cn(
          "agent-activity-item agent-cleared-item",
          selected && "selected",
        )}
        data-session-id={conversation.id}
        data-cleared="true"
        aria-current={selected ? "true" : undefined}
        aria-label={label}
        title={[
          label,
          conversation.kind === "topic" ? chatTitle : "",
          conversation.preview !== label ? conversation.preview : "",
        ]
          .filter(Boolean)
          .join("\n")}
        onClick={() => onConversation(conversation)}
        {...rowMenuHandlers((anchor) =>
          openMenu(anchor, {
            kind: "conversation",
            conversation,
            restorable: true,
          }),
        )}
      >
        <span className="truncate">{label}</span>
        {time && (
          <span className="agent-cleared-time tabular-nums" aria-hidden="true">
            {time}
          </span>
        )}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="agent-activity-action text-muted-foreground"
        aria-label={restoreLabel}
        title={restoreLabel}
        onClick={() => onRestore(conversation.id, conversation.agentId)}
      >
        <RotateCcw aria-hidden="true" />
      </Button>
    </li>
  );
});

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
  open: controlledOpen,
  onOpenChange: controlledOpenChange,
  clearedOnly,
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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  clearedOnly?: boolean;
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
  const [localOpen, setLocalOpen] = useState(defaultExpanded);
  const [trackedDefault, setTrackedDefault] = useState(defaultExpanded);
  if (trackedDefault !== defaultExpanded) {
    setTrackedDefault(defaultExpanded);
    setLocalOpen(defaultExpanded);
  }
  const open = controlledOpen ?? localOpen;
  const onOpenChange = controlledOpenChange ?? setLocalOpen;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.id });
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      ref={setNodeRef}
      className={cn("agent-group", isDragging && "dragging")}
      data-agent-id={agent.id}
      data-sortable="true"
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
            {...attributes}
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
          <ul
            className={cn(
              "agent-activity-list",
              clearedOnly && "cleared-only-rail",
            )}
          >
            {children}
          </ul>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
