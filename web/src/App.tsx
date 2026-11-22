import { useTranslation } from "react-i18next";
import {
  WorkbenchShell,
  type PrimaryPage,
} from "@/components/workbench/PrimaryNavigation";
import {
  AutomationsPage,
  PluginsPage,
  prefetchPrimaryPage,
  schedulePrimaryPagePrefetch,
  SkillsPage,
  TasksPage,
} from "@/components/workbench/primaryPages";
import {
  WorkspaceTabs,
  WorkspaceDrag,
} from "@/components/workbench/WorkspaceTabs";
import {
  paneOf,
  useWorkspaces,
  workspaceView,
  type Pane,
  type Workspace,
  type WorkspaceTab,
} from "@/components/workbench/useWorkspaces";
import {
  toolTab,
  WorkspaceActions,
  WorkspacePanelControls,
} from "@/components/workbench/WorkspaceActions";
import { WorkspaceDivider } from "@/components/workbench/WorkspaceDivider";
import {
  selectAgentActivity,
  selectWorkbenchOverview,
} from "@/components/workbench/workbenchOverview";
import { WorkspaceLayout } from "@/components/workbench/WorkspaceLayout";
import { WorkspaceStart } from "@/components/workbench/WorkspaceStart";
import {
  WorkspaceSearch,
  type SearchScope,
  type SearchType,
} from "@/components/workbench/WorkspaceSearch";
import {
  isConversationTab,
  useRecentConversations,
} from "@/components/workbench/useRecentConversations";
import { SecondarySidebar } from "@/components/workbench/SecondarySidebar";
import { useProviders } from "@/features/runtime/queries";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import { motion, MotionConfig } from "motion/react";
import type { JSONContent } from "@tiptap/core";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import leverIcon from "../../cmd/lever-desktop/icon.png";
import type {
  Agent,
  Chat as ChatData,
  Conversation,
  MessageQuote,
  Overview,
  Reference,
  Run,
  Session,
  SessionView,
  SharedConversation,
  Skill,
  TaskExecution,
  RunLocation,
} from "@/api/types.gen";
import {
  Notifications,
  events as desktopEvents,
  type NotificationTarget,
} from "@/api/desktop.gen";
import { api, APIError, connectEvents, queryClient } from "@/api/client";
import { Chat } from "@/features/chat/Chat";
import { SharedChat } from "@/features/chat/SharedChat";
import { sharedConversationKey } from "@/features/chat/sharedConversations";
import { draftChatId, NewChat } from "@/features/chat/NewChat";
import {
  ComposerContext,
  KeepConversationOpen,
  type ComposerInsertion,
} from "@/features/chat/ComposerContext";
import { hasStoredComposerInput } from "@/features/chat/composerDraft";
import {
  hasQuestionDraft,
  pruneQuestionDrafts,
} from "@/features/chat/questionDraft";
import { TopicConversation } from "@/features/chat/Topic";
import { prefetchConversation, sessionQuery } from "@/features/chat/queries";
import type { TaskDestination } from "@/features/tasks/TasksPage";
import { ForwardMessageDialog } from "@/features/chat/ForwardMessageDialog";
import {
  QuoteDestinationDialog,
  type QuoteDestination,
} from "@/features/chat/QuoteDestinationDialog";
import { Profile } from "@/features/agents/Profile";
import {
  hasDesktopNotifications,
  observeAgentNotifications,
  type AgentNotice,
} from "@/features/agents/desktopNotifications";
import { useConversationReadState } from "@/features/agents/useConversationReadState";
import { useRecentState } from "@/features/agents/useRecentState";
import { AgentSidebar } from "@/features/agents/AgentSidebar";
import type { OpenConversationMode } from "@/features/agents/AgentSidebarMenus";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { useUnsavedFileWarning } from "@/features/files/fileDrafts";
import {
  resolveWorkspaceFile,
  type FileSelection,
} from "@/features/files/filePaths";
import {
  fileScopeKey,
  type AgentFileSource,
  type ReferenceScope,
} from "@/features/files/fileSource";
import { skillEntryTarget } from "@/features/skills/skillsQuery";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { MessagePositions } from "@/components/ui/message-scroller";
import { ErrorNotice, Loading } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { scopeParams, WorkspaceSession } from "@/features/worktrees/scope";
import {
  availableGroup,
  useWorkingCopies,
  workingCopiesQuery,
} from "@/features/worktrees/queries";
import { useTheme } from "@/hooks/useTheme";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useEventCallback } from "@/hooks/useEventCallback";
import { Browser as NativeBrowser } from "@/api/desktop.gen";
import type { BrowserContext } from "@/features/browser/BrowserPanel";
import { HtmlPreviewHost, HtmlPreviewPanel } from "@/features/chat/HtmlPreview";
import type { HtmlPreview } from "@/features/chat/chatFileLinks";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { usePreferences } from "@/features/settings/Preferences";
import {
  availableShortcuts,
  binding,
  defaultShortcut,
  isDesktop,
  tabNumber,
  useShortcutListener,
} from "@/features/settings/shortcuts";

import {
  DiffNavigation,
  type TurnSelection,
} from "@/features/diff/TurnChanges";
import { useGitRoots } from "@/features/diff/useGitRoots";

import {
  closeTerminals,
  terminalLeaves,
} from "@/features/terminal/terminalSession";

const Diff = lazy(() => import("@/features/diff/Diff"));
const Files = lazy(() =>
  import("@/features/files/Files").then(({ Files }) => ({ default: Files })),
);
const Terminal = lazy(() => import("@/features/terminal/Terminal"));
const WorkspaceNotes = lazy(() => import("@/features/tasks/WorkspaceNotes"));
const BrowserPanel = lazy(() => import("@/features/browser/BrowserPanel"));
const noAgents: Agent[] = [];
const noChats: Overview["chats"] = [];
type WorkspaceTabTarget = { agentId: string; tab: WorkspaceTab };

function expandedChatPane(
  workspace: Workspace,
  compact: boolean,
): Pane | undefined {
  const { mainTab, sideTab, split, maximized, activeTab } = workspaceView(
    workspace,
    compact,
  );
  if (activeTab?.kind === "chat" && activeTab.expandedTopicId)
    return paneOf(activeTab);
  if (!maximized && mainTab?.kind === "chat" && mainTab.expandedTopicId)
    return "main";
  if (split && sideTab?.kind === "chat" && sideTab.expandedTopicId)
    return "side";
}

function focusWorkspaceTab(id: string) {
  requestAnimationFrame(() =>
    document.getElementById(`tab-${encodeURIComponent(id)}`)?.focus(),
  );
}

function quickSearchType(tab?: WorkspaceTab): SearchType {
  switch (tab?.kind) {
    case "files":
      return "file";
    case "chat":
    case "draft":
      return "chat";
    case "topic":
      return "topic";
    default:
      return "all";
  }
}

const sharedWorkspaceId = "shared-conversations";

// Restoring a tab strip need only initialize the panels the user actually opens.
// Once opened, stateful tools keep their editors and unsaved changes.
function MountOnVisit({
  visible,
  fallback,
  children,
}: {
  visible: boolean;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(visible);
  if (visible && !visited) setVisited(true);
  return visible || visited ? (
    <Suspense fallback={fallback}>{children}</Suspense>
  ) : null;
}

export default function App() {
  useUnsavedFileWarning();
  const { t } = useTranslation();
  const { preferences } = usePreferences();
  const recentState = useRecentState();
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
    select: selectWorkbenchOverview,
  });
  const pendingRequests = overview.data?.requests;
  const agentActivity = useMemo(
    () =>
      overview.data &&
      selectAgentActivity(overview.data, recentState.pinnedIds),
    [overview.data, recentState.pinnedIds],
  );
  useEffect(() => {
    if (pendingRequests) pruneQuestionDrafts(pendingRequests);
  }, [pendingRequests]);
  useEffect(() => {
    if (overview.isSuccess) return schedulePrimaryPagePrefetch();
  }, [overview.isSuccess]);
  const providers = useProviders();
  const availableConnections = providers.data?.filter((p) => p.available);
  const needsConnection = providers.isSuccess && !availableConnections?.length;
  const [selected, setSelected] = useState(
    () => localStorage.getItem("lever:agent") ?? "",
  );
  const [create, setCreate] = useState<{
    defaultAgent?: Agent;
    source?: Agent;
  }>();
  const [page, setPage] = useState<PrimaryPage>("agents");
  const [pluginTarget, setPluginTarget] = useState<string>();
  const [providerTarget, setProviderTarget] = useState<{
    id?: string;
    pluginId?: string;
  }>();
  const [selectedAutomation, setSelectedAutomation] = useState<string>();
  const [tasksOpened, setTasksOpened] = useState(false);
  const [revealTask, setRevealTask] = useState<TaskDestination>();
  const onTaskLocated = useCallback(() => setRevealTask(undefined), []);
  const [forward, setForward] = useState<MessageQuote>();
  const [quoteSource, setQuoteSource] = useState<{
    chatId: string;
    quote: MessageQuote;
  }>();
  const [workspaceSearch, setWorkspaceSearch] = useState<{
    type: SearchType;
    scope?: SearchScope;
    fileSource?: AgentFileSource;
    returnFocus: HTMLElement | null;
  }>();
  const [sidebar, setSidebar] = useState(true);
  const workbench = useRef<HTMLElement>(null);
  const [compactWorkbench, setCompactWorkbench] = useState(false);
  const [composerInsertions, setComposerInsertions] = useState(
    () => new Map<string, ComposerInsertion>(),
  );
  const [messagePositions] = useState<MessagePositions>(() => new Map());
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "removed") return;
        // A reading position is only usable while its history is cached.
        const key = event.query.queryKey;
        if (key.length !== 2 || typeof key[1] !== "string") return;
        if (key[0] === "chat") messagePositions.delete(key[1]);
        if (key[0] === "session") messagePositions.delete(`topic:${key[1]}`);
      }),
    [messagePositions],
  );
  const lastConversation = useRef(new Map<string, string>());
  const [floatingBrowser, setFloatingBrowser] = useState("");
  const [closingTerminals, setClosingTerminals] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingTerminalCloses = useRef(new Set<string>());
  const closedTabs = useRef<WorkspaceTabTarget[]>([]);
  const focusAfterClose = useRef<{ agentId: string; id: string } | undefined>(
    undefined,
  );
  const [focusComposer, setFocusComposer] = useState<string>();
  const onComposerFocused = useCallback(() => setFocusComposer(undefined), []);
  const [revealEntry, setRevealEntry] = useState<
    { tabId: string; focusEntry?: boolean } & (
      | { topicId: string; runId?: never; comparisonId?: never }
      | { runId: string; topicId?: never; comparisonId?: never }
      | { comparisonId: string; runId?: never; topicId?: never }
    )
  >();
  const onRevealed = useCallback(() => setRevealEntry(undefined), []);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setCompactWorkbench(entry.contentRect.width <= 700);
    });
    observer.observe(workbench.current!);
    return () => observer.disconnect();
  }, []);
  const reduceMotion = usePrefersReducedMotion();
  const { dark, theme, setTheme } = useTheme();
  const {
    cursors: readCursors,
    focused,
    markRead,
    markConversationsRead,
  } = useConversationReadState(overview.data?.conversations);
  const notifyAgentActivity = useEffectEvent((notice: AgentNotice) => {
    if (!preferences.desktopNotifications) return;
    const name = queryClient
      .getQueryData<Overview>(["overview"])
      ?.agents.find((agent) => agent.id === notice.agentId)?.name;
    void Notifications.show(
      notice.id,
      notice.target,
      t(`agents.notification.${notice.kind}`),
      name ?? "",
    ).catch((error: unknown) => console.warn("Agent notification", error));
  });
  useEffect(() => {
    if (!overview.data) return;
    const observe = hasDesktopNotifications
      ? observeAgentNotifications((notice) => notifyAgentActivity(notice))
      : undefined;
    return connectEvents(overview.data.cursor, observe);
  }, [overview.isSuccess]);
  useEffect(() => {
    localStorage.setItem("lever:agent", selected);
  }, [selected]);
  const agents = overview.data?.agents ?? noAgents;
  const agent = agents.find((a) => a.id === selected);
  const sharedWorkspace = selected === sharedWorkspaceId;
  if (
    !agent &&
    !sharedWorkspace &&
    agents.length === 1 &&
    !agents[0].archived
  ) {
    choose(agents[0].id);
  }
  const gitRoots = useGitRoots(agent?.id, agent?.profile.roots);
  const canOpenDiff = !!gitRoots.data?.length;
  const chats = useMemo(
    () => overview.data?.chats.filter((c) => c.agentId === selected) ?? [],
    [overview.data?.chats, selected],
  );
  const activityChats = useMemo(
    () =>
      agentActivity?.chats.filter((chat) => chat.agentId === selected) ?? [],
    [agentActivity?.chats, selected],
  );
  const firstChat = activityChats[0];
  const fallback = useMemo<Workspace>(
    () => ({
      tabs: firstChat
        ? [{ id: firstChat.id, kind: "chat", title: firstChat.title }]
        : [],
      selected: firstChat?.id ?? "",
      previews:
        firstChat && !hasStoredComposerInput(firstChat.id)
          ? { main: firstChat.id }
          : undefined,
    }),
    [firstChat],
  );
  const {
    workspaces,
    workspace,
    windowTabs,
    openTab: openWorkspaceTab,
    keepTab,
    closeTabs,
    replaceTab,
    updateTerminalLayout,
    updateBrowserLocation,
    setChatTopic,
    selectTab: selectWorkspaceTab,
    focusPane,
    moveTab,
    toggleSidePane,
    toggleSideMaximized,
    resizePanes,
  } = useWorkspaces(selected, fallback);
  const tabStrips = useMemo(() => {
    const strips: Record<Pane, WorkspaceTab[]> = { main: [], side: [] };
    if (!agent && !sharedWorkspace) return strips;
    const chatTitles = new Map(
      chats.map((chat) => [chat.id, displayChatTitle(chat, t)]),
    );
    const topicTitles = new Map(
      overview.data?.conversations.map((item) => [item.id, item.title]),
    );
    for (const tab of workspace.tabs) {
      let title = tab.title;
      if (tab.kind === "chat") title = chatTitles.get(tab.id) ?? title;
      else if (tab.kind === "topic")
        title = topicTitles.get(tab.topic.sessionId) || title;
      else if (tab.kind === "browser" && (tab.htmlPreview || tab.url))
        title = tab.title || tab.url || t("workspace.browser");
      else if (!tab.file && tab.kind !== "shared")
        title = t(`workspace.${tab.kind}`);
      strips[paneOf(tab)].push({ ...tab, title });
    }
    return strips;
  }, [
    agent,
    sharedWorkspace,
    chats,
    overview.data?.conversations,
    workspace.tabs,
    t,
  ]);
  const {
    mainTab,
    sideTab,
    sideVisible,
    activePane,
    activeTab,
    compactTopic,
    split,
    maximized,
  } = workspaceView(
    agent || sharedWorkspace ? workspace : fallback,
    compactWorkbench,
  );
  useEffect(() => {
    const closing = focusAfterClose.current;
    if (
      !closing ||
      workspaces[closing.agentId]?.tabs.some((tab) => tab.id === closing.id)
    )
      return;
    focusAfterClose.current = undefined;
    if (closing.agentId === selected && page === "agents") {
      if (activeTab) focusWorkspaceTab(activeTab.id);
      else
        workbench.current
          ?.querySelector<HTMLElement>(".workspace-start h2")
          ?.focus();
    }
  }, [workspaces, selected, page, activeTab]);
  const searchTab = page === "agents" && agent ? activeTab : undefined;
  function sessionIdFor(tab?: WorkspaceTab) {
    if (tab?.kind === "topic") return tab.topic.sessionId;
    if (tab?.kind === "chat" && tab.expandedTopicId) return tab.expandedTopicId;
    if (tab?.kind === "shared") return tab.id;
    const chatId = tab?.kind === "chat" ? tab.id : tab?.reviewChatId;
    if (chatId)
      return overview.data?.conversations.find(
        (item) => item.chatId === chatId && item.kind === "main",
      )?.id;
  }
  const selectedSessionId = sessionIdFor(activeTab);
  function contextualTool(tab: WorkspaceTab, source?: WorkspaceTab) {
    if (tab.kind === "browser")
      return {
        ...tab,
        sourceConversation:
          source?.kind === "draft" || isConversationTab(source)
            ? source.id
            : lastConversation.current.get(selected),
      };
    if (tab.kind !== "diff" || source?.kind === "shared") return tab;
    if (source?.kind === "chat" && source.expandedTopicId)
      return toolTab("diff", source.expandedTopicId);
    // A Chat can contain only Topics and have no main session yet.
    const chatId =
      source?.kind === "chat" || source?.kind === "draft"
        ? source.id
        : source?.reviewChatId;
    if (chatId)
      return { ...tab, id: `diff:chat:${chatId}`, reviewChatId: chatId };
    return toolTab("diff", source?.sessionId ?? sessionIdFor(source));
  }
  function showWorkspaceSearch({
    type = "all",
    scope,
    trigger = document.activeElement,
  }: {
    type?: SearchType;
    scope?: SearchScope;
    trigger?: Element | null;
  } = {}) {
    const sessionId = searchTab
      ? (searchTab.sessionId ?? searchTab.diff?.sessionId ?? selectedSessionId)
      : undefined;
    setWorkspaceSearch({
      type,
      scope,
      fileSource:
        !scope && agent
          ? {
              kind: "agent",
              id: agent.id,
              sessionId,
              workingCopyId: searchTab?.workingCopyId,
            }
          : undefined,
      returnFocus: trigger instanceof HTMLElement ? trigger : null,
    });
  }
  function canPreviewConversation(tab: WorkspaceTab) {
    const keys =
      tab.kind === "chat" && tab.expandedTopicId
        ? [tab.id, tab.expandedTopicId]
        : [tab.topic?.sessionId ?? tab.id];
    return (
      keys.every(
        (key) => !composerInsertions.has(key) && !hasStoredComposerInput(key),
      ) &&
      !pendingRequests?.some(
        (r) => hasQuestionDraft(r.id) && r.sessionId === sessionIdFor(tab),
      )
    );
  }
  function openTab(
    tab: WorkspaceTab,
    agentId = selected,
    pane?: Pane,
    {
      mode = "browse",
      activatePane = true,
    }: {
      mode?: "browse" | "keep";
      activatePane?: boolean;
    } = {},
  ) {
    prefetchConversation(tab);
    if (
      activatePane &&
      (tab.kind === "chat" || tab.kind === "topic" || tab.kind === "draft")
    )
      lastConversation.current.set(agentId, tab.id);
    openWorkspaceTab(tab, agentId, pane, {
      canPreview:
        mode === "browse" && isConversationTab(tab)
          ? canPreviewConversation
          : undefined,
      activatePane,
    });
  }
  function rememberConversation(id: string) {
    const tab = workspace.tabs.find((tab) => tab.id === id);
    if (tab?.kind === "chat" || tab?.kind === "topic" || tab?.kind === "draft")
      lastConversation.current.set(selected, id);
  }
  function selectTab(id: string) {
    if (id === floatingBrowser) setFloatingBrowser("");
    const tab = workspace.tabs.find((item) => item.id === id);
    if (tab) prefetchConversation(tab);
    rememberConversation(id);
    selectWorkspaceTab(id);
  }
  const isSelected = (id: string) => id === mainTab?.id || id === sideTab?.id;
  const isVisible = (id: string) =>
    (!maximized && id === mainTab?.id) || (split && id === sideTab?.id);
  const openHtmlTab = useEventCallback(
    (owner: string, source: string, preview: HtmlPreview, file: string) => {
      if (page !== "agents" || selected !== owner || !isVisible(source)) return;
      const id = `browser:html:${JSON.stringify([source, file])}`;
      openTab(
        {
          id,
          kind: "browser",
          title: preview.title,
          htmlPreview: preview.src,
          sourceConversation: source,
        },
        owner,
        source === mainTab?.id ? "side" : "main",
      );
      focusWorkspaceTab(id);
    },
  );
  const { recent, forgetClosed } = useRecentConversations(
    selected,
    page === "agents" && agent && !maximized ? mainTab : undefined,
    page === "agents" && agent && split ? sideTab : undefined,
  );
  const panels = useMemo(() => {
    const panels: {
      owner: string;
      agent?: Agent;
      tab: WorkspaceTab;
      inTabStrip: boolean;
    }[] =
      agent || sharedWorkspace
        ? workspace.tabs
            .filter((tab) => tab.kind !== "terminal")
            .map((tab) => ({ owner: selected, agent, tab, inTabStrip: true }))
        : [];
    for (const entry of recent) {
      if (
        entry.agentId === selected &&
        workspace.tabs.some((tab) => tab.id === entry.tab.id)
      )
        continue;
      const owner = overview.data?.agents.find(
        (item) => item.id === entry.agentId,
      );
      // Replacing a preview removes its tab. Its transcript can still use
      // one of the bounded recent-panel slots.
      if (owner)
        panels.push({
          owner: owner.id,
          agent: owner,
          tab: entry.tab,
          inTabStrip: false,
        });
    }
    // Tab order only belongs to the strip. Keep mounted panel keys in DOM order.
    return panels.sort(
      (a, b) =>
        a.owner.localeCompare(b.owner) || a.tab.id.localeCompare(b.tab.id),
    );
  }, [
    agent,
    sharedWorkspace,
    workspace.tabs,
    selected,
    recent,
    overview.data?.agents,
  ]);
  const visibleTopicIds = useMemo(
    () =>
      [
        !maximized ? mainTab?.topic?.sessionId : undefined,
        split ? sideTab?.topic?.sessionId : undefined,
      ].filter((id): id is string => !!id),
    [mainTab?.topic?.sessionId, sideTab?.topic?.sessionId, maximized, split],
  );
  function prefetchAgent(id: string) {
    if (id === selected) return;
    const target = workspaces[id];
    if (target) {
      const { mainTab, sideTab, maximized, split } = workspaceView(
        target,
        compactWorkbench,
      );
      if (mainTab && !maximized) prefetchConversation(mainTab);
      if (sideTab && split) prefetchConversation(sideTab);
    } else {
      const chat = agentActivity?.chats.find((item) => item.agentId === id);
      if (chat)
        prefetchConversation({ id: chat.id, kind: "chat", title: chat.title });
    }
  }
  function choose(id: string) {
    setSelected(id);
    if (innerWidth < 760) setSidebar(false);
  }
  function openAgentProfile(id: string) {
    openTab(toolTab("profile"), id);
    choose(id);
  }
  function switchAgent(id: string) {
    prefetchAgent(id);
    choose(id);
  }
  function openSharedConversation(conversation: SharedConversation) {
    const { id, provider, runtime, title } = conversation;
    const shared = { id, provider, runtime };
    const tabId = sharedConversationKey(shared);
    const existing = workspaces[sharedWorkspaceId]?.tabs.find(
      (tab) => tab.id === tabId,
    );
    openTab(
      {
        id: tabId,
        kind: "shared",
        shared,
        title: title || t("shared.untitled"),
      },
      sharedWorkspaceId,
      existing ? paneOf(existing) : "main",
    );
    choose(sharedWorkspaceId);
    setPage("agents");
  }
  const showTasks = useCallback(
    (id?: string, kind: TaskDestination["kind"] = "task") => {
      prefetchPrimaryPage("tasks");
      setTasksOpened(true);
      setRevealTask(id ? { id, kind } : undefined);
      setPage("tasks");
    },
    [],
  );
  function openChat(chatId: string, agentId: string, title: string) {
    const chat = overview.data?.chats.find((item) => item.id === chatId);
    openTab({ id: chatId, kind: "chat", title: chat?.title ?? title }, agentId);
    choose(agentId);
    setPage("agents");
  }
  function showAutomations(id?: string) {
    if (id) setSelectedAutomation(id);
    prefetchPrimaryPage("automations");
    setPage("automations");
  }
  function openRun(run: RunLocation & { agentId: string }, title: string) {
    if (run.topic) {
      const topic = overview.data?.conversations.find(
        ({ id }) => id === run.sessionId,
      );
      openTopicTab(
        run.chatId,
        run.sessionId,
        run.agentId,
        topic?.title || title,
      );
      choose(run.agentId);
      setPage("agents");
    } else {
      openChat(run.chatId, run.agentId, title);
    }
    setFocusComposer(undefined);
    setRevealEntry({
      tabId: run.topic ? "topic:" + run.sessionId : run.chatId,
      runId: run.runId,
    });
  }
  function openTaskChat(execution: TaskExecution, title: string) {
    if (execution.topic || execution.automationId) openRun(execution, title);
    else openChat(execution.chatId, execution.agentId, title);
  }
  const showPlugin = useCallback((id?: string) => {
    prefetchPrimaryPage("plugins");
    setPluginTarget(id);
    setPage("plugins");
  }, []);
  const showProviderSettings = useCallback((id?: string, pluginId?: string) => {
    setProviderTarget({ id, pluginId });
    setPage("settings");
  }, []);
  const showChannel = useCallback(
    (channel: string) => showPlugin(channel === "feishu" ? "lever.feishu" : channel),
    [showPlugin],
  );
  function newChat(agentId: string, pane?: Pane) {
    const tab: WorkspaceTab = {
      id: draftChatId(agentId),
      kind: "draft",
      title: t("workspace.newChat"),
    };
    openTab(tab, agentId, pane);
    choose(agentId);
    requestAnimationFrame(() =>
      document
        .getElementById(`panel-${encodeURIComponent(tab.id)}`)
        ?.querySelector<HTMLElement>('[role="textbox"]')
        ?.focus(),
    );
    return tab;
  }
  function finishDraft(
    agentId: string,
    chatId: string,
    focus: boolean,
    fallbackPane?: Pane,
  ) {
    const id = draftChatId(agentId);
    replaceTab(
      id,
      { id: chatId, kind: "chat", title: t("workspace.newChat") },
      agentId,
      fallbackPane,
    );
    if (focus) setFocusComposer(chatId);
    if (lastConversation.current.get(agentId) === id)
      lastConversation.current.set(agentId, chatId);
  }
  function composerTarget(preferred?: string) {
    const isConversation = (tab: WorkspaceTab) =>
      tab.kind === "chat" || tab.kind === "topic" || tab.kind === "draft";
    const source =
      preferred && !workspace.tabs.some((tab) => tab.id === preferred)
        ? overview.data?.conversations.find(
            (item) =>
              item.agentId === selected &&
              (item.kind === "topic" ? "topic:" + item.id : item.chatId) ===
                preferred,
          )
        : undefined;
    const restored: WorkspaceTab | undefined = source
      ? source.kind === "topic"
        ? {
            id: "topic:" + source.id,
            kind: "topic",
            title: source.title,
            topic: { chatId: source.chatId, sessionId: source.id },
          }
        : { id: source.chatId, kind: "chat", title: source.title }
      : undefined;
    const target =
      workspace.tabs.find(
        (tab) => tab.id === preferred && isConversation(tab),
      ) ??
      restored ??
      workspace.tabs.find(
        (tab) =>
          tab.id === lastConversation.current.get(selected) &&
          isConversation(tab),
      ) ??
      [mainTab, sideTab].find((tab) => tab && isConversation(tab)) ??
      (chats[0]
        ? { id: chats[0].id, kind: "chat" as const, title: chats[0].title }
        : newChat(selected, "main"));
    openTab(target, selected);
    if (target.kind === "topic") return target.topic.sessionId;
    if (target.kind === "chat" && target.expandedTopicId)
      return target.expandedTopicId;
    return target.id;
  }
  function addToChat(reference: Reference) {
    insertIntoComposer({
      id: crypto.randomUUID(),
      composer: composerTarget(),
      kind: "reference",
      reference,
    });
  }
  function addBrowserContext(context: BrowserContext, source?: string) {
    const composer = composerTarget(source);
    const id = crypto.randomUUID();
    if ("file" in context) {
      insertIntoComposer({
        kind: "files",
        composer,
        id,
        files: [context.file],
      });
      return;
    }
    const { element } = context;
    const label = element.text
      ? element.tag + " «" + element.text.slice(0, 60) + "»"
      : element.tag;
    insertIntoComposer({
      kind: "reference",
      composer,
      id,
      reference: {
        kind: "browserElement",
        name: label + " · " + new URL(element.url).host,
        path: "",
        element,
      },
    });
  }
  const insertIntoComposer = useCallback((insertion: ComposerInsertion) => {
    setComposerInsertions((current) =>
      new Map(current).set(insertion.composer, insertion),
    );
  }, []);
  const insertQuote = useCallback(
    (composer: string, quote: MessageQuote, mode?: "main" | "topic") => {
      insertIntoComposer({
        id: crypto.randomUUID(),
        composer,
        kind: "quote",
        quote,
        mode,
      });
    },
    [insertIntoComposer],
  );
  function workspaceFor(agentId: string) {
    return agentId === selected ? workspace : workspaces[agentId];
  }
  function conversationTabState(conversation: Conversation) {
    const target = workspaceFor(conversation.agentId);
    const id =
      conversation.kind === "topic"
        ? "topic:" + conversation.id
        : conversation.chatId;
    if (target?.previews?.main === id || target?.previews?.side === id)
      return "preview";
    return target?.tabs.some((tab) => tab.id === id) ? "open" : "closed";
  }
  function openTopicTab(
    chatId: string,
    sessionId: string,
    agentId: string,
    title: string,
    {
      pane: preferredPane,
      mode = "browse",
      revealInChat,
    }: {
      pane?: Pane;
      mode?: "browse" | "keep";
      revealInChat?: WorkspaceTab;
    } = {},
  ) {
    const id = `topic:${sessionId}`;
    const targetTabs = workspaceFor(agentId)?.tabs ?? [];
    const existing = targetTabs.find((tab) => tab.id === id);
    const source = targetTabs.find((tab) => tab.id === chatId);
    const sourcePane = source ? paneOf(source) : undefined;
    const pane =
      preferredPane ??
      (existing
        ? paneOf(existing)
        : sourcePane === "main" || (!sourcePane && revealInChat)
          ? "side"
          : "main");
    if (revealInChat) {
      openTab(
        revealInChat,
        agentId,
        sourcePane ?? (pane === "side" ? "main" : "side"),
        { activatePane: false },
      );
      setRevealEntry({ tabId: chatId, topicId: sessionId, focusEntry: false });
    }
    openTab(
      {
        id,
        kind: "topic",
        title: title.replace(/\s+/g, " ").slice(0, 80),
        topic: { chatId, sessionId },
      },
      agentId,
      pane,
      { mode },
    );
    setFocusComposer(id);
  }
  function openTopic(view: SessionView, quote?: MessageQuote) {
    const { session, root } = view;
    queryClient.setQueryData(["session", session.id, "info"], view);
    openTopicTab(
      session.chatId,
      session.id,
      session.agentId,
      session.title ||
        root?.input ||
        root?.quote?.text ||
        root?.attachments[0]?.name ||
        t("chat.topic"),
    );
    if (quote) insertQuote(session.id, quote);
  }
  function openComparisonTopic(session: Session) {
    const chat = overview.data?.chats.find(
      (item) => item.id === session.chatId,
    );
    const topic = overview.data?.conversations.find(
      (item) => item.id === session.id,
    );
    openTopicTab(
      session.chatId,
      session.id,
      session.agentId,
      topic?.title || chat?.title || t("chat.topic"),
    );
    choose(session.agentId);
  }
  function locateComparison(origin: NonNullable<Session["comparison"]>) {
    const chat = overview.data?.chats.find((item) => item.id === origin.chatId);
    if (!chat) return;
    openChat(chat.id, chat.agentId, chat.title);
    setFocusComposer(undefined);
    setRevealEntry({ tabId: chat.id, comparisonId: origin.id });
  }
  async function quoteTo(destination: QuoteDestination) {
    const { chatId, quote } = quoteSource!;
    if (destination.kind === "topic") {
      const view = await queryClient.fetchQuery(
        sessionQuery(destination.sessionId),
      );
      openTopic(view, quote);
      return;
    }
    const chat = chats.find((item) => item.id === chatId);
    openTab({
      id: chatId,
      kind: "chat",
      title: chat ? displayChatTitle(chat, t) : t("workspace.newChat"),
    });
    if (destination.kind === "main") setChatTopic(selected, chatId);
    insertQuote(chatId, quote, destination.kind === "main" ? "main" : "topic");
  }
  function selectChatTopic(agentId: string, chatId: string, topicId?: string) {
    setChatTopic(agentId, chatId, topicId);
    setFocusComposer(topicId ? chatId : undefined);
  }
  function openConversation(
    chatId: string,
    topicId?: string,
    runId?: string,
    {
      mode,
      fromSidebar,
    }: { mode?: OpenConversationMode; fromSidebar?: boolean } = {},
  ) {
    const data = queryClient.getQueryData<Overview>(["overview"]);
    const chat = data?.chats.find((item) => item.id === chatId);
    if (!chat) return;
    const target = workspaceFor(chat.agentId);
    const pane =
      mode === "other"
        ? target &&
          workspaceView(target, compactWorkbench).activePane === "side"
          ? "main"
          : "side"
        : undefined;
    const tabMode = mode ? "keep" : "browse";
    const chatTab: WorkspaceTab = {
      id: chatId,
      kind: "chat",
      title: displayChatTitle(chat, t),
    };
    const inlinePane =
      fromSidebar && !mode && target
        ? expandedChatPane(target, compactWorkbench)
        : undefined;
    if (inlinePane) {
      openTab(chatTab, chat.agentId, inlinePane);
      selectChatTopic(chat.agentId, chatId, topicId);
      setRevealEntry(undefined);
    } else if (topicId) {
      const topic = data?.conversations.find((item) => item.id === topicId);
      openTopicTab(
        chatId,
        topicId,
        chat.agentId,
        topic?.title || t("chat.topic"),
        {
          pane,
          mode: tabMode,
          revealInChat:
            fromSidebar && !mode && topic && !topic.comparison
              ? chatTab
              : undefined,
        },
      );
    } else {
      openTab(chatTab, chat.agentId, pane, { mode: tabMode });
      if (fromSidebar && !mode) setChatTopic(chat.agentId, chatId);
    }
    choose(chat.agentId);
    setPage("agents");
    if (runId) {
      setFocusComposer(undefined);
      setRevealEntry({ tabId: topicId ? `topic:${topicId}` : chatId, runId });
    }
  }
  const openNotifiedConversation = useEffectEvent(
    async ({ chatId, topicId, runId }: NotificationTarget) => {
      const data = queryClient.getQueryData<Overview>(["overview"]);
      if (!data?.chats.some((chat) => chat.id === chatId)) {
        await overview.refetch();
      }
      openConversation(chatId, topicId, runId);
    },
  );
  useEffect(() => {
    if (!hasDesktopNotifications || !overview.isSuccess) return;
    const openClick = () => {
      void Notifications.takeClick()
        .then((target) => target && openNotifiedConversation(target))
        .catch((error: unknown) =>
          console.warn("Open Agent notification", error),
        );
    };
    const unsubscribe =
      desktopEvents.leverAgentNotificationClicked.on(openClick);
    openClick();
    return unsubscribe;
  }, [overview.isSuccess]);
  function locateTopic(chatId: string, sessionId: string) {
    const chat = overview.data?.chats.find((item) => item.id === chatId);
    if (!chat) return;
    const tabs = workspaceFor(chat.agentId)?.tabs ?? [];
    const source = tabs.find((tab) => tab.id === `topic:${sessionId}`);
    const existing = tabs.some((tab) => tab.id === chatId);
    openTab(
      {
        id: chatId,
        kind: "chat",
        title: displayChatTitle(chat, t),
      },
      chat.agentId,
      existing || !source
        ? undefined
        : paneOf(source) === "main"
          ? "side"
          : "main",
    );
    choose(chat.agentId);
    setRevealEntry({ tabId: chatId, topicId: sessionId });
  }
  async function replyToDiff(sessionId: string, content: JSONContent[]) {
    try {
      const view = await queryClient.fetchQuery(sessionQuery(sessionId));
      const { session } = view;
      choose(session.agentId);
      if (session.kind === "topic") openTopic(view);
      else
        openTab(
          {
            id: session.chatId,
            kind: "chat",
            title: displayChatTitle(
              overview.data!.chats.find((chat) => chat.id === session.chatId)!,
              t,
            ),
          },
          session.agentId,
          workspace.tabs.some((tab) => tab.id === session.chatId)
            ? undefined
            : "main",
        );
      insertIntoComposer({
        id: crypto.randomUUID(),
        composer: session.kind === "topic" ? session.id : session.chatId,
        kind: "reply",
        content,
      });
    } catch (error) {
      toast.error(String(error));
    }
  }
  function closeWorkspaceTabs(
    tabs: WorkspaceTabTarget[],
    restoreFocus = false,
  ) {
    function remove(closed: WorkspaceTabTarget[]) {
      const byAgent = new Map<string, Set<string>>();
      for (const { agentId, tab } of closed) {
        if (tab.kind === "browser" && !tab.htmlPreview && isDesktop) {
          void NativeBrowser.close(tab.id).catch((error) =>
            toast.error(String(error)),
          );
          if (floatingBrowser === tab.id) setFloatingBrowser("");
        }
        const ids = byAgent.get(agentId) ?? new Set<string>();
        ids.add(tab.id);
        byAgent.set(agentId, ids);
        messagePositions.delete(tab.id);
        if (restoreFocus && agentId === selected)
          focusAfterClose.current = { agentId, id: tab.id };
      }
      closedTabs.current = [
        ...closed.filter(({ tab }) => tab.kind !== "terminal"),
        ...closedTabs.current.filter(
          ({ agentId, tab }) => !byAgent.get(agentId)?.has(tab.id),
        ),
      ].slice(0, 20);
      for (const [agentId, ids] of byAgent) {
        forgetClosed(agentId, ids, workspaceFor(agentId)?.tabs ?? []);
        closeTabs(ids, agentId);
      }
    }

    const ordinary = tabs.filter(({ tab }) => tab.kind !== "terminal");
    if (ordinary.length) remove(ordinary);
    const pending = pendingTerminalCloses.current;
    for (const entry of tabs) {
      const { agentId, tab } = entry;
      if (tab.kind !== "terminal" || pending.has(tab.id)) continue;
      pending.add(tab.id);
      setClosingTerminals(new Set(pending));
      void closeTerminals(
        agentId,
        tab.sessionId,
        terminalLeaves(tab.terminalLayout ?? { id: tab.id }).map(
          (pane) => pane.id,
        ),
      )
        .then(
          () => remove([entry]),
          (error) => toast.error(String(error)),
        )
        .finally(() => {
          pending.delete(tab.id);
          setClosingTerminals(new Set(pending));
        });
    }
  }
  function closeWorkspaceTab(id: string) {
    const tab = workspace.tabs.find((tab) => tab.id === id);
    if (tab) closeWorkspaceTabs([{ agentId: selected, tab }], true);
  }
  function closePaneTabs(id: string, scope: "all" | "others") {
    const target = workspace.tabs.find((tab) => tab.id === id);
    if (!target) return;
    const pane = paneOf(target);
    if (scope === "others") selectTab(id);
    closeWorkspaceTabs(
      windowTabs()
        .filter(
          ({ agentId, tab }) =>
            agentId === selected &&
            paneOf(tab) === pane &&
            (scope === "all" || tab.id !== id),
        )
        .sort((a, b) => b.order - a.order),
      true,
    );
  }
  const trimWorkspaceTabs = useEffectEvent(() => {
    const limit = preferences.maxWorkspaceTabs;
    if (limit === null) return;
    const tabs = windowTabs().filter(
      ({ tab }) => !pendingTerminalCloses.current.has(tab.id),
    );
    const excess = tabs.length - limit;
    if (excess <= 0) return;
    const activeId = workspaceView(workspace, false).activeTab?.id;
    closeWorkspaceTabs(
      tabs
        .filter(
          ({ agentId, tab }) => agentId !== selected || tab.id !== activeId,
        )
        .sort((a, b) => a.order - b.order)
        .slice(0, excess),
    );
  });
  useEffect(() => {
    trimWorkspaceTabs();
  }, [preferences.maxWorkspaceTabs, workspaces, workspace, selected]);

  function reopenWorkspaceTab() {
    const data = overview.data;
    if (!data) return;
    let entry: (typeof closedTabs.current)[number] | undefined;
    while ((entry = closedTabs.current.shift())) {
      const { agentId, tab } = entry;
      const target = data.agents.find((item) => item.id === agentId);
      if (
        tab.kind !== "shared" &&
        (!target || (target.archived && agentId !== selected))
      )
        continue;
      if (workspaces[agentId]?.tabs.some((item) => item.id === tab.id))
        continue;
      if (tab.kind === "chat" && !data.chats.some((chat) => chat.id === tab.id))
        continue;
      if (tab.kind === "draft" && target?.archived) continue;
      if (
        tab.kind === "topic" &&
        !data.conversations.some(
          (conversation) => conversation.id === tab.topic.sessionId,
        )
      )
        continue;
      openTab(tab, agentId, paneOf(tab), { mode: "keep" });
      choose(agentId);
      focusWorkspaceTab(tab.id);
      return;
    }
  }

  useShortcutListener((shortcut, event) => {
    if (
      event.target instanceof Element &&
      event.target.closest(".xterm") &&
      !event.metaKey &&
      shortcut !== "ctrl+f4"
    )
      return;
    const command = availableShortcuts.find(
      (item) => binding(preferences.shortcutOverrides, item) === shortcut,
    );
    if (command === "openSettings") {
      setPage("settings");
      return true;
    }
    if (!overview.isSuccess) return;
    if (command === "search" || command === "quickSearch") {
      showWorkspaceSearch({
        type: command === "quickSearch" ? quickSearchType(searchTab) : "all",
      });
      return true;
    }
    if (page !== "agents") return;
    if (command === "toggleSidebar") {
      if (
        shortcut === defaultShortcut("toggleSidebar") &&
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, [contenteditable="true"], .monaco-editor',
        )
      )
        return;
      setSidebar((open) => !open);
      return true;
    }
    if (command === "reopenTab") {
      reopenWorkspaceTab();
      return true;
    }
    if (!agent && !sharedWorkspace) return;
    switch (command) {
      case "closeTab":
        if (activeTab) closeWorkspaceTab(activeTab.id);
        return true;
      case "newChat":
        if (!agent) return;
        if (!agent.archived) newChat(agent.id, activePane);
        return true;
      case "find": {
        const chatId =
          activeTab?.kind === "chat" ? activeTab.id : activeTab?.topic?.chatId;
        if (!chatId) return;
        showWorkspaceSearch({ scope: `chat:${chatId}` });
        return true;
      }
    }
    const number = isDesktop ? tabNumber(shortcut) : undefined;
    if (!number && command !== "previousTab" && command !== "nextTab") return;
    const tabs = workspace.tabs.filter((tab) => paneOf(tab) === activePane);
    if (!tabs.length) return true;
    const index = tabs.findIndex((tab) => tab.id === activeTab?.id);
    const offset = command === "previousTab" ? -1 : 1;
    const next =
      tabs[number ? number - 1 : (index + offset + tabs.length) % tabs.length];
    if (next) {
      selectTab(next.id);
      focusWorkspaceTab(next.id);
    }
    return true;
  });

  function openFile(
    file: FileSelection,
    source: AgentFileSource,
    pane?: Pane,
  ) {
    const { root, path } = file;
    const scope = fileScopeKey(source);
    const id = scope
      ? `files:${JSON.stringify([scope, root.id, path])}`
      : `files:${root.id}:${path}`;
    openTab(
      {
        id,
        sessionId: source.sessionId,
        workingCopyId: source.workingCopyId,
        kind: "files",
        title: path.split("/").pop()!,
        // Each open request can reveal the same file and line again.
        file: {
          ...file,
          location: file.location && { ...file.location },
        },
      },
      source.id,
      pane,
    );
    return id;
  }
  function openChatFile(
    file: FileSelection,
    source: AgentFileSource,
    pane: Pane = "side",
  ) {
    if (source.id !== selected) choose(source.id);
    const id = openFile(file, source, pane);
    if (!file.location) focusWorkspaceTab(id);
  }

  async function openSkill(
    reference: Reference,
    { sessionId, workingCopyId }: ReferenceScope,
  ) {
    if (!agent) return;
    const params = new URLSearchParams({
      agentId: agent.id,
      provider: reference.provider ?? "",
      name: reference.name,
      path: reference.path,
      ...scopeParams(sessionId, workingCopyId),
    });
    try {
      const skill = await api<Skill>(`/skills/reference?${params}`);
      const file = skillEntryTarget(
        skill,
        sessionId || workingCopyId
          ? { agentId: agent.id, sessionId, workingCopyId }
          : undefined,
      );
      const id = `files:skill:${skill.id}`;
      openTab({ id, kind: "files", title: skill.name, file }, agent.id, "side");
      focusWorkspaceTab(id);
    } catch (error) {
      toast.error(
        error instanceof APIError && error.status === 404
          ? t("skills.unavailable")
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  // Stable handlers let retained Chats skip rendering when selection changes.
  const chatNavigation = {
    onOpenFile: useEventCallback(openChatFile),
    onOpenComparisonTopic: useEventCallback(openComparisonTopic),
    onOpenRun: useEventCallback(openRun),
    onOpenAgent: useEventCallback(openAgentProfile),
    onOpenTopic: useEventCallback(openTopic),
    onSelectTopic: useEventCallback(selectChatTopic),
    onOpenTopicTool: useEventCallback(
      (
        sourceId: string,
        sessionId: string,
        kind: "files" | "diff" | "terminal",
      ) => {
        const source = workspace.tabs.find((tab) => tab.id === sourceId);
        openTab(
          toolTab(kind, sessionId),
          selected,
          source && paneOf(source) === "side" ? "main" : "side",
        );
      },
    ),
  };
  const selectStripTab = useEventCallback(selectTab);
  const closeStripTab = useEventCallback(closeWorkspaceTab);
  const closeStripTabs = useEventCallback(closePaneTabs);
  const moveStripTab = useEventCallback((id: string, pane: Pane) => {
    if (id === floatingBrowser) setFloatingBrowser("");
    rememberConversation(id);
    moveTab(id, pane);
    focusWorkspaceTab(id);
  });
  const keepStripTab = useEventCallback(keepTab);
  const prefetchStripTab = useEventCallback((id: string) => {
    if (isVisible(id)) return;
    const tab = workspace.tabs.find((item) => item.id === id);
    if (tab) prefetchConversation(tab);
  });
  const toolOpenFile = useEventCallback(openFile);
  const toolFeedback = useEventCallback(replyToDiff);
  const toolReference = useEventCallback(
    (view: SessionView, reference: Reference) => {
      if (!view.root) return;
      openTopic(view);
      insertIntoComposer({
        id: crypto.randomUUID(),
        composer: view.session.id,
        kind: "reference",
        reference,
      });
    },
  );
  const addReferenceToChat = useEventCallback(addToChat);
  const revealFileReference = useEventCallback(
    async (
      { path }: Reference,
      { sessionId, workingCopyId }: ReferenceScope,
    ) => {
      if (!agent) return;
      const pane = activePane === "side" ? "main" : "side";
      try {
        const session = sessionId
          ? (await queryClient.ensureQueryData(sessionQuery(sessionId))).session
          : undefined;
        const copies =
          !sessionId && workingCopyId
            ? await queryClient.ensureQueryData(workingCopiesQuery(agent.id))
            : undefined;
        const scope = session
          ? (session.agentId === agent.id ? session : undefined)
          : workingCopyId
            ? copies?.find(
                (copy) => copy.id === workingCopyId && availableGroup(copy),
              )
            : agent.profile;
        const file =
          scope && resolveWorkspaceFile(path, undefined, scope.roots);
        if (file) {
          openChatFile(
            file,
            { kind: "agent", id: agent.id, sessionId, workingCopyId },
            pane,
          );
        } else {
          toast.info(t("composer.sourceUnavailable"));
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
  );
  const openFileReference = agent ? revealFileReference : undefined;
  const openReference = useEventCallback(
    async (ref: Reference, scope: ReferenceScope) => {
      if (ref.kind === "skill") return openSkill(ref, scope);
      if (!ref.id) return;
      if (ref.kind === "chat" || ref.kind === "topic") {
        const session = overview.data?.conversations.find(
          ({ id }) => id === ref.id,
        );
        if (session)
          openConversation(
            session.chatId,
            ref.kind === "topic" ? session.id : undefined,
          );
        else toast.info(t("composer.sourceUnavailable"));
      } else if (ref.kind === "agent") {
        if (overview.data?.agents.some(({ id }) => id === ref.id)) {
          openAgentProfile(ref.id);
          setPage("agents");
        } else toast.info(t("composer.sourceUnavailable"));
      } else showTasks(ref.id, ref.kind === "note" ? "note" : "card");
    },
  );
  const addReference =
    agent && !agent.archived ? addReferenceToChat : undefined;
  const composer = useMemo<ContextType<typeof ComposerContext>>(
    () => ({
      addToChat: addReference,
      openReference,
      openFileReference,
      openRuntimeSettings: showProviderSettings,
      quote: insertQuote,
      quoteTo: (chatId, quote) => setQuoteSource({ chatId, quote }),
      edit: (composer, run) =>
        insertIntoComposer({
          id: crypto.randomUUID(),
          composer,
          kind: "edit",
          run,
        }),
      insertions: composerInsertions,
      inserted: (composer, id) =>
        setComposerInsertions((current) => {
          if (current.get(composer)?.id !== id) return current;
          const next = new Map(current);
          next.delete(composer);
          return next;
        }),
    }),
    [
      addReference,
      openReference,
      openFileReference,
      showProviderSettings,
      insertQuote,
      insertIntoComposer,
      composerInsertions,
    ],
  );
  const openTurnChanges = useEventCallback((selection: TurnSelection) => {
    openTab(
      {
        id: `diff:${selection.runId}:${selection.rootId}`,
        kind: "diff",
        title: t("diff.thisTurn"),
        diff: selection,
        sessionId: selection.sessionId,
      },
      selected,
      "side",
    );
  });

  return (
    <ComposerContext.Provider value={composer}>
      <DiffNavigation.Provider value={openTurnChanges}>
        <WorkbenchShell
          secondarySidebarWidth={preferences.secondarySidebarWidth}
          page={page}
          providers={providers.data ?? []}
          onPreview={prefetchPrimaryPage}
          onAgents={() => {
            setPage("agents");
            setSidebar(true);
          }}
          onPlugins={() => showPlugin()}
          onTasks={() => showTasks()}
          onAutomations={() => showAutomations()}
          onSkills={() => {
            prefetchPrimaryPage("skills");
            setPage("skills");
          }}
          onSettings={() => setPage("settings")}
        >
          <MotionConfig
            transition={{
              duration: reduceMotion ? 0 : 0.24,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <div
              className="workspace-frame agents-frame"
              hidden={page !== "agents"}
              inert={page !== "agents"}
            >
              <SecondarySidebar
                id="agent-sidebar"
                open={sidebar}
                onOpenChange={setSidebar}
                label={t(sidebar ? "agents.hideList" : "agents.showList")}
              >
                <AgentSidebar
                  overview={overview}
                  activity={agentActivity}
                  recent={recentState}
                  selected={selected}
                  readCursors={readCursors}
                  markRead={markConversationsRead}
                  canSplit={!compactWorkbench}
                  tabState={conversationTabState}
                  onNewChat={newChat}
                  onLocate={(item) =>
                    item.comparison
                      ? locateComparison(item.comparison)
                      : locateTopic(item.chatId, item.id)
                  }
                  selectedSessionId={selectedSessionId}
                  visible={page === "agents" && sidebar}
                  onShared={openSharedConversation}
                  onSearch={(event) =>
                    showWorkspaceSearch({ trigger: event.currentTarget })
                  }
                  onConversation={(conversation, mode) =>
                    openConversation(
                      conversation.chatId,
                      conversation.kind === "topic"
                        ? conversation.id
                        : undefined,
                      undefined,
                      { mode, fromSidebar: true },
                    )
                  }
                  onCreate={() =>
                    needsConnection
                      ? showProviderSettings()
                      : setCreate({ defaultAgent: agent })
                  }
                  onDuplicate={(source) =>
                    setCreate({ defaultAgent: agent, source })
                  }
                  onChoose={switchAgent}
                  onPreview={prefetchAgent}
                  onChat={(target) => {
                    const remembered = workspaces[target.id]?.lastChatId;
                    const chat =
                      overview.data?.chats.find(
                        (chat) =>
                          chat.agentId === target.id && chat.id === remembered,
                      ) ??
                      agentActivity?.chats.find(
                        (chat) => chat.agentId === target.id,
                      );
                    if (chat) {
                      openTab(
                        { id: chat.id, kind: "chat", title: chat.title },
                        target.id,
                      );
                      choose(target.id);
                    } else if (!target.archived) {
                      newChat(target.id);
                    }
                  }}
                  onOpen={(tab, agentId) => {
                    openTab(tab, agentId);
                    choose(agentId);
                  }}
                />
              </SecondarySidebar>
              <main className="workbench" ref={workbench}>
                <WorkspaceDrag
                  scope={selected}
                  onDrop={(id, targetId) => {
                    const target = workspace.tabs.find(
                      (item) => item.id === targetId,
                    );
                    moveTab(
                      id,
                      target
                        ? paneOf(target)
                        : targetId === "pane:side"
                          ? "side"
                          : "main",
                      target?.id,
                    );
                  }}
                >
                  <WorkspaceLayout
                    scope={selected}
                    split={split}
                    maximized={maximized}
                    ratio={workspace.splitRatio ?? 50}
                  >
                    {((sideTab ? ["main", "side"] : ["main"]) as Pane[]).map(
                      (pane) => {
                        const currentTab = pane === "main" ? mainTab : sideTab;
                        return (
                          <WorkspaceTabs
                            key={`${selected}:${pane}`}
                            pane={pane}
                            tabs={tabStrips[pane]}
                            selected={currentTab?.id}
                            previewId={workspace.previews?.[pane]}
                            visible={pane === "main" ? !maximized : split}
                            onFocus={() => agent && focusPane(pane)}
                            onSelect={selectStripTab}
                            onClose={closeStripTab}
                            onClosePaneTabs={closeStripTabs}
                            onMove={moveStripTab}
                            onKeep={keepStripTab}
                            onPrefetch={prefetchStripTab}
                            leading={
                              (pane === "main" || maximized) && (
                                <motion.div
                                  className="tab-leading"
                                  aria-hidden="true"
                                  initial={false}
                                  animate={{
                                    "--tab-leading-progress": sidebar ? 0 : 1,
                                  }}
                                />
                              )
                            }
                            actions={
                              agent && (
                                <WorkspaceActions
                                  compact={split}
                                  selected={currentTab}
                                  onSearch={
                                    pane === (maximized ? "side" : "main")
                                      ? (event) =>
                                          showWorkspaceSearch({
                                            scope: `agent:${agent.id}`,
                                            trigger: event.currentTarget,
                                          })
                                      : undefined
                                  }
                                  archived={agent.archived}
                                  canOpenDiff={canOpenDiff}
                                  onNewChat={() => newChat(agent.id, pane)}
                                  onOpen={(item) =>
                                    openTab(
                                      contextualTool(item, currentTab),
                                      agent.id,
                                      pane,
                                    )
                                  }
                                />
                              )
                            }
                          />
                        );
                      },
                    )}
                    {agent && (
                      <WorkspacePanelControls
                        visible={split}
                        hasTabs={!!sideTab}
                        maximized={maximized}
                        compact={compactTopic}
                        onToggle={() =>
                          compactTopic && sideVisible
                            ? focusPane(activePane === "side" ? "main" : "side")
                            : toggleSidePane()
                        }
                        onMaximize={toggleSideMaximized}
                        archived={agent.archived}
                        canOpenDiff={canOpenDiff}
                        onNewChat={() => newChat(agent.id, "side")}
                        onOpen={(item) =>
                          openTab(
                            contextualTool(item, activeTab),
                            agent.id,
                            "side",
                          )
                        }
                      />
                    )}
                    {split && !maximized && (
                      <WorkspaceDivider
                        ratio={workspace.splitRatio ?? 50}
                        onChange={resizePanes}
                      />
                    )}
                    <div className="workspace-body">
                      {!agent && !(sharedWorkspace && (mainTab || sideTab)) ? (
                        <div className="welcome">
                          <img
                            className="welcome-mark"
                            src={leverIcon}
                            width={88}
                            height={88}
                            alt="Lever"
                          />
                          <h2>{t("workspace.welcome")} </h2>
                          <p>{t("workspace.description")}</p>
                          {providers.isPending ? (
                            <Skeleton className="h-8 w-24" />
                          ) : needsConnection ? (
                            <Button onClick={() => showProviderSettings()}>
                              {t("connections.connectRuntime")}
                            </Button>
                          ) : (
                            <Button onClick={() => setCreate({})}>
                              <Plus size={16} />
                              {t("agents.create")}
                            </Button>
                          )}
                          <div className="welcome-meta">
                            <span>{t("workspace.local")} </span>
                            {!!availableConnections?.length && (
                              <span>
                                {availableConnections
                                  .map((p) => p.name)
                                  .join(" · ")}
                              </span>
                            )}
                          </div>
                        </div>
                      ) : agent && !mainTab && !maximized ? (
                        <WorkspaceStart
                          key={agent.id}
                          agent={agent}
                          agents={overview.data!.agents}
                          chats={activityChats}
                          conversations={agentActivity!.conversations}
                          visible={page === "agents"}
                          hasDraft={workspace.tabs.some(
                            (tab) => tab.kind === "draft",
                          )}
                          onFocus={() => focusPane("main")}
                          onOpenDraft={() => newChat(agent.id, "main")}
                          onConversation={(chatId, topicId) => {
                            openConversation(chatId, topicId);
                            if (!topicId) focusWorkspaceTab(chatId);
                          }}
                          onOpen={(tab) => {
                            openTab(tab, agent.id, "main");
                            focusWorkspaceTab(tab.id);
                          }}
                          onSent={(chatId) =>
                            finishDraft(
                              agent.id,
                              chatId,
                              page === "agents" && activePane === "main",
                              "main",
                            )
                          }
                        />
                      ) : null}
                      {panels.map(({ owner, agent, tab: t, inTabStrip }) => {
                        const Panel = t.kind === "topic" ? motion.div : "div";
                        const current = owner === selected;
                        const shown = current && isVisible(t.id);
                        const active = shown && page === "agents";
                        const reveal =
                          revealEntry?.tabId === t.id ? revealEntry : undefined;
                        const conversation = isConversationTab(t);
                        const retained = recent.some(
                          (entry) => entry.tab.id === t.id,
                        );
                        const readable =
                          active &&
                          focused &&
                          !create &&
                          !forward &&
                          !quoteSource &&
                          !workspaceSearch;
                        const panel = (
                          <Panel
                            key={`${owner}:${t.id}`}
                            className="tab-panel"
                            data-visible={active}
                            data-conversation={conversation || undefined}
                            {...(t.kind === "topic" && {
                              initial: { opacity: 0, x: reduceMotion ? 0 : 8 },
                              animate: {
                                opacity: active ? 1 : 0,
                                x: reduceMotion || active ? 0 : 8,
                              },
                              transition: { duration: reduceMotion ? 0 : 0.16 },
                            })}
                            data-pane={paneOf(t)}
                            onPointerDownCapture={() => {
                              rememberConversation(t.id);
                              focusPane(paneOf(t));
                            }}
                            onFocusCapture={() => {
                              rememberConversation(t.id);
                              focusPane(paneOf(t));
                            }}
                            role="tabpanel"
                            id={`panel-${encodeURIComponent(t.id)}`}
                            aria-labelledby={
                              inTabStrip
                                ? `tab-${encodeURIComponent(t.id)}`
                                : undefined
                            }
                            hidden={
                              (t.kind === "chat" && !active) ||
                              (!conversation && !isSelected(t.id))
                            }
                            inert={!active}
                            aria-hidden={!active}
                          >
                            <KeepConversationOpen
                              value={
                                (workspaces[owner] ?? workspace).previews?.[
                                  paneOf(t)
                                ] === t.id
                                  ? () => keepTab(t.id, owner)
                                  : undefined
                              }
                            >
                              <MountOnVisit
                                visible={active || t.kind === "draft"}
                                fallback={<Loading />}
                              >
                                {t.kind === "browser" && t.htmlPreview ? (
                                  <HtmlPreviewPanel
                                    preview={{
                                      src: t.htmlPreview,
                                      title: t.title,
                                    }}
                                  />
                                ) : t.kind === "browser" && agent ? (
                                  <BrowserPanel
                                    tab={t}
                                    agent={owner}
                                    visible={active}
                                    floating={
                                      current &&
                                      page === "agents" &&
                                      floatingBrowser === t.id
                                    }
                                    onFloat={(float) => {
                                      setFloatingBrowser(float ? t.id : "");
                                      if (float && !agent.archived)
                                        composerTarget(t.sourceConversation);
                                      else selectTab(t.id);
                                    }}
                                    onLocation={(url, title) =>
                                      updateBrowserLocation(
                                        owner,
                                        t.id,
                                        url,
                                        title,
                                      )
                                    }
                                    onFocus={() => focusPane(paneOf(t))}
                                    onAdd={
                                      current && !agent.archived
                                        ? (context) =>
                                            addBrowserContext(
                                              context,
                                              t.sourceConversation,
                                            )
                                        : undefined
                                    }
                                  />
                                ) : t.kind === "notes" ? (
                                  <WorkspaceNotes
                                    visible={active}
                                    agents={overview.data?.agents ?? noAgents}
                                    chats={overview.data?.chats ?? noChats}
                                    onOpenChat={openTaskChat}
                                    onOpenRun={chatNavigation.onOpenRun}
                                  />
                                ) : t.kind === "shared" ? (
                                  active && (
                                    <SharedChat conversation={t.shared} />
                                  )
                                ) : !agent ? null : conversation &&
                                  !retained &&
                                  !active ? null : t.kind === "draft" ? (
                                  <NewChat
                                    visible={active}
                                    agent={agent}
                                    agents={overview.data!.agents}
                                    onSent={(chatId) =>
                                      finishDraft(agent.id, chatId, active)
                                    }
                                  />
                                ) : t.kind === "chat" ? (
                                  <Chat
                                    {...chatNavigation}
                                    positions={messagePositions}
                                    chatId={t.id}
                                    agent={agent}
                                    onLocateTask={showTasks}
                                    onLocateChannel={showChannel}
                                    onForward={setForward}
                                    visible={readable}
                                    enabled={active}
                                    focus={focusComposer === t.id && active}
                                    onFocused={onComposerFocused}
                                    onRead={markRead}
                                    expandedTopicId={t.expandedTopicId}
                                    openTopics={visibleTopicIds}
                                    pinnedTopicIds={recentState.pinnedIds}
                                    onPinTopic={recentState.setPinned}
                                    revealTopic={reveal?.topicId}
                                    revealRun={reveal?.runId}
                                    revealComparison={reveal?.comparisonId}
                                    focusRevealedEntry={reveal?.focusEntry}
                                    onRevealed={onRevealed}
                                  />
                                ) : t.kind === "topic" && t.topic ? (
                                  <TopicConversation
                                    positions={messagePositions}
                                    onOpenFile={chatNavigation.onOpenFile}
                                    onOpenTool={(kind) =>
                                      openTab(
                                        toolTab(kind, t.topic!.sessionId),
                                        agent.id,
                                        paneOf(t) === "side" ? "main" : "side",
                                      )
                                    }
                                    sessionId={t.topic.sessionId}
                                    onOpenRun={chatNavigation.onOpenRun}
                                    onOpenAgent={chatNavigation.onOpenAgent}
                                    agent={agent}
                                    visible={readable}
                                    enabled={active}
                                    onRead={markRead}
                                    onForward={setForward}
                                    onLocate={(session) => {
                                      if (session.taskId)
                                        showTasks(session.taskId);
                                      else if (session.comparison)
                                        locateComparison(session.comparison);
                                      else
                                        locateTopic(session.chatId, session.id);
                                    }}
                                    focus={focusComposer === t.id && active}
                                    onFocused={onComposerFocused}
                                    revealRun={reveal?.runId}
                                    onRevealed={onRevealed}
                                  />
                                ) : t.kind === "profile" ? (
                                  <div className="profile-scroll">
                                    <Profile
                                      key={agent.id}
                                      agent={agent}
                                      agents={overview.data!.agents}
                                      homeDir={overview.data?.homeDir ?? ""}
                                    />
                                  </div>
                                ) : t.kind === "files" || isSelected(t.id) ? (
                                  <ScopedTool
                                    tab={t}
                                    sessionId={
                                      t.sessionId ??
                                      t.diff?.sessionId ??
                                      sessionIdFor(t)
                                    }
                                    agent={agent}
                                    dark={dark}
                                    active={
                                      page === "agents" &&
                                      activeTab?.id === t.id
                                    }
                                    openFile={toolOpenFile}
                                    onFeedback={toolFeedback}
                                    onReference={toolReference}
                                  />
                                ) : null}
                              </MountOnVisit>
                            </KeepConversationOpen>
                          </Panel>
                        );
                        const source = conversation || t.kind === "shared";
                        if (!source && !(t.kind === "browser" && t.htmlPreview))
                          return panel;
                        return (
                          <HtmlPreviewHost
                            key={`${owner}:${t.id}`}
                            onOpenTab={
                              source
                                ? (preview, file) =>
                                    openHtmlTab(owner, t.id, preview, file)
                                : undefined
                            }
                          >
                            {panel}
                          </HtmlPreviewHost>
                        );
                      })}
                      {/* Keep terminal surfaces mounted across Agent switches and reconnect
                          hidden shells on reload before the backend detach timeout. */}
                      {Object.entries(workspaces).flatMap(([agentId, state]) =>
                        overview.data?.agents.some(
                          (item) => item.id === agentId,
                        )
                          ? state.tabs
                              .filter((item) => item.kind === "terminal")
                              .sort((a, b) => a.id.localeCompare(b.id))
                              .map((item) => {
                                const active =
                                  page === "agents" &&
                                  agentId === selected &&
                                  isVisible(item.id);
                                return (
                                  <div
                                    key={`${agentId}:${item.id}`}
                                    className="tab-panel"
                                    data-visible={active}
                                    data-pane={paneOf(item)}
                                    onPointerDownCapture={() =>
                                      focusPane(paneOf(item))
                                    }
                                    onFocusCapture={() =>
                                      focusPane(paneOf(item))
                                    }
                                    role="tabpanel"
                                    id={`panel-${encodeURIComponent(item.id)}`}
                                    aria-labelledby={`tab-${encodeURIComponent(item.id)}`}
                                    hidden={
                                      agentId !== selected ||
                                      !isSelected(item.id)
                                    }
                                    inert={!active}
                                    aria-hidden={!active}
                                  >
                                    <Suspense
                                      fallback={active ? <Loading /> : null}
                                    >
                                      <Terminal
                                        agentId={agentId}
                                        sessionId={item.sessionId}
                                        layout={
                                          item.terminalLayout ?? { id: item.id }
                                        }
                                        closingTab={closingTerminals.has(
                                          item.id,
                                        )}
                                        onLayoutChange={(change) =>
                                          updateTerminalLayout(
                                            agentId,
                                            item.id,
                                            change,
                                          )
                                        }
                                        focused={
                                          active && activePane === paneOf(item)
                                        }
                                        dark={dark}
                                        onNew={() =>
                                          openTab(
                                            toolTab("terminal", item.sessionId),
                                            agentId,
                                            paneOf(item),
                                          )
                                        }
                                        onClose={() =>
                                          closeWorkspaceTab(item.id)
                                        }
                                      />
                                    </Suspense>
                                  </div>
                                );
                              })
                          : [],
                      )}
                    </div>
                  </WorkspaceLayout>
                </WorkspaceDrag>
              </main>
            </div>
          </MotionConfig>
          {workspaceSearch && overview.data && (
            <WorkspaceSearch
              initialType={workspaceSearch.type}
              initialScope={workspaceSearch.scope}
              fileSource={workspaceSearch.fileSource}
              overview={overview.data}
              readCursors={readCursors}
              returnFocus={workspaceSearch.returnFocus}
              onClose={() => setWorkspaceSearch(undefined)}
              onAgent={(id) => {
                switchAgent(id);
                setPage("agents");
              }}
              onFile={(root, path, source) => {
                const id = openFile({ root, path }, source);
                choose(source.id);
                setPage("agents");
                focusWorkspaceTab(id);
              }}
              onSelect={(chatId, topicId, runId) => {
                void openConversation(chatId, topicId, runId);
                if (!topicId && !runId)
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`tab-${encodeURIComponent(chatId)}`)
                      ?.focus(),
                  );
              }}
            />
          )}
          {quoteSource && (
            <QuoteDestinationDialog
              {...quoteSource}
              onSelect={quoteTo}
              onClose={() => setQuoteSource(undefined)}
            />
          )}
          {forward && overview.data && (
            <ForwardMessageDialog
              message={forward}
              overview={overview.data}
              onClose={() => setForward(undefined)}
              onForwarded={(chat) => {
                openTab(
                  { id: chat.id, kind: "chat", title: chat.title },
                  chat.agentId,
                );
                choose(chat.agentId);
                setForward(undefined);
              }}
            />
          )}
          <Dialog
            open={!!create}
            onOpenChange={(open) => {
              if (!open) setCreate(undefined);
            }}
          >
            <DialogContent className="agent-dialog">
              {create && (
                <Profile
                  key={create.source?.id ?? "new"}
                  agents={overview.data?.agents ?? noAgents}
                  homeDir={overview.data?.homeDir ?? ""}
                  creation={{
                    ...create,
                    onSave: (saved) => {
                      queryClient.setQueryData<Overview>(
                        ["overview"],
                        (current) =>
                          current &&
                          !current.agents.some(({ id }) => id === saved.id)
                            ? { ...current, agents: [...current.agents, saved] }
                            : current,
                      );
                      setCreate(undefined);
                      newChat(saved.id, "main");
                    },
                  }}
                />
              )}
            </DialogContent>
          </Dialog>
          {page === "skills" && (
            <SkillsPage
              agents={overview.data?.agents ?? noAgents}
              selectedAgentId={selected}
              providers={providers.data ?? []}
              homeDir={overview.data?.homeDir ?? ""}
              dark={dark}
            />
          )}
          {page === "plugins" && (
            <PluginsPage
              key={pluginTarget ?? "all"}
              agents={overview.data?.agents ?? noAgents}
              initialPlugin={pluginTarget}
              onManageConnections={(pluginId) =>
                showProviderSettings(undefined, pluginId)
              }
              onOpenChat={openChat}
            />
          )}
          {page === "automations" && (
            <AutomationsPage
              agents={overview.data?.agents ?? noAgents}
              chats={overview.data?.chats ?? noChats}
              selectedId={selectedAutomation}
              onSelect={setSelectedAutomation}
              onOpenChat={openTaskChat}
            />
          )}
          {tasksOpened && (
            <TasksPage
              visible={page === "tasks"}
              agents={overview.data?.agents ?? noAgents}
              chats={overview.data?.chats ?? noChats}
              revealTask={revealTask}
              onLocated={onTaskLocated}
              onOpenChat={openTaskChat}
              onOpenRun={openRun}
              onOpenAutomation={showAutomations}
            />
          )}
          <MountOnVisit visible={page === "settings"}>
            <SettingsPage
              visible={page === "settings"}
              theme={theme}
              onThemeChange={setTheme}
              overview={overview}
              providerTarget={providerTarget}
              onOpenPlugin={showPlugin}
            />
          </MountOnVisit>
        </WorkbenchShell>
      </DiffNavigation.Provider>
    </ComposerContext.Provider>
  );
}

const ScopedTool = memo(function ScopedTool({
  tab,
  sessionId,
  agent,
  dark,
  active,
  openFile,
  onFeedback,
  onReference,
}: {
  tab: WorkspaceTab;
  sessionId?: string;
  agent: Agent;
  dark: boolean;
  active: boolean;
  openFile: (file: FileSelection, source: AgentFileSource) => void;
  onFeedback: (sessionId: string, content: JSONContent[]) => Promise<void>;
  onReference: (view: SessionView, reference: Reference) => void;
}) {
  const { t: translate } = useTranslation();
  const composer = useContext(ComposerContext);
  const skillFile = tab.file?.source ? tab.file : undefined;
  const workingCopyId = sessionId ? undefined : tab.workingCopyId;
  const fileSource: AgentFileSource = {
    kind: "agent",
    id: agent.id,
    sessionId,
    workingCopyId,
  };
  const view = useQuery({
    ...sessionQuery(sessionId ?? ""),
    enabled: !!sessionId,
  });
  const copies = useWorkingCopies(agent.id, !!workingCopyId);
  if (sessionId && view.isPending) return <Loading />;
  if (view.error)
    return <ErrorNotice error={view.error} retry={() => void view.refetch()} />;
  if (workingCopyId && copies.isPending) return <Loading />;
  const copy = workingCopyId
    ? copies.data?.find(({ id }) => id === workingCopyId)
    : undefined;
  if (workingCopyId && !availableGroup(copy))
    return (
      <ErrorNotice
        error={copies.error ?? new Error(translate("composer.sourceUnavailable"))}
        retry={() => void copies.refetch()}
      />
    );
  const scope = view.data?.session ?? copy;
  const scopedAgent = scope
    ? {
        ...agent,
        profile: {
          ...agent.profile,
          roots: scope.roots,
          primaryRootId: scope.primaryRootId,
        },
      }
    : agent;
  const scopedComposer =
    composer && view.data?.session.workingCopyId
      ? {
          ...composer,
          addToChat: agent.archived
            ? undefined
            : (reference: Reference) => onReference(view.data!, reference),
        }
      : composer;
  return (
    <ComposerContext.Provider value={scopedComposer}>
      <WorkspaceSession.Provider value={sessionId}>
        {tab.kind === "files" ? (
          <Files
            source={skillFile?.source ?? fileSource}
            scope={
              skillFile
                ? { roots: [skillFile.root], primaryRootId: skillFile.root.id }
                : scopedAgent.profile
            }
            dark={dark}
            initialFile={tab.file}
            initialDirectoryOpen={!tab.file}
            initialPreview={skillFile ? true : undefined}
            active={active}
          />
        ) : (
          <Diff
            agent={scopedAgent}
            dark={dark}
            canReview={!tab.reviewChatId || !!sessionId}
            openFile={(root, path) => openFile({ root, path }, fileSource)}
            initialTurn={tab.diff}
            onFeedback={onFeedback}
          />
        )}
      </WorkspaceSession.Provider>
    </ComposerContext.Provider>
  );
});
