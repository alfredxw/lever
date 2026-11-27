import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  CircleUser,
  GitBranch,
  Monitor,
  Square,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  Answer,
  ChatDelegations,
  DelegatedRun,
  Request,
  Run,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { OpenRun } from "./DelegatedTasks";
import { RequestCard } from "./RequestCard";
import {
  RemoteDelegationDialog,
  type RemoteDelegationTarget,
} from "./RemoteDelegationDialog";

const ACTIVE_STATUSES = new Set([
  "queued",
  "starting",
  "running",
  "waiting_user",
  "cancelling",
]);

export function isDelegatedRunActive(status: string) {
  return ACTIVE_STATUSES.has(status);
}

export function selectSessionDelegations(
  delegations: ChatDelegations | undefined,
  sessionId: string | undefined,
  sessionRuns: Run[] | undefined,
): DelegatedRun[] {
  if (!delegations?.outgoing || !sessionId) return [];
  const runIds = new Set((sessionRuns ?? []).map((r) => r.id));
  const latest = new Map<string, DelegatedRun>();
  for (const [parentRunId, list] of Object.entries(delegations.outgoing)) {
    for (const item of list) {
      const belongs = item.parentSessionId
        ? item.parentSessionId === sessionId
        : runIds.has(parentRunId);
      if (!belongs) continue;
      const key = item.delegationId || item.remoteRowId || item.runId;
      const prev = latest.get(key);
      if (!prev || (item.turn ?? 1) >= (prev.turn ?? 1)) {
        latest.set(key, item);
      }
    }
  }
  return [...latest.values()];
}

function statusLabel(
  t: ReturnType<typeof useTranslation>["t"],
  status: string,
) {
  return t(
    status === "running" ? "tasks.status.running" : `status.${status}`,
    { defaultValue: status },
  );
}

export function ActiveDelegationsBar({
  chatId,
  sessionId,
  delegations,
  sessionRuns,
  agents,
  requests,
  onOpenRun,
}: {
  chatId: string;
  sessionId?: string;
  delegations?: ChatDelegations;
  sessionRuns?: Run[];
  agents: Agent[];
  requests: Request[];
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [remoteTarget, setRemoteTarget] =
    useState<RemoteDelegationTarget | null>(null);

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  const items = useMemo(() => {
    const deduped = selectSessionDelegations(delegations, sessionId, sessionRuns);
    return deduped
      .map((run) => {
        const isRemote = Boolean(run.deviceId);
        const childRequests = isRemote
          ? (run.remoteRequests ?? [])
          : requests.filter((req) => req.runId === run.runId);
        const active = isDelegatedRunActive(run.status);
        const waiting =
          childRequests.length > 0 || run.status === "waiting_user";
        return { run, isRemote, childRequests, active, waiting };
      })
      .sort((a, b) => {
        const rank = (x: { waiting: boolean; active: boolean }) =>
          x.waiting ? 0 : x.active ? 1 : 2;
        return rank(a) - rank(b);
      });
  }, [delegations, requests, sessionId, sessionRuns]);

  const waitingCount = items.filter((item) => item.waiting).length;
  const runningCount = items.filter(
    (item) => item.active && !item.waiting,
  ).length;
  const activeCount = waitingCount + runningCount;
  const finishedCount = items.length - activeCount;

  const latestSessionRun = useMemo(() => {
    if (!sessionRuns?.length) return undefined;
    return sessionRuns.reduce((best, run) =>
      run.sequence >= best.sequence ? run : best,
    );
  }, [sessionRuns]);
  const parentStoppedWithActive =
    activeCount > 0 && latestSessionRun?.status === "interrupted";

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["chat-delegations", chatId],
    });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    if (sessionId) {
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    }
  };

  const stopOne = useMutation({
    mutationFn: (run: DelegatedRun) => {
      if (run.delegationId) {
        return api(`/delegations/${run.delegationId}/stop`, {});
      }
      if (run.remoteRowId) {
        return api(`/delegations/remote/${run.remoteRowId}/stop`, {});
      }
      return api(`/runs/${run.runId}/stop`, {});
    },
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  const stopAll = useMutation({
    mutationFn: () => {
      if (!sessionId) return Promise.resolve();
      return api(`/sessions/${sessionId}/delegations/stop`, {});
    },
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  if (items.length === 0 || (activeCount === 0 && !expanded)) {
    return null;
  }

  return (
    <section
      className="mb-2.5 overflow-hidden rounded-xl border border-border/80 bg-(--panel-background)"
      aria-label={t("chat.activeDelegations.label")}
    >
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground focus-visible:outline-none"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span className="flex shrink-0 items-center gap-1.5">
            {waitingCount > 0 ? (
              <span
                className="size-2 rounded-full bg-(--status-attention)"
                aria-hidden
              />
            ) : runningCount > 0 ? (
              <span
                className="size-2 rounded-full bg-(--status-positive)"
                aria-hidden
              />
            ) : (
              <span
                className="size-2 rounded-full bg-muted-foreground/45"
                aria-hidden
              />
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
            <span className="font-medium text-foreground">
              {t("chat.activeDelegations.title")}
            </span>
            {waitingCount > 0 && (
              <span className="text-(--status-attention)">
                {t("chat.activeDelegations.waiting", { count: waitingCount })}
              </span>
            )}
            {runningCount > 0 && (
              <span>
                {t("chat.activeDelegations.running", { count: runningCount })}
              </span>
            )}
            {finishedCount > 0 && (
              <span>
                {t("chat.activeDelegations.finished", { count: finishedCount })}
              </span>
            )}
            {parentStoppedWithActive && (
              <span className="text-muted-foreground">
                · {t("chat.activeDelegations.stillRunningHint")}
              </span>
            )}
          </span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {expanded ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronUp className="size-3.5" aria-hidden />
            )}
          </span>
        </button>
        {waitingCount > 0 && !expanded && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs text-(--status-attention)"
            onClick={() => setExpanded(true)}
          >
            {t("chat.activeDelegations.reviewApprovals")}
          </Button>
        )}
        {(parentStoppedWithActive || (expanded && activeCount > 0)) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={stopAll.isPending}
            onClick={() => stopAll.mutate()}
          >
            <Square className="size-2.5 fill-current" aria-hidden />
            {t("chat.activeDelegations.stopAll")}
          </Button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.16, ease: "easeOut" }}
            className="overflow-hidden border-t border-border/70"
          >
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto p-2.5">
              {items.map(({ run, isRemote, childRequests, active }) => {
                const agent = isRemote
                  ? undefined
                  : agents.find((a) => a.id === run.agentId);
                const agentName =
                  agent?.name ?? run.agentName ?? t("chat.delegationAgent");
                const turns = Math.max(run.turn ?? 1, run.turns ?? 1);
                const key =
                  run.delegationId ||
                  run.remoteRowId ||
                  run.runId ||
                  `${run.agentId}:${turns}`;
                const openChild = () => {
                  if (isRemote) {
                    setRemoteTarget({
                      remoteRowId: run.remoteRowId,
                      hubId: run.hubId ?? "",
                      spaceId: run.spaceId ?? "",
                      deviceId: run.deviceId ?? "",
                      deviceName: run.deviceName || run.deviceId || "",
                      agentName,
                      chatId: run.chatId,
                      title: run.title,
                      status: run.status,
                    });
                    return;
                  }
                  onOpenRun(run, run.title, {
                    sideBySide: true,
                    sourceSessionId: sessionId,
                  });
                };
                return (
                  <div
                    key={key}
                    className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-2"
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <span className="mt-0.5 shrink-0">
                        {agent ? (
                          <AgentAvatar agent={agent} size="sm" />
                        ) : isRemote ? (
                          <span className="flex size-5 items-center justify-center rounded-full border border-border bg-muted/60">
                            <Monitor
                              className="size-3 text-muted-foreground"
                              aria-hidden
                            />
                          </span>
                        ) : (
                          <CircleUser
                            className="size-5 text-muted-foreground"
                            aria-hidden
                          />
                        )}
                      </span>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                          {isRemote && (
                            <>
                              <span className="inline-flex min-w-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                                <Monitor
                                  className="size-3 shrink-0"
                                  aria-hidden
                                />
                                <span className="max-w-24 truncate">
                                  {run.deviceName || run.deviceId}
                                </span>
                              </span>
                              <span
                                aria-hidden
                                className="text-muted-foreground"
                              >
                                ·
                              </span>
                            </>
                          )}
                          <span className="font-medium text-foreground">
                            {agentName}
                          </span>
                          <span aria-hidden className="text-muted-foreground">
                            ·
                          </span>
                          <span
                            data-status={run.status}
                            className="text-muted-foreground data-[status=failed]:text-destructive data-[status=running]:text-(--status-positive) data-[status=waiting_user]:text-(--status-attention)"
                          >
                            {statusLabel(t, run.status)}
                          </span>
                          {turns > 1 && (
                            <>
                              <span
                                aria-hidden
                                className="text-muted-foreground"
                              >
                                ·
                              </span>
                              <span className="tabular-nums text-muted-foreground">
                                {t("chat.delegationTurnNumber", {
                                  turn: run.turn ?? turns,
                                })}
                              </span>
                            </>
                          )}
                          {run.workingCopyName && (
                            <>
                              <span
                                aria-hidden
                                className="text-muted-foreground"
                              >
                                ·
                              </span>
                              <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                                <GitBranch
                                  className="size-3 shrink-0"
                                  aria-hidden
                                />
                                <span className="max-w-28 truncate">
                                  {run.workingCopyName}
                                </span>
                              </span>
                            </>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {run.summary || run.title}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {active && run.status !== "cancelling" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                            disabled={stopOne.isPending || stopAll.isPending}
                            onClick={() => stopOne.mutate(run)}
                          >
                            <Square
                              className="size-2.5 fill-current"
                              aria-hidden
                            />
                            {t("chat.stop")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                          onClick={openChild}
                        >
                          {t(
                            isRemote
                              ? "chat.openRemoteDelegation"
                              : "chat.openDelegation",
                          )}
                          <ArrowUpRight className="size-3" aria-hidden />
                        </Button>
                      </div>
                    </div>
                    {childRequests.length > 0 && (
                      <div className="flex min-w-0 flex-col gap-2 pl-2">
                        {childRequests.map((request) => (
                          <RequestCard
                            key={request.id}
                            request={request}
                            source={
                              isRemote
                                ? t("chat.requestFromRemoteCollaborator", {
                                    device: run.deviceName || run.deviceId,
                                    agent: agentName,
                                  })
                                : t("chat.requestFromCollaborator", {
                                    agent: agentName,
                                  })
                            }
                            onSubmit={
                              isRemote && run.remoteRowId
                                ? (value: Answer | "allow-run") =>
                                    api(
                                      `/delegations/remote/${run.remoteRowId}/answer`,
                                      value === "allow-run"
                                        ? {
                                            requestId: request.id,
                                            allowRun: true,
                                          }
                                        : {
                                            requestId: request.id,
                                            answer: value,
                                          },
                                    )
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <RemoteDelegationDialog
        target={remoteTarget}
        onOpenChange={(open) => {
          if (!open) setRemoteTarget(null);
        }}
      />
    </section>
  );
}
