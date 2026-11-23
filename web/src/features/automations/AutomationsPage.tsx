import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  BellOff,
  Inbox,
  InfinityIcon,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  Automation,
  AutomationRun,
  Chat,
  MessageQuote,
  Request,
  TaskExecution,
  WorkItem,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  SecondarySidebar,
  useSecondarySidebarState,
} from "@/components/workbench/SecondarySidebar";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { OpenChatFile } from "@/features/chat/ChatResponse";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { useCompactPanel } from "@/hooks/useCompactPanel";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { pluginsQuery } from "@/features/plugins/pluginsQuery";
import { TaskDispatchPanel } from "@/features/tasks/TaskDispatchPanel";
import { useTaskActivity } from "@/features/tasks/taskWorkflow";
import { useTaskDispatch } from "@/features/tasks/useTaskDispatch";
import { primaryDirectory } from "@/features/worktrees/scope";
import { AutomationConfigView } from "./AutomationConfigView";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationMonitor } from "./AutomationMonitor";
import { AutomationPlanHeader } from "./AutomationPlanHeader";
import { AutomationPlanIcon } from "./AutomationPlanIcon";
import { AutomationRunCard } from "./AutomationRunCard";
import { createFindingWorkItem, type AutomationDispatchTarget } from "./AutomationRunOutput";
import { AutomationRunReader } from "./AutomationRunReader";
import { AutomationSparkline } from "./AutomationSparkline";
import {
  AutomationSummaryStrip,
  usePlanConfigAttention,
} from "./AutomationSummaryStrip";
import {
  automationHistoryQuery,
  automationPath,
  automationRunsFeedQuery,
  automationsQuery,
  automationWorkItemsQuery,
  dayGroupLabel,
  eventSourceKey,
  isSilentOutcome,
  nextLabel,
  notifyPolicyOf,
  planTargets,
  runNeedsAttention,
  triggerLabel,
  type AutomationConfigSection,
  type AutomationPlanTab,
  type EventSourceOption,
} from "./automationsQuery";
import "./automations.css";

type WorkbenchView = "inbox" | "attention" | "monitor";

function resolveRunAgent(
  run: AutomationRun,
  plan: Automation | undefined,
  agents: readonly Agent[],
  chats: readonly Chat[],
) {
  const explicitId = run.agentId || run.execution?.agentId;
  if (explicitId) {
    const found = agents.find((a) => a.id === explicitId);
    if (found) return found;
  }
  if (plan) {
    if (run.targetId) {
      const target = planTargets(plan).find((t) => t.id === run.targetId);
      if (target?.agentId) {
        const found = agents.find((a) => a.id === target.agentId);
        if (found) return found;
      }
    }
    const chat = chats.find(
      (c) => c.id === (plan.destination.chatId || plan.boundChatId),
    );
    const fallbackId = plan.destination.agentId || chat?.agentId;
    if (fallbackId) return agents.find((a) => a.id === fallbackId);
  }
  return undefined;
}

export default function AutomationsPage({
  agents,
  defaultAgentId,
  chats,
  requests = [],
  selectedId,
  onSelect,
  onOpenChat,
  onOpenFile,
  onOpenRun,
  onOpenAgent,
  onForward,
}: {
  agents: Agent[];
  defaultAgentId?: string;
  chats: Chat[];
  requests?: Request[];
  selectedId?: string;
  onSelect: (id?: string) => void;
  onOpenChat: (run: TaskExecution, title: string) => void;
  onOpenFile: OpenChatFile;
  onOpenRun: OpenRun;
  onOpenAgent: (id: string) => void;
  onForward: (message: MessageQuote) => void;
}) {
  const { t, i18n } = useTranslation();
  const { compact, sidebar, setSidebar } = useSecondarySidebarState();
  const [view, setView] = useState<WorkbenchView>("inbox");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [showSilentInInbox, setShowSilentInInbox] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [readerClosed, setReaderClosed] = useState(false);
  const stage = useRef<HTMLElement>(null);
  const narrowStage = useCompactPanel(stage, 760);
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [planTab, setPlanTab] = useState<AutomationPlanTab>("runs");
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [configJump, setConfigJump] = useState<{
    section: AutomationConfigSection;
    seq: number;
  }>();
  const [dispatchTarget, setDispatchTarget] = useState<AutomationDispatchTarget>();
  const dispatchTrigger = useRef<HTMLButtonElement | null>(null);
  const [now, setNow] = useState(Date.now);

  function openDispatch(target: AutomationDispatchTarget, trigger: HTMLButtonElement) {
    dispatchTrigger.current = trigger;
    setDispatchTarget(target);
  }

  useEffect(() => {
    if (compact) setSidebar(false);
  }, [compact, setSidebar]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const plans = useQuery({ ...automationsQuery, refetchOnWindowFocus: true });
  const plugins = useQuery(pluginsQuery);
  const feed = useQuery({
    ...automationRunsFeedQuery,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const items = query.state.data;
      if (items?.some((run) => run.status === "queued" || active(run.status)))
        return 2500;
      return false;
    },
  });
  const planHistory = useQuery({
    ...automationHistoryQuery(selectedId ?? ""),
    enabled: !!selectedId,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const items = query.state.data;
      if (items?.some((run) => run.status === "queued" || active(run.status)))
        return 2000;
      return false;
    },
  });
  const workItemsQuery = useQuery({
    ...automationWorkItemsQuery,
    refetchOnWindowFocus: true,
  });
  const { executions, workflows } = useTaskActivity(true);
  const dispatch = useTaskDispatch();

  const runNow = useMutation({
    mutationFn: ({ planId, targetId }: { planId: string; targetId?: string }) =>
      api(
        `${automationPath}/${planId}/run`,
        {
          commandId: crypto.randomUUID(),
          ...(targetId ? { targetId } : {}),
        },
        "POST",
      ),
    onSuccess: (_result, { planId }) => {
      void queryClient.invalidateQueries({
        queryKey: automationsQuery.queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: automationRunsFeedQuery.queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: ["automation-runs", planId],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const sources: EventSourceOption[] = useMemo(
    () =>
      (plugins.data ?? []).flatMap((plugin) =>
        (plugin.manifest.contributes.eventSources ?? []).map(
          (contribution) => ({
            pluginId: plugin.id,
            contribution,
            enabled: plugin.enabled && plugin.installed,
            label: t("plugins.eventType." + plugin.id + "/" + contribution.id, {
              defaultValue:
                plugin.builtin || plugin.manifest.name === contribution.name
                  ? contribution.name
                  : `${plugin.manifest.name} · ${contribution.name}`,
            }),
          }),
        ),
      ),
    [plugins.data, t],
  );

  const rows = useMemo(
    () =>
      (plans.data ?? []).map((plan) => {
        const chat = chats.find(
          (item) => item.id === (plan.destination.chatId || plan.boundChatId),
        );
        const agent = agents.find(
          (item) => item.id === (plan.destination.agentId || chat?.agentId),
        );
        const source = plan.trigger.source;
        const kind =
          plan.trigger.kind === "schedule"
            ? t("automations.schedule")
            : source
              ? (sources.find(
                  ({ pluginId, contribution }) =>
                    pluginId + "/" + contribution.id === eventSourceKey(source),
                )?.label ?? source.contributionId)
              : t("automations.webhook");
        const timing = triggerLabel(plan, t);
        const next = nextLabel(plan, t, i18n.language, now);
        return { plan, agent, chat, kind, timing, next };
      }),
    [plans.data, chats, agents, sources, t, i18n.language, now],
  );

  const plansById = useMemo(
    () => new Map(rows.map((row) => [row.plan.id, row.plan])),
    [rows],
  );
  const workItemsById = useMemo(
    () => new Map((workItemsQuery.data ?? []).map((item) => [item.id, item])),
    [workItemsQuery.data],
  );

  const allFeedRuns = useMemo(() => feed.data ?? [], [feed.data]);

  const attentionRuns = useMemo(
    () =>
      allFeedRuns.filter((run) =>
        runNeedsAttention(run, requests, workItemsById, workflows, executions),
      ),
    [allFeedRuns, requests, workItemsById, workflows, executions],
  );

  const attentionPlanIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of attentionRuns) {
      if (run.automationId) ids.add(run.automationId);
    }
    for (const { plan } of rows) {
      if (plan.error || plan.sourceError || plan.sourceDisabled)
        ids.add(plan.id);
    }
    return ids;
  }, [attentionRuns, rows]);

  const nonSilentRuns = useMemo(
    () =>
      allFeedRuns.filter(
        (run) => !isSilentOutcome(run, plansById.get(run.automationId)),
      ),
    [allFeedRuns, plansById],
  );
  const silentRunsCount = allFeedRuns.length - nonSilentRuns.length;

  const firstId =
    rows.find(({ plan }) => plan.enabled)?.plan.id ?? rows[0]?.plan.id;
  const selectedRow = selectedId
    ? rows.find(({ plan }) => plan.id === selectedId)
    : undefined;

  const term = search.trim().toLocaleLowerCase();
  const metadataRows = rows.filter(({ plan, agent, kind, timing }) =>
    [
      plan.name,
      agent?.name,
      ...planTargets(plan).map(
        (target) => agents.find((a) => a.id === target.agentId)?.name,
      ),
      t("automations." + plan.trigger.kind),
      kind,
      timing,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(term),
  );

  function selectPlan(
    id: string,
    tab: AutomationPlanTab = "runs",
    section?: AutomationConfigSection,
  ) {
    setScopeFilter("all");
    setPlanTab(tab);
    setTabSwitchCount(0);
    setConfigJump(section ? { section, seq: Date.now() } : undefined);
    setSelectedRunId(undefined);
    onSelect(id);
    if (compact) setSidebar(false);
  }

  function switchPlanTab(
    nextTab: AutomationPlanTab,
    section?: AutomationConfigSection,
  ) {
    if (nextTab !== planTab) {
      setPlanTab(nextTab);
      setTabSwitchCount((n) => n + 1);
    }
    if (section) {
      setConfigJump((prev) => ({ section, seq: (prev?.seq ?? 0) + 1 }));
    } else if (nextTab === "runs") {
      setConfigJump(undefined);
    }
  }

  function selectWorkbench(nextView: WorkbenchView) {
    setView(nextView);
    setSelectedRunId(undefined);
    onSelect(undefined);
    if (compact) setSidebar(false);
  }

  // Visible runs for whichever feed is active (Inbox / Attention / Single Plan)
  const selectedPlanTargets = useMemo(
    () => (selectedRow ? planTargets(selectedRow.plan) : []),
    [selectedRow],
  );
  const rawPlanRuns = useMemo(() => {
    if (!selectedRow) return [];
    if (planHistory.data) return planHistory.data;
    return allFeedRuns.filter(
      (run) => run.automationId === selectedRow.plan.id,
    );
  }, [selectedRow, planHistory.data, allFeedRuns]);

  const feedRuns = useMemo(() => {
    if (selectedRow) {
      if (scopeFilter === "all" || selectedPlanTargets.length <= 1)
        return rawPlanRuns;
      return rawPlanRuns.filter((run) => {
        if (run.targetId) return run.targetId === scopeFilter;
        const target = selectedPlanTargets.find(
          (item) => (item.id || item.agentId) === scopeFilter,
        );
        return target ? run.agentId === target.agentId : false;
      });
    }
    if (view === "attention") return attentionRuns;
    if (view === "inbox") {
      return showSilentInInbox ? allFeedRuns : nonSilentRuns;
    }
    return [];
  }, [
    selectedRow,
    scopeFilter,
    selectedPlanTargets,
    rawPlanRuns,
    view,
    attentionRuns,
    showSilentInInbox,
    allFeedRuns,
    nonSilentRuns,
  ]);

  const matchedPlanIds = new Set(metadataRows.map(({ plan }) => plan.id));
  function matchesOutput(run: AutomationRun) {
    return (
      !term ||
      matchedPlanIds.has(run.automationId) ||
      [
        run.name,
        run.summary,
        run.error,
        run.scopePath,
        resolveRunAgent(run, plansById.get(run.automationId), agents, chats)
          ?.name,
        ...(run.reportItems ?? []),
        ...(run.pullRequests ?? []).map(
          (pr) =>
            `${pr.repository}#${pr.number} PR #${pr.number} ${pr.label ?? ""}`,
        ),
        ...(run.workItemIds ?? []).map((id) => workItemsById.get(id)?.title),
      ].some((value) => value?.toLocaleLowerCase().includes(term))
    );
  }
  const searchedRuns = term ? allFeedRuns.filter(matchesOutput) : allFeedRuns;
  const visibleRuns = term ? feedRuns.filter(matchesOutput) : feedRuns;
  const outputPlanIds = new Set(
    [...searchedRuns, ...visibleRuns].map((run) => run.automationId),
  );
  const shownRows = term
    ? rows.filter(
        ({ plan }) => matchedPlanIds.has(plan.id) || outputPlanIds.has(plan.id),
      )
    : rows;

  const activeRun = useMemo(() => {
    if (readerClosed || visibleRuns.length === 0) return undefined;
    if (selectedRunId) {
      const exact = visibleRuns.find((run) => run.id === selectedRunId);
      if (exact) return exact;
    }
    return narrowStage ? undefined : visibleRuns[0];
  }, [readerClosed, visibleRuns, selectedRunId, narrowStage]);

  const groupedVisibleRuns = useMemo(() => {
    if (!selectedRow && view === "monitor") return [];
    const groups: { label: string; runs: AutomationRun[] }[] = [];
    const byLabel = new Map<string, AutomationRun[]>();
    for (const run of visibleRuns) {
      const ts = run.plannedAt
        ? new Date(run.plannedAt * 1000).toISOString()
        : run.createdAt;
      const label = dayGroupLabel(ts, i18n.language);
      let list = byLabel.get(label);
      if (!list) {
        list = [];
        byLabel.set(label, list);
        groups.push({ label, runs: list });
      }
      list.push(run);
    }
    return groups;
  }, [selectedRow, view, visibleRuns, i18n.language]);

  const activeRunPlan = activeRun
    ? (selectedRow?.plan ?? plansById.get(activeRun.automationId))
    : undefined;
  const activeRunAgent = activeRun
    ? resolveRunAgent(activeRun, activeRunPlan, agents, chats)
    : undefined;
  const activeRunWorkItems = useMemo(() => {
    if (!activeRun?.workItemIds?.length) return [] as WorkItem[];
    return activeRun.workItemIds
      .map((id) => workItemsById.get(id))
      .filter((item): item is WorkItem => !!item);
  }, [activeRun, workItemsById]);

  function openRun(run: AutomationRun) {
    setSelectedRunId(run.id);
    setReaderClosed(false);
  }

  function renderRunCard(run: AutomationRun) {
    const plan = selectedRow?.plan ?? plansById.get(run.automationId);
    const agent = resolveRunAgent(run, plan, agents, chats);
    const runPendingRequests = run.execution?.runId
      ? requests.filter((req) => req.runId === run.execution?.runId)
      : [];
    const runWorkItems = (run.workItemIds ?? [])
      .map((id) => workItemsById.get(id))
      .filter((item): item is WorkItem => !!item);
    return (
      <AutomationRunCard
        key={run.id}
        run={run}
        plan={plan}
        agent={agent}
        selected={activeRun?.id === run.id}
        pendingRequests={runPendingRequests}
        workItems={runWorkItems}
        workflows={workflows}
        executions={executions}
        onSelect={() => openRun(run)}
        onEditRule={
          plan
            ? () => {
                if (selectedId !== plan.id)
                  selectPlan(plan.id, "config", "prompt");
                else switchPlanTab("config", "prompt");
                setSelectedRunId(run.id);
              }
            : undefined
        }
        onOpenChat={onOpenChat}
        onDispatchWorkItem={openDispatch}
      />
    );
  }

  return (
    <section
      className="workspace-frame automations-page"
      data-sidebar={sidebar}
      aria-label={t("nav.automations")}
    >
      <SecondarySidebar
        id="automation-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <header className="sidebar-heading">
          <h1>{t("nav.automations")}</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("automations.create")}
            title={t("automations.create")}
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
        </header>
        <div className="automation-search">
          <InputGroup className="sidebar-search-control">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={search}
              aria-label={t("automations.search")}
              placeholder={t("automations.search")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
        </div>
        <nav className="automation-nav" aria-label={t("automations.plans")}>
          <div className="automation-workbench-nav">
            <Button
              variant="ghost"
              className="sidebar-nav-item automation-wb-item"
              aria-current={
                !selectedId && view === "inbox" ? "page" : undefined
              }
              onClick={() => selectWorkbench("inbox")}
            >
              <Inbox className="automation-wb-icon" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="automation-nav-top">
                  <span className="truncate font-medium">
                    {t("automations.inbox")}
                  </span>
                  <span className="automation-nav-badge tabular-nums">
                    {nonSilentRuns.length}
                  </span>
                </span>
                <span className="automation-nav-timing truncate">
                  {t("automations.inboxNavDesc")}
                </span>
              </span>
            </Button>
            <Button
              variant="ghost"
              className="sidebar-nav-item automation-wb-item"
              aria-current={
                !selectedId && view === "attention" ? "page" : undefined
              }
              onClick={() => selectWorkbench("attention")}
            >
              <Bell
                className="automation-wb-icon automation-wb-bell"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="automation-nav-top">
                  <span className="truncate font-medium">
                    {t("automations.attention")}
                  </span>
                  {attentionRuns.length > 0 && (
                    <span
                      className="automation-nav-badge tabular-nums"
                      data-tone="attention"
                    >
                      {attentionRuns.length}
                    </span>
                  )}
                </span>
                <span className="automation-nav-timing truncate">
                  {t("automations.attentionNavDesc")}
                </span>
              </span>
            </Button>
            <Button
              variant="ghost"
              className="sidebar-nav-item automation-wb-item"
              aria-current={
                !selectedId && view === "monitor" ? "page" : undefined
              }
              onClick={() => selectWorkbench("monitor")}
            >
              <Activity className="automation-wb-icon" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="automation-nav-top">
                  <span className="truncate font-medium">
                    {t("automations.monitor")}
                  </span>
                  <span className="automation-nav-badge tabular-nums">
                    {rows.length}
                  </span>
                </span>
                <span className="automation-nav-timing truncate">
                  {t("automations.monitorNavDesc")}
                </span>
              </span>
            </Button>
          </div>

          {plans.isPending ? (
            <div className="grid gap-3 px-2 py-3" aria-hidden="true">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ) : (
            (["deliveryGroup", "silentGroup", "paused"] as const).map(
              (groupKey) => {
                const group = shownRows.filter(
                  ({ plan }) =>
                    groupKey ===
                    (!plan.enabled
                      ? "paused"
                      : notifyPolicyOf(plan) === "silent"
                        ? "silentGroup"
                        : "deliveryGroup"),
                );
                if (!group.length) return null;
                const label = t(`automations.${groupKey}`);
                return (
                  <section className="automation-nav-group" key={groupKey}>
                    <h2>
                      <span>{label}</span>
                      <span className="tabular-nums">{group.length}</span>
                    </h2>
                    <ul aria-label={label}>
                      {group.map(({ plan, agent, kind, timing }) => {
                        const targets = planTargets(plan);
                        const ownerLabel =
                          targets.length > 1
                            ? t("automations.targetCount", {
                                count: targets.length,
                              })
                            : (agent?.name ?? kind);
                        const when =
                          plan.trigger.kind === "schedule" ? timing : kind;
                        const sub = `${ownerLabel} · ${when}`;
                        return (
                          <AutomationNavItem
                            key={plan.id}
                            plan={plan}
                            subtitle={sub}
                            selected={selectedRow?.plan.id === plan.id}
                            hasAttention={attentionPlanIds.has(plan.id)}
                            onSelect={(id) => selectPlan(id, "runs")}
                          />
                        );
                      })}
                    </ul>
                  </section>
                );
              },
            )
          )}
          {term && plans.data && !shownRows.length && (
            <p className="automation-no-matches">{t("tasks.noMatches")}</p>
          )}
        </nav>
      </SecondarySidebar>

      <main
        ref={stage}
        className="automation-content"
        inert={compact && sidebar}
      >
        {plans.isPending ? (
          <Loading />
        ) : plans.error && !plans.data ? (
          <ErrorNotice error={plans.error} retry={() => void plans.refetch()} />
        ) : selectedId && !selectedRow ? (
          <Empty>
            <EmptyMedia variant="icon">
              <InfinityIcon />
            </EmptyMedia>
            <EmptyTitle>{t("automations.unavailable")}</EmptyTitle>
            {firstId ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectPlan(firstId)}
              >
                {t("automations.otherPlans")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreating(true)}
              >
                <Plus data-icon="inline-start" />
                {t("automations.create")}
              </Button>
            )}
          </Empty>
        ) : selectedRow ? (
          <AutomationPlanArticle
            key={selectedRow.plan.id}
            plan={selectedRow.plan}
            agents={agents}
            chats={chats}
            eventSources={sources}
            kind={selectedRow.kind}
            timing={selectedRow.timing}
            next={selectedRow.next}
            tab={planTab}
            tabSwitchCount={tabSwitchCount}
            configJump={configJump}
            runCount={rawPlanRuns.length}
            busy={runNow.isPending}
            onTabChange={(nextTab) => switchPlanTab(nextTab)}
            onOpenSection={(section) => switchPlanTab("config", section)}
            onRunNow={(targetId) => {
              runNow.mutate({ planId: selectedRow.plan.id, targetId });
              if (planTab !== "runs") switchPlanTab("runs");
            }}
            onArchived={() => {
              queryClient.setQueryData<Automation[]>(
                automationsQuery.queryKey,
                (cached) =>
                  cached?.filter(({ id }) => id !== selectedRow.plan.id),
              );
              void queryClient.invalidateQueries({
                queryKey: automationRunsFeedQuery.queryKey,
              });
              onSelect(undefined);
            }}
          >
            {selectedPlanTargets.length > 1 && (
              <div className="automation-scope-bar">
                <span className="automation-scope-label">
                  {t("automations.scopeFilterLabel")}
                </span>
                <button
                  type="button"
                  className="automation-scope-chip"
                  aria-pressed={scopeFilter === "all"}
                  onClick={() => setScopeFilter("all")}
                >
                  {t("automations.allScopes")}
                  <span className="tabular-nums">({rawPlanRuns.length})</span>
                </button>
                {selectedPlanTargets.map((target) => {
                  const key = target.id || target.agentId;
                  const targetAgent = agents.find(
                    (a) => a.id === target.agentId,
                  );
                  const dir = targetAgent
                    ? primaryDirectory(targetAgent.profile)
                    : "";
                  return (
                    <button
                      key={key}
                      type="button"
                      className="automation-scope-chip"
                      title={dir || targetAgent?.name}
                      aria-pressed={scopeFilter === key}
                      onClick={() => setScopeFilter(key)}
                    >
                      {targetAgent && (
                        <AgentAvatar agent={targetAgent} size="xs" />
                      )}
                      <span className="truncate">
                        {targetAgent?.name ?? t("tasks.unassigned")}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="automation-workbench">
              <section
                className="automation-feed-pane"
                inert={narrowStage && !!activeRun}
                aria-label={t("automations.history")}
              >
                {planHistory.isPending && !rawPlanRuns.length ? (
                  <Loading />
                ) : planHistory.error && !rawPlanRuns.length ? (
                  <ErrorNotice
                    error={planHistory.error}
                    retry={() => void planHistory.refetch()}
                  />
                ) : visibleRuns.length === 0 ? (
                  <div className="automation-feed-inner">
                    <div className="automation-no-runs">
                      <Sparkles aria-hidden="true" />
                      <span>
                        {t(term ? "tasks.noMatches" : "automations.noRuns")}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="automation-feed-inner">
                    {groupedVisibleRuns.map((group) => (
                      <div key={group.label} className="automation-day-group">
                        {group.label && (
                          <div className="automation-day-label">
                            {t("automations.dayRuns", {
                              day: group.label,
                              count: group.runs.length,
                            })}
                          </div>
                        )}
                        {group.runs.map(renderRunCard)}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {activeRun && (
                <AutomationRunReader
                  key={activeRun.id}
                  run={activeRun}
                  plan={selectedRow.plan}
                  agent={activeRunAgent}
                  agents={agents}
                  requests={requests}
                  workItems={activeRunWorkItems}
                  workflows={workflows}
                  executions={executions}
                  onClose={() => setReaderClosed(true)}
                  onOpenChat={onOpenChat}
                  onOpenFile={onOpenFile}
                  onOpenRun={onOpenRun}
                  onOpenAgent={onOpenAgent}
                  onForward={onForward}
                  onDispatchWorkItem={openDispatch}
                />
              )}
            </div>
          </AutomationPlanArticle>
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <InfinityIcon />
            </EmptyMedia>
            <EmptyTitle>{t("automations.empty")}</EmptyTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus data-icon="inline-start" />
              {t("automations.create")}
            </Button>
          </Empty>
        ) : view === "monitor" ? (
          <AutomationMonitor
            rows={shownRows}
            allRuns={searchedRuns}
            agents={agents}
            attentionPlanIds={attentionPlanIds}
            onOpenPlan={(id) => selectPlan(id, "runs")}
            onOpenRun={(planId, runId) => {
              setScopeFilter("all");
              setPlanTab("runs");
              setTabSwitchCount(0);
              setConfigJump(undefined);
              setSelectedRunId(runId);
              setReaderClosed(false);
              onSelect(planId);
            }}
            onRunNow={(planId) => runNow.mutate({ planId })}
            onCreate={() => setCreating(true)}
          />
        ) : (
          <div className="automation-feed-stage">
            <header className="automation-stage-header">
              <div className="automation-stage-title min-w-0">
                {view === "attention" ? (
                  <Bell
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : (
                  <Inbox
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <h2 className="truncate">
                  {t(
                    view === "attention"
                      ? "automations.attention"
                      : "automations.inbox",
                  )}
                </h2>
                <span className="automation-stage-sub truncate">
                  {t(
                    view === "attention"
                      ? "automations.attentionHint"
                      : "automations.inboxHint",
                  )}
                </span>
              </div>
              <div className="automation-stage-actions">
                {view === "inbox" && silentRunsCount > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-pressed={showSilentInInbox}
                    onClick={() => setShowSilentInInbox((old) => !old)}
                  >
                    <BellOff data-icon="inline-start" />
                    {showSilentInInbox
                      ? t("automations.hideSilent")
                      : t("automations.showSilentCount", {
                          count: silentRunsCount,
                        })}
                  </Button>
                )}
              </div>
            </header>

            <div className="automation-workbench">
              <div
                className="automation-feed-pane"
                inert={narrowStage && !!activeRun}
              >
                {feed.isPending && !allFeedRuns.length ? (
                  <Loading />
                ) : feed.error && !allFeedRuns.length ? (
                  <ErrorNotice
                    error={feed.error}
                    retry={() => void feed.refetch()}
                  />
                ) : !visibleRuns.length && term ? (
                  <Empty className="automation-feed-empty">
                    <EmptyTitle>{t("tasks.noMatches")}</EmptyTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSearch("")}
                    >
                      {t("automations.clearSearch")}
                    </Button>
                  </Empty>
                ) : visibleRuns.length === 0 ? (
                  <Empty className="automation-feed-empty">
                    <EmptyMedia variant="icon">
                      {view === "attention" ? <Bell /> : <Inbox />}
                    </EmptyMedia>
                    <EmptyTitle>
                      {t(
                        view === "attention"
                          ? "automations.attentionEmpty"
                          : "automations.inboxEmpty",
                      )}
                    </EmptyTitle>
                    {view === "inbox" && silentRunsCount > 0 && (
                      <EmptyDescription>
                        {t("automations.kpiSilentSub", {
                          count: silentRunsCount,
                        })}
                      </EmptyDescription>
                    )}
                    <div className="flex items-center gap-2">
                      {view === "inbox" && silentRunsCount > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowSilentInInbox(true)}
                        >
                          <BellOff data-icon="inline-start" />
                          {t("automations.showSilentCount", {
                            count: silentRunsCount,
                          })}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => selectWorkbench("monitor")}
                      >
                        <Activity data-icon="inline-start" />
                        {t("automations.monitor")}
                      </Button>
                    </div>
                  </Empty>
                ) : (
                  <div className="automation-feed-inner">
                    {groupedVisibleRuns.map((group) => (
                      <div key={group.label} className="automation-day-group">
                        {group.label && (
                          <div className="automation-day-label">
                            {t("automations.dayRuns", {
                              day: group.label,
                              count: group.runs.length,
                            })}
                          </div>
                        )}
                        {group.runs.map(renderRunCard)}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {activeRun && (
                <AutomationRunReader
                  key={activeRun.id}
                  run={activeRun}
                  plan={activeRunPlan}
                  agent={activeRunAgent}
                  agents={agents}
                  requests={requests}
                  workItems={activeRunWorkItems}
                  workflows={workflows}
                  executions={executions}
                  onClose={() => setReaderClosed(true)}
                  onOpenChat={onOpenChat}
                  onOpenFile={onOpenFile}
                  onOpenRun={onOpenRun}
                  onOpenAgent={onOpenAgent}
                  onForward={onForward}
                  onDispatchWorkItem={openDispatch}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {creating && (
        <AutomationEditor
          agents={agents.filter((agent) => !agent.archived)}
          defaultAgentId={defaultAgentId}
          chats={chats.filter((chat) => !chat.channel)}
          eventSources={sources}
          onClose={() => setCreating(false)}
          onSaved={(plan) => {
            queryClient.setQueryData<Automation[]>(
              automationsQuery.queryKey,
              (cached) =>
                cached?.some(({ id }) => id === plan.id)
                  ? cached.map((item) =>
                      item.id === plan.id ? { ...item, ...plan } : item,
                    )
                  : [plan, ...(cached ?? [])],
            );
            void plans.refetch();
            setSearch("");
            selectPlan(plan.id, "runs");
            setCreating(false);
          }}
        />
      )}

      {dispatchTarget && (
        <TaskDispatchPanel
          key={"originRunId" in dispatchTarget ? dispatchTarget.originRunId + dispatchTarget.body : dispatchTarget.id}
          task={dispatchTarget}
          agents={agents.filter((agent) => !agent.archived)}
          dialog={{
            onCloseAutoFocus: (event) => {
              event.preventDefault();
              dispatchTrigger.current?.focus({ preventScroll: true });
              dispatchTrigger.current = null;
            },
          }}
          onCancel={() => setDispatchTarget(undefined)}
          onDispatch={async (options) => {
            if ("originRunId" in dispatchTarget) {
              const item = await createFindingWorkItem(dispatchTarget);
              await dispatch({ id: item.id, record: "workItem" }, options);
            } else {
              await dispatch(dispatchTarget, options);
            }
            setDispatchTarget(undefined);
          }}
        />
      )}
    </section>
  );
}

function AutomationPlanArticle({
  plan,
  agents,
  chats,
  eventSources,
  kind,
  timing,
  next,
  tab,
  tabSwitchCount,
  configJump,
  runCount,
  busy,
  onTabChange,
  onOpenSection,
  onRunNow,
  onArchived,
  children,
}: {
  plan: Automation;
  agents: Agent[];
  chats: Chat[];
  eventSources: EventSourceOption[];
  kind: string;
  timing: string;
  next: string;
  tab: AutomationPlanTab;
  tabSwitchCount: number;
  configJump?: { section: AutomationConfigSection; seq: number };
  runCount: number;
  busy: boolean;
  onTabChange: (tab: AutomationPlanTab) => void;
  onOpenSection: (section: AutomationConfigSection) => void;
  onRunNow: (targetId?: string) => void;
  onArchived: () => void;
  children: ReactNode;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const { hasConfigAttention } = usePlanConfigAttention(plan, agents);
  const [savedNotice, setSavedNotice] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  function notifySaved() {
    setSavedNotice(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSavedNotice(false), 2400);
  }

  const panelTransition = reducedMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.23, 1, 0.32, 1] as const };
  const panelInitial =
    tabSwitchCount > 0 && !reducedMotion ? { opacity: 0, y: 6 } : false;

  return (
    <article className="automation-plan-article">
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "runs" || value === "config") onTabChange(value);
        }}
        className="automation-plan-tabs-root"
      >
        <AutomationPlanHeader
          plan={plan}
          tab={tab}
          runCount={runCount}
          hasConfigAttention={hasConfigAttention}
          busy={busy}
          savedNotice={savedNotice}
          onRunNow={() => onRunNow()}
          onArchived={onArchived}
        />

        <TabsContent value="runs" asChild>
          <motion.div
            key={`runs-${tabSwitchCount}`}
            className="automation-plan-panel"
            initial={panelInitial}
            animate={{ opacity: 1, y: 0 }}
            transition={panelTransition}
          >
            <AutomationSummaryStrip
              plan={plan}
              agents={agents}
              kind={kind}
              timing={timing}
              next={next}
              onOpenSection={onOpenSection}
              onSaved={notifySaved}
            />
            {children}
          </motion.div>
        </TabsContent>

        <TabsContent value="config" asChild>
          <motion.div
            key={`config-${tabSwitchCount}`}
            className="automation-plan-panel"
            initial={panelInitial}
            animate={{ opacity: 1, y: 0 }}
            transition={panelTransition}
          >
            <AutomationConfigView
              plan={plan}
              agents={agents}
              chats={chats}
              eventSources={eventSources}
              busy={busy}
              jumpTarget={configJump}
              onRunNow={onRunNow}
              onSaved={notifySaved}
            />
          </motion.div>
        </TabsContent>
      </Tabs>
    </article>
  );
}

function AutomationNavItem({
  plan,
  subtitle,
  selected,
  hasAttention,
  onSelect,
}: {
  plan: Automation;
  subtitle: string;
  selected: boolean;
  hasAttention: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const silent = notifyPolicyOf(plan) === "silent";
  const status = plan.recentRuns?.[0]?.status;
  const issue =
    plan.error ||
    plan.sourceError ||
    (plan.sourceDisabled && t("automations.sourceDisabled")) ||
    ((status === "failed" || status === "waiting_user") &&
      t("status." + status)) ||
    (hasAttention && t("automations.attention"));
  const issueTone =
    status === "failed" || plan.error || plan.sourceError || silent
      ? "danger"
      : "attention";

  return (
    <li>
      <Button
        variant="ghost"
        className="sidebar-nav-item automation-nav-row"
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(plan.id)}
        title={plan.name}
      >
        <AutomationPlanIcon plan={plan} className="automation-nav-icon" />
        <span className="min-w-0 flex-1">
          <span className="automation-nav-top">
            <span className="block min-w-0 flex-1 truncate">{plan.name}</span>
            {issue ? (
              <span
                className="automation-dot"
                data-tone={issueTone}
                title={issue}
              >
                <span className="sr-only">{issue}</span>
              </span>
            ) : (
              silent && (
                <BellOff
                  className="size-3 shrink-0 text-muted-foreground opacity-60"
                  aria-hidden="true"
                />
              )
            )}
          </span>
          <span className="automation-nav-meta">
            <span className="automation-nav-timing truncate">{subtitle}</span>
            <AutomationSparkline
              runs={plan.recentRuns}
              variant="dots"
              silentPlan={silent}
              count={7}
            />
          </span>
        </span>
      </Button>
    </li>
  );
}
