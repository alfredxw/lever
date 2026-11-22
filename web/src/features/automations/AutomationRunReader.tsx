import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ChevronDown,
  Send,
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
  Request,
  Run,
  TaskExecution,
  TaskWorkflow,
  WorkItem,
} from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RequestCard } from "@/features/chat/RequestCard";
import {
  canRecoverRun,
  RunRecoveryButton,
} from "@/features/chat/RunRecoveryButton";
import { ChatResponse, type OpenChatFile } from "@/features/chat/ChatResponse";
import {
  sessionQuery as sessionInfoQuery,
  sessionRunsQuery,
} from "@/features/chat/queries";
import { TurnChanges } from "@/features/diff/TurnChanges";
import { AutomationDiffExcerpt } from "./AutomationDiffExcerpt";
import { AutomationRunOutput, type OpenAutomationDispatch } from "./AutomationRunOutput";
import { AutomationRunControls } from "./AutomationRunControls";
import { directoryName } from "@/lib/paths";
import {
  automationPath,
  automationsQuery,
  deliveryModeOf,
  formatCompactTime,
  formatRunDuration,
  isSilentOutcome,
  planTargets,
} from "./automationsQuery";
import {
  AutomationRunStatusPill,
  LinkedWorkItemsList,
} from "./AutomationRunCard";

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

export function AutomationRunReader({
  run,
  plan,
  agent,
  requests,
  workItems,
  workflows,
  executions,
  onClose,
  onOpenChat,
  onOpenFile,
  onDispatchWorkItem,
}: {
  run: AutomationRun;
  plan?: Automation;
  agent?: Agent;
  requests: Request[];
  workItems: WorkItem[];
  workflows: ReadonlyMap<string, TaskWorkflow>;
  executions: ReadonlyMap<string, TaskExecution>;
  onClose?: () => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenFile: OpenChatFile;
  onDispatchWorkItem: OpenAutomationDispatch;
}) {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState("");
  const [promotedRuns, setPromotedRuns] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionId = run.execution?.sessionId;
  const rootRunId = run.execution?.runId;
  const sessionQuery = useInfiniteQuery({
    ...sessionRunsQuery(sessionId ?? ""),
    enabled: !!sessionId,
  });
  const info = useQuery({
    ...sessionInfoQuery(sessionId ?? ""),
    enabled: !!sessionId,
  });
  const listedRoot = sessionQuery.data?.pages
    .flatMap((page) => page.runs)
    .find((item) => item.id === rootRunId);
  const knownRoot =
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
    const map = new Map<string, Run>();
    if (rootRunQuery.data) map.set(rootRunQuery.data.id, rootRunQuery.data);
    for (const page of sessionQuery.data?.pages ?? []) {
      for (const item of page.runs) {
        if (!item.superseded) map.set(item.id, item);
      }
    }
    return [...map.values()].sort((a, b) => a.sequence - b.sequence);
  }, [sessionQuery.data?.pages, rootRunQuery.data]);

  const rootRun = knownRoot ?? rootRunQuery.data;
  const followUpRuns = useMemo(
    () =>
      rootRun
        ? sessionRuns.filter(
            (item) =>
              item.sequence > rootRun.sequence &&
              (!run.nextFireSequence || item.sequence < run.nextFireSequence),
          )
        : [],
    [sessionRuns, rootRun, run.nextFireSequence],
  );

  const runIdsInScope = useMemo(
    () =>
      new Set([
        ...(rootRunId ? [rootRunId] : []),
        ...followUpRuns.map((item) => item.id),
      ]),
    [rootRunId, followUpRuns],
  );
  const pendingRequests = useMemo(
    () => requests.filter((req) => runIdsInScope.has(req.runId)),
    [requests, runIdsInScope],
  );

  const sendReply = useMutation({
    mutationFn: (text: string) => {
      if (!run.execution) throw new Error(t("automations.noExecutionSession"));
      return api<Run>("/messages", {
        commandId: crypto.randomUUID(),
        chatId: run.execution.chatId,
        sessionId: run.execution.sessionId,
        operation: run.execution.topic ? "reply" : "main",
        text,
      });
    },
    onSuccess: () => {
      setDraft("");
      if (sessionId)
        void queryClient.invalidateQueries({
          queryKey: ["session", sessionId],
        });
      void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
      void queryClient.invalidateQueries({
        queryKey: ["automation-runs", run.automationId],
      });
      requestAnimationFrame(() => {
        if (scrollRef.current)
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    },
    onError: (error) => toast.error(error.message),
  });

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

  useEffect(() => {
    setDraft("");
  }, [run.id]);

  const rootOutput = runTextOutput(rootRun);
  const report =
    !!run.reportItems?.length && !!plan && deliveryModeOf(plan) === "audit";
  function response(text: string, turn: Run) {
    const session = info.data?.session;
    return session ? (
      <ChatResponse
        text={text}
        running={active(turn.status)}
        session={session}
        agentRoots={agent?.profile.roots}
        onOpenFile={onOpenFile}
        runId={turn.id}
      />
    ) : (
      <MessageResponse text={text} running={active(turn.status)} />
    );
  }
  const silent = isSilentOutcome(run, plan);
  const duration = formatRunDuration(run.createdAt, run.finishedAt, t);
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

  const delivery = plan ? deliveryModeOf(plan) : "deliver";
  const quickPrompts =
    run.status === "failed"
      ? [t("automations.qp.failed1"), t("automations.qp.failed2")]
      : delivery === "deliver"
        ? [t("automations.qp.deliver1"), t("automations.qp.deliver2")]
        : delivery === "audit"
          ? [t("automations.qp.audit1"), t("automations.qp.audit2")]
          : [t("automations.qp.default1"), t("automations.qp.default2")];

  return (
    <aside className="automation-reader" aria-label={plan?.name ?? run.name}>
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

      <div ref={scrollRef} className="automation-reader-scroll">
        <div className="flex flex-wrap items-center gap-2">
          <AutomationRunStatusPill status={run.status} silent={silent} />
          <span className="text-xs text-muted-foreground">{triggerText}</span>
          {rootRunId && <AutomationRunControls id={rootRunId} status={run.status} canPause={rootRun?.canPause ?? run.canPause} />}
          {rootRun &&
            !rootRun.channel &&
            !rootRun.superseded &&
            !agent?.archived &&
            !run.nextFireSequence &&
            canRecoverRun(rootRun.status) && (
              <RunRecoveryButton
                run={rootRun}
                disabled={sessionRuns.some((turn) => active(turn.status))}
                onRetried={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["automation-runs"],
                  })
                }
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

        {pendingRequests.map((req) => (
          <RequestCard key={req.id} request={req} />
        ))}

        {run.error && <div className="automation-run-error">{run.error}</div>}

        {((!!sessionId && sessionQuery.isPending) || rootRunQuery.isFetching) &&
        !rootOutput &&
        !run.summary ? (
          <Loading />
        ) : sessionQuery.error && !rootOutput && !run.summary ? (
          <ErrorNotice
            error={sessionQuery.error}
            retry={() => void sessionQuery.refetch()}
          />
        ) : rootOutput && rootRun && !report ? (
          <div className="automation-reader-brief">
            {response(rootOutput, rootRun)}
          </div>
        ) : run.summary ? (
          <p className="automation-reader-brief">{run.summary}</p>
        ) : !run.error ? (
          <p className="text-xs text-muted-foreground">
            {active(run.status) || run.status === "queued"
              ? t("status." + run.status)
              : t("tasks.noResult")}
          </p>
        ) : null}

        <AutomationRunOutput run={run} report={report} linkedItems={workItems} onFix={onDispatchWorkItem}>
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
        {report && rootOutput && rootRun && (
          <details className="automation-payload-details">
            <summary>
              <ChevronDown />
              {t("automations.fullReport")}
            </summary>
            <div className="automation-reader-brief px-2.5 pb-2">
              {response(rootOutput, rootRun)}
            </div>
          </details>
        )}

        {run.eventPayload && (
          <details
            className="automation-payload-details"
            open={run.status === "failed"}
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

        <section className="automation-thread-section">
          <h4>
            {t("automations.followUpHeading")}
            {followUpRuns.length > 0 && (
              <span className="tabular-nums"> ({followUpRuns.length})</span>
            )}
          </h4>
          {followUpRuns.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("automations.followUpEmpty")}
            </p>
          ) : (
            <div className="automation-thread-list">
              {followUpRuns.map((turn) => {
                const replyOutput = runTextOutput(turn);
                const promoted = promotedRuns[turn.id];
                return (
                  <div key={turn.id} className="automation-thread-turn">
                    {turn.input && (
                      <div className="automation-msg-bubble automation-msg-bubble--user">
                        <div className="automation-msg-meta">
                          <strong>{t("automations.you")}</strong>
                          <span>·</span>
                          <time
                            className="tabular-nums"
                            dateTime={turn.createdAt}
                            title={new Date(turn.createdAt).toLocaleString(
                              i18n.language,
                            )}
                          >
                            {formatCompactTime(turn.createdAt, i18n.language)}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap">{turn.input}</p>
                        {plan && (
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
                                <span className="inline-flex items-center gap-1">
                                  <Sparkles
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                  {t("automations.promoteHint")}
                                </span>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    disabled={promoteRule.isPending}
                                    onClick={() =>
                                      promoteRule.mutate({
                                        runKey: turn.id,
                                        ruleText: turn.input,
                                        scope: "global",
                                      })
                                    }
                                  >
                                    {t("automations.promoteGlobal", {
                                      count: planTargets(plan).length,
                                    })}
                                  </Button>
                                  <Button
                                    size="xs"
                                    variant="default"
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
                                      name: agent?.name ?? "",
                                    })}
                                  </Button>
                                </div>
                              </>
                            ) : (
                              <div className="flex w-full items-center justify-between gap-2">
                                <span className="inline-flex items-center gap-1 truncate">
                                  <Sparkles
                                    className="size-3 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate">
                                    {t("automations.promoteDetected")}
                                  </span>
                                </span>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={promoteRule.isPending}
                                  onClick={() =>
                                    promoteRule.mutate({
                                      runKey: turn.id,
                                      ruleText: turn.input,
                                      scope: "global",
                                    })
                                  }
                                >
                                  {t("automations.promoteRule")}
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {(replyOutput || turn.error || active(turn.status) || turn.status === "paused" || turn.status === "queued") && (
                      <div className="automation-msg-bubble">
                        <div className="automation-msg-meta">
                          {agent && <AgentAvatar agent={agent} size="xs" />}
                          <strong>{agent?.name ?? "Agent"}</strong>
                          <span>·</span>
                          <time
                            className="tabular-nums"
                            dateTime={turn.finishedAt || turn.createdAt}
                            title={new Date(
                              turn.finishedAt || turn.createdAt,
                            ).toLocaleString(i18n.language)}
                          >
                            {formatCompactTime(
                              turn.finishedAt || turn.createdAt,
                              i18n.language,
                            )}
                          </time>
                          <AutomationRunControls id={turn.id} status={turn.status} canPause={turn.canPause} />
                          {turn.status === "paused" && !turn.superseded && !agent?.archived && !run.nextFireSequence && (
                            <RunRecoveryButton run={turn} disabled={sessionRuns.some((other) => active(other.status))} />
                          )}
                        </div>
                        {turn.error && (
                          <div className="automation-run-error">
                            {turn.error}
                          </div>
                        )}
                        {replyOutput ? (
                          response(replyOutput, turn)
                        ) : active(turn.status) ? (
                          <span className="text-xs text-muted-foreground">
                            {t("status." + turn.status)}
                          </span>
                        ) : null}
                        <TurnChanges run={turn} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {run.execution && !run.nextFireSequence && (
        <form
          className="automation-reader-foot"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || sendReply.isPending) return;
            sendReply.mutate(text);
          }}
        >
          <div className="automation-composer">
            <textarea
              value={draft}
              rows={2}
              placeholder={t("automations.followUpPlaceholder")}
              disabled={sendReply.isPending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  const text = draft.trim();
                  if (text && !sendReply.isPending) sendReply.mutate(text);
                }
              }}
            />
            <div className="automation-composer-foot">
              <div className="automation-quick-prompts">
                {quickPrompts.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="automation-qp-chip"
                    disabled={sendReply.isPending}
                    onClick={() => sendReply.mutate(preset)}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <Button
                type="submit"
                size="xs"
                disabled={!draft.trim() || sendReply.isPending}
              >
                <Send data-icon="inline-start" />
                {t("automations.sendFollowUp")}
              </Button>
            </div>
          </div>
        </form>
      )}
    </aside>
  );
}
