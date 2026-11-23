import { useCallback, useContext, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ChevronDown,
  Sparkles,
  SquareKanban,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  Automation,
  AutomationInput,
  AutomationRun,
  MessageQuote,
  Request,
  Run,
  TaskExecution,
  TaskWorkflow,
  WorkItem,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { OpenChatFile } from "@/features/chat/ChatResponse";
import { Composer } from "@/features/chat/Composer";
import { ComposerContext } from "@/features/chat/ComposerContext";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import {
  ImagePreview,
  ImagePreviewProvider,
  useImagePreview,
} from "@/features/chat/ImagePreview";
import {
  chatDelegationsQuery,
  sessionQuery as sessionInfoQuery,
  sessionRunsQuery,
  useChatActivity,
} from "@/features/chat/queries";
import { RequestCard } from "@/features/chat/RequestCard";
import { RunMessages } from "@/features/chat/RunContent";
import { TurnChanges } from "@/features/diff/TurnChanges";
import { directoryName } from "@/lib/paths";
import { AutomationDiffExcerpt } from "./AutomationDiffExcerpt";
import {
  AutomationRunStatusPill,
  LinkedWorkItemsList,
} from "./AutomationRunCard";
import { AutomationRunControls } from "./AutomationRunControls";
import {
  AutomationRunOutput,
  type OpenAutomationDispatch,
} from "./AutomationRunOutput";
import {
  automationPath,
  automationsQuery,
  deliveryModeOf,
  formatCompactTime,
  formatRunDuration,
  isSilentOutcome,
  planTargets,
} from "./automationsQuery";

function runTextOutput(run?: Run) {
  if (!run) return "";
  return run.items
    .filter((item) => item.kind === "text" && item.text.trim())
    .map((item) => item.text)
    .join("\n\n");
}

function formatJson(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

type AutomationRunReaderProps = {
  run: AutomationRun;
  plan?: Automation;
  agent?: Agent;
  agents: Agent[];
  requests: Request[];
  workItems: WorkItem[];
  workflows: ReadonlyMap<string, TaskWorkflow>;
  executions: ReadonlyMap<string, TaskExecution>;
  onClose?: () => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenFile: OpenChatFile;
  onOpenRun: OpenRun;
  onOpenAgent: (id: string) => void;
  onForward: (message: MessageQuote) => void;
  onDispatchWorkItem: OpenAutomationDispatch;
};

export function AutomationRunReader(props: AutomationRunReaderProps) {
  return (
    <aside
      className="automation-reader"
      aria-label={props.plan?.name ?? props.run.name}
    >
      <ImagePreviewProvider>
        <AutomationRunReaderContent {...props} />
      </ImagePreviewProvider>
    </aside>
  );
}

function AutomationRunReaderContent({
  run,
  plan,
  agent,
  agents,
  requests,
  workItems,
  workflows,
  executions,
  onClose,
  onOpenChat,
  onOpenFile,
  onOpenRun,
  onOpenAgent,
  onForward,
  onDispatchWorkItem,
}: AutomationRunReaderProps) {
  const { t, i18n } = useTranslation();
  const preview = useImagePreview();
  const composer = useContext(ComposerContext);
  const [promotedRuns, setPromotedRuns] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const chatId = run.execution?.chatId;
  const sessionId = run.execution?.sessionId;
  const rootRunId = run.execution?.runId;

  const sessionQuery = useInfiniteQuery({
    ...sessionRunsQuery(sessionId ?? ""),
    enabled: !!sessionId,
    subscribed: !!sessionId,
  });
  const info = useQuery({
    ...sessionInfoQuery(sessionId ?? ""),
    enabled: !!sessionId,
    subscribed: !!sessionId,
  });
  const activity = useChatActivity(chatId ?? "", !!chatId);
  const delegations = useQuery({
    ...chatDelegationsQuery(chatId ?? ""),
    enabled: !!chatId,
    subscribed: !!chatId,
  });

  const liveRoot = activity.data?.runs.find((item) => item.id === rootRunId);
  const listedRoot = sessionQuery.data?.pages
    .flatMap((page) => page.runs)
    .find((item) => item.id === rootRunId);
  const knownRoot =
    liveRoot ??
    listedRoot ??
    (info.data?.root?.id === rootRunId ? info.data?.root : undefined);
  const rootRunQuery = useQuery({
    queryKey: ["run", rootRunId ?? ""],
    queryFn: ({ signal }) =>
      api<Run>(`/runs/${rootRunId}`, undefined, "GET", signal),
    enabled:
      !!rootRunId && !knownRoot && (!sessionId || !sessionQuery.isPending),
  });

  const sessionRuns = useMemo(() => {
    const bySeq = new Map<number, Run>();
    if (
      rootRunQuery.data &&
      !rootRunQuery.data.superseded &&
      rootRunQuery.data.sequence > 0
    ) {
      bySeq.set(rootRunQuery.data.sequence, rootRunQuery.data);
    }
    for (const page of sessionQuery.data?.pages ?? []) {
      for (const item of page.runs) {
        if (!item.superseded) bySeq.set(item.sequence, item);
      }
    }
    for (const item of activity.data?.runs ?? []) {
      if (
        item.sessionId === sessionId &&
        !item.superseded &&
        (active(item.status) ||
          item.status === "paused" ||
          (item.status === "queued" && item.id === rootRunId))
      ) {
        bySeq.set(item.sequence, item);
      }
    }
    return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
  }, [
    sessionQuery.data?.pages,
    rootRunQuery.data,
    activity.data?.runs,
    sessionId,
    rootRunId,
  ]);

  const rootRun = knownRoot ?? rootRunQuery.data;
  const session = info.data?.session;
  const followUpRuns = useMemo(
    () =>
      rootRun && rootRun.sequence > 0
        ? sessionRuns.filter(
            (item) =>
              item.sequence > rootRun.sequence &&
              (!run.nextFireSequence || item.sequence < run.nextFireSequence),
          )
        : [],
    [sessionRuns, rootRun, run.nextFireSequence],
  );

  const allAgents = activity.data?.agents ?? agents;
  const allRequests = activity.data?.requests ?? requests;
  const activeRun = session
    ? activity.data?.runs.find(
        (item) => item.sessionId === session.id && active(item.status),
      )
    : undefined;
  const pausedRun = session
    ? activity.data?.runs.find(
        (item) => item.sessionId === session.id && item.status === "paused",
      )
    : undefined;
  const queuedRuns = useMemo(
    () =>
      session
        ? (activity.data?.runs.filter(
            (item) =>
              item.sessionId === session.id &&
              item.status === "queued" &&
              !(rootRun?.status === "queued" && item.id === rootRun.id),
          ) ?? [])
        : [],
    [activity.data?.runs, session, rootRun?.id, rootRun?.status],
  );
  const sessionBusy = Boolean(activeRun);
  const canReply = Boolean(
    run.execution && !run.nextFireSequence && session && agent,
  );
  const composerKey = session
    ? session.kind === "topic"
      ? session.id
      : session.chatId
    : "";

  const quote = composer?.quote;
  const edit = composer?.edit;
  const quoteMessage = useCallback(
    (message: MessageQuote) => {
      if (composerKey) quote?.(composerKey, message);
    },
    [composerKey, quote],
  );
  const editMessage = useCallback(
    (turn: Run) => {
      if (composerKey) edit?.(composerKey, turn);
    },
    [composerKey, edit],
  );

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, []);

  const invalidateAutomationRuns = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
    void queryClient.invalidateQueries({
      queryKey: ["automation-runs", run.automationId],
    });
  }, [run.automationId]);

  const promoteRule = useMutation({
    mutationFn: async ({
      ruleText,
      scope,
    }: {
      runKey: string;
      ruleText: string;
      scope: "global" | "target";
    }) => {
      if (!plan) throw new Error(t("automations.notFound"));
      const nextTargets = plan.targets?.map((target) =>
        scope === "target" && target.id === run.targetId
          ? {
              ...target,
              prompt: target.prompt
                ? `${target.prompt}\n${ruleText}`
                : ruleText,
            }
          : target,
      );
      const input: AutomationInput = {
        name: plan.name,
        prompt:
          scope === "global"
            ? `${plan.prompt.trim()}\n${ruleText}`
            : plan.prompt,
        trigger: plan.trigger,
        destination: plan.destination,
        selection: plan.selection,
        targets: nextTargets,
        notifyPolicy: plan.notifyPolicy,
        deliveryMode: plan.deliveryMode,
        workItem: plan.workItem,
        quiet: plan.quiet,
      };
      return api<Automation>(`${automationPath}/${plan.id}`, input, "PUT");
    },
    onSuccess: (saved, { runKey, scope }) => {
      setPromotedRuns((prev) => ({ ...prev, [runKey]: scope }));
      queryClient.setQueryData<Automation[]>(
        automationsQuery.queryKey,
        (cached) =>
          cached?.map((item) =>
            item.id === saved.id ? { ...item, ...saved } : item,
          ),
      );
      toast.success(t("automations.promoted"));
    },
    onError: (error) => toast.error(error.message),
  });

  const convertToWorkItem = useMutation({
    mutationFn: () => {
      const text = runTextOutput(rootRun) || run.summary || run.error || "";
      const titleBase = `${plan?.name ?? run.name}`;
      const title = Array.from(titleBase).slice(0, 80).join("");
      return api<WorkItem>("/tasks/work-items", {
        title,
        originRunId: rootRunId,
        body: text.slice(0, 8000),
        assigneeAgentId: agent?.id || run.agentId || undefined,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["work-items"] });
      void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
      toast.success(t("automations.convertedToWorkItem"));
    },
    onError: (error) => toast.error(error.message),
  });

  const effectiveStatus = rootRun?.status ?? run.status;
  const report =
    !!run.reportItems?.length && !!plan && deliveryModeOf(plan) === "audit";
  const hasRootChat = Boolean(rootRun && session && agent);
  const fallbackRequests = useMemo(
    () =>
      !hasRootChat && rootRunId
        ? allRequests.filter((req) => req.runId === rootRunId)
        : [],
    [hasRootChat, rootRunId, allRequests],
  );

  const silent = isSilentOutcome(run, plan);
  const duration = formatRunDuration(
    run.createdAt,
    rootRun?.finishedAt ?? run.finishedAt,
    t,
  );
  const timestamp = run.plannedAt
    ? new Date(run.plannedAt * 1000).toISOString()
    : run.createdAt;
  const scopePath = run.scopePath;
  const scopeName = scopePath ? directoryName(scopePath) : "";
  const isMultiTarget = (plan ? planTargets(plan).length : 0) > 1;
  const triggerText =
    run.trigger === "event"
      ? t("automations.eventsReceived", { count: run.eventCount ?? 0 })
      : t(
          run.trigger === "manual"
            ? "automations.manual"
            : "automations.schedule",
        );

  const outputSection = (
    <AutomationRunOutput
      run={run}
      report={report}
      linkedItems={workItems}
      onFix={onDispatchWorkItem}
    >
      {rootRun && (
        <TurnChanges
          run={rootRun}
          preview={(rootId, file) => (
            <AutomationDiffExcerpt
              run={rootRun}
              rootId={rootId}
              path={file.path}
            />
          )}
        />
      )}
    </AutomationRunOutput>
  );

  return (
    <>
      <header className="automation-reader-head">
        {agent && <AgentAvatar agent={agent} size="sm" />}
        <div className="min-w-0 flex-1">
          <div className="automation-reader-title truncate">
            {plan?.name ?? run.name}
          </div>
          <div className="automation-reader-meta truncate tabular-nums">
            {agent?.name ?? t("tasks.unassigned")}
            {" · "}
            <time
              dateTime={timestamp}
              title={new Date(timestamp).toLocaleString(i18n.language)}
            >
              {formatCompactTime(timestamp, i18n.language)}
            </time>
            {duration && ` · ${duration}`}
            {scopeName && (
              <>
                {" · "}
                <span className="mono">{scopeName}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run.execution && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onOpenChat(run.execution!, plan?.name ?? run.name)}
            >
              <ArrowUpRight data-icon="inline-start" />
              {t("automations.openInAgents")}
            </Button>
          )}
          {onClose && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("common.close")}
              onClick={onClose}
            >
              <X />
            </Button>
          )}
        </div>
      </header>

      <div className="automation-reader-body">
        <div
          ref={scrollRef}
          className="automation-reader-scroll"
          inert={!!preview.file || undefined}
        >
          <div className="flex flex-wrap items-center gap-2">
            <AutomationRunStatusPill
              status={effectiveStatus}
              silent={silent}
            />
            <span className="text-xs text-muted-foreground">{triggerText}</span>
            {rootRunId && (!canReply || effectiveStatus === "queued") && (
              <AutomationRunControls
                id={rootRunId}
                status={effectiveStatus}
                canPause={rootRun?.canPause ?? run.canPause}
              />
            )}
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              disabled={convertToWorkItem.isPending}
              onClick={() => convertToWorkItem.mutate()}
            >
              <SquareKanban data-icon="inline-start" />
              {t("automations.convertToWorkItem")}
            </Button>
          </div>

          {report && outputSection}

          {hasRootChat && rootRun && session && agent ? (
            <div
              className="run-content automation-root-turn"
              data-run-id={rootRun.id}
              data-status={rootRun.status}
            >
              <RunMessages
                run={rootRun}
                agent={agent}
                agents={allAgents}
                delegatedRuns={delegations.data?.outgoing[rootRun.id]}
                onOpenRun={onOpenRun}
                onOpenAgent={onOpenAgent}
                session={session}
                onOpenFile={onOpenFile}
                requests={allRequests}
                sessionBusy={sessionBusy}
                hideUserMessage
                hideAgentHeader
                hideTurnChanges
                canRecover={!run.nextFireSequence}
                wrapBody={
                  report
                    ? (content) =>
                        content ? (
                          <details className="automation-payload-details">
                            <summary>
                              <ChevronDown aria-hidden="true" />
                              {t("automations.fullReport")}
                            </summary>
                            <div className="px-2.5 pb-2">{content}</div>
                          </details>
                        ) : null
                    : undefined
                }
                onRetried={() => {
                  invalidateAutomationRuns();
                  scrollToBottom();
                }}
                onQuote={canReply ? quoteMessage : undefined}
                onForward={onForward}
              />
            </div>
          ) : (
            <>
              {fallbackRequests.map((req) => (
                <RequestCard key={req.id} request={req} />
              ))}
              {run.error && (
                <div className="automation-run-error">{run.error}</div>
              )}
              {((!!sessionId &&
                (sessionQuery.isPending || info.isPending)) ||
                rootRunQuery.isFetching) &&
              !run.summary ? (
                <Loading />
              ) : (sessionQuery.error || info.error) && !run.summary ? (
                <ErrorNotice
                  error={sessionQuery.error ?? info.error}
                  retry={() => {
                    void sessionQuery.refetch();
                    void info.refetch();
                  }}
                />
              ) : run.summary ? (
                <p className="automation-reader-brief">{run.summary}</p>
              ) : !run.error ? (
                <p className="text-xs text-muted-foreground">
                  {active(effectiveStatus) || effectiveStatus === "queued"
                    ? t("status." + effectiveStatus)
                    : t("tasks.noResult")}
                </p>
              ) : null}
            </>
          )}

          {!report && outputSection}

          {run.eventPayload && (
            <details
              className="automation-payload-details"
              open={effectiveStatus === "failed"}
            >
              <summary>
                <ChevronDown aria-hidden="true" />
                {t("automations.eventPayload")}
              </summary>
              <pre className="automation-json-pre">
                {formatJson(run.eventPayload)}
              </pre>
            </details>
          )}

          <LinkedWorkItemsList
            items={workItems}
            workflows={workflows}
            executions={executions}
            onDispatch={onDispatchWorkItem}
          />

          {followUpRuns.length > 0 && session && agent && (
            <div className="automation-thread-list">
              {followUpRuns.map((turn) => {
                const promoted = promotedRuns[turn.id];
                const ruleText = turn.input.trim();
                return (
                  <div
                    key={turn.id}
                    className="run-content automation-thread-turn"
                    data-run-id={turn.id}
                    data-status={turn.status}
                  >
                    <RunMessages
                      run={turn}
                      agent={agent}
                      agents={allAgents}
                      delegatedRuns={delegations.data?.outgoing[turn.id]}
                      onOpenRun={onOpenRun}
                      onOpenAgent={onOpenAgent}
                      session={session}
                      onOpenFile={onOpenFile}
                      requests={allRequests}
                      sessionBusy={sessionBusy}
                      canRecover={!run.nextFireSequence}
                      onRetried={() => {
                        invalidateAutomationRuns();
                        scrollToBottom();
                      }}
                      onQuote={canReply ? quoteMessage : undefined}
                      onForward={onForward}
                      onEdit={canReply && edit ? editMessage : undefined}
                      afterUserMessage={
                        plan && ruleText ? (
                          <div className="automation-msg-promote">
                            {promoted ? (
                              <span
                                className="automation-pill"
                                data-tone="positive"
                              >
                                <Sparkles className="size-3" />
                                {t("automations.promoted")}
                              </span>
                            ) : isMultiTarget && run.targetId ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={promoteRule.isPending}
                                  onClick={() =>
                                    promoteRule.mutate({
                                      runKey: turn.id,
                                      ruleText: turn.input,
                                      scope: "global",
                                    })
                                  }
                                >
                                  <Sparkles data-icon="inline-start" />
                                  {t("automations.promoteGlobal", {
                                    count: planTargets(plan).length,
                                  })}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={promoteRule.isPending}
                                  onClick={() =>
                                    promoteRule.mutate({
                                      runKey: turn.id,
                                      ruleText: turn.input,
                                      scope: "target",
                                    })
                                  }
                                >
                                  {t("automations.promoteTarget", {
                                    name: agent.name,
                                  })}
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={promoteRule.isPending}
                                onClick={() =>
                                  promoteRule.mutate({
                                    runKey: turn.id,
                                    ruleText: turn.input,
                                    scope: "global",
                                  })
                                }
                              >
                                <Sparkles data-icon="inline-start" />
                                {t("automations.promoteRule")}
                              </Button>
                            )}
                          </div>
                        ) : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <ImagePreview />
      </div>

      {canReply && session && agent && chatId && (
        <footer className="automation-reader-foot">
          <Composer
            agentId={agent.id}
            agents={allAgents}
            chatId={chatId}
            session={session}
            profile={agent.profile}
            reply={session.kind === "topic"}
            fixedSession
            activeRun={activeRun}
            pausedRun={pausedRun}
            queuedRuns={queuedRuns}
            archived={agent.archived}
            visible
            onSent={() => {
              invalidateAutomationRuns();
              scrollToBottom();
            }}
          />
        </footer>
      )}
    </>
  );
}
