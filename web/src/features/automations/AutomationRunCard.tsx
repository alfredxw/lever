import {
  ArrowUpRight,
  BellOff,
  Check,
  SquareKanban,
  X,
  Zap,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  Automation,
  AutomationRun,
  Request,
  TaskExecution,
  TaskWorkflow,
  WorkItem,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { AutomationRunOutput, type OpenAutomationDispatch } from "./AutomationRunOutput";
import { AutomationRunControls } from "./AutomationRunControls";
import {
  cleanSummaryText,
  deliveryModeOf,
  formatCompactTime,
  formatRunDuration,
  isSilentOutcome,
  notifyPolicyOf,
} from "./automationsQuery";

export function AutomationRunStatusPill({
  status,
  silent,
}: {
  status: string;
  silent?: boolean;
}) {
  const { t } = useTranslation();
  const tone =
    status === "failed"
      ? "danger"
      : status === "waiting_user"
        ? "attention"
        : status === "queued" || active(status)
          ? "running"
          : silent || status === "skipped"
            ? "muted"
            : status === "completed"
              ? "positive"
              : "muted";
  const label =
    silent && status === "completed"
      ? t("automations.silentCompleted")
      : status === "skipped"
        ? t("automations.skipped")
        : t("status." + status, { defaultValue: status });
  return (
    <span className="automation-pill" data-tone={tone}>
      <span className="automation-dot" data-tone={tone} aria-hidden="true" />
      {label}
    </span>
  );
}

export function LinkedWorkItemsList({
  items,
  workflows,
  executions,
  onDispatch,
}: {
  items: WorkItem[];
  workflows: ReadonlyMap<string, TaskWorkflow>;
  executions: ReadonlyMap<string, TaskExecution>;
  onDispatch: OpenAutomationDispatch;
}) {
  const { t } = useTranslation();
  const workflowAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "accept" | "close" }) =>
      api("/tasks/workflows/" + id, { record: "workItem", action }, "PATCH"),
    onSuccess: (_result, { action }) => {
      void queryClient.invalidateQueries({ queryKey: ["task-workflows"] });
      void queryClient.invalidateQueries({ queryKey: ["work-items"] });
      toast.success(
        t(
          action === "accept"
            ? "automations.workItemAccepted"
            : "automations.workItemDismissed",
        ),
      );
    },
    onError: (error) => toast.error(error.message),
  });
  if (!items.length) return null;
  const pendingCount = items.filter((item) => {
    if (item.done) return false;
    const wf = workflows.get(item.id);
    const ex = executions.get(item.id);
    return !wf?.accepted && !wf?.closed && !wf?.queue && !ex;
  }).length;

  return (
    <div
      className="automation-artifact-box"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="automation-artifact-head">
        <span className="inline-flex items-center gap-1.5">
          <SquareKanban className="size-3.5" aria-hidden="true" />
          {t("automations.linkedWorkItems", { count: items.length })}
        </span>
        <span
          className="automation-artifact-count tabular-nums"
          data-pending={pendingCount > 0 || undefined}
        >
          {pendingCount
            ? t("automations.pendingItems", { count: pendingCount })
            : t("automations.itemsProcessed")}
        </span>
      </div>
      {items.map((item) => {
        const wf = workflows.get(item.id);
        const ex = executions.get(item.id);
        const isDone = item.done;
        const isClosed = !!wf?.closed;
        const isDispatched = !!wf?.queue || (!!ex && wf?.disposition !== "todo");
        const isAccepted = !!wf?.accepted;
        const isPending = !isDone && !isClosed && !isDispatched && !isAccepted;
        return (
          <div
            key={item.id}
            className="automation-wi-row"
            data-resolved={isClosed || isDone || undefined}
          >
            <div className="min-w-0 flex-1">
              <div className="automation-wi-title">{item.title}</div>
              {item.body && (
                <div className="automation-wi-desc line-clamp-2">
                  {item.body}
                </div>
              )}
            </div>
            <div className="automation-wi-actions">
              {isPending ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    className="automation-btn-positive"
                    disabled={workflowAction.isPending}
                    onClick={() =>
                      workflowAction.mutate({ id: item.id, action: "accept" })
                    }
                  >
                    <Check data-icon="inline-start" />
                    {t("automations.acceptWorkItem")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={(event) =>
                      onDispatch({
                        id: item.id,
                        record: "workItem",
                        title: item.title,
                        agentId: item.assigneeAgentId,
                      }, event.currentTarget)
                    }
                  >
                    {t("automations.dispatchWorkItem")}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("automations.dismissWorkItem")}
                    title={t("automations.dismissWorkItem")}
                    disabled={workflowAction.isPending}
                    onClick={() =>
                      workflowAction.mutate({ id: item.id, action: "close" })
                    }
                  >
                    <X />
                  </Button>
                </>
              ) : isClosed ? (
                <span className="automation-pill" data-tone="muted">
                  {t("tasks.status.closed")}
                </span>
              ) : isDone ? (
                <span className="automation-pill" data-tone="positive">
                  {t("automations.workItemDone")}
                </span>
              ) : isDispatched ? (
                <span className="automation-pill" data-tone="running">
                  {t("automations.workItemDispatched")}
                </span>
              ) : isAccepted ? (
                <span className="automation-pill" data-tone="positive">
                  {t("automations.workItemAccepted")}
                </span>
              ) : (
                <span className="automation-pill" data-tone="muted">
                  {t("automations.workItemDismissed")}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function AutomationRunCard({
  run,
  plan,
  agent,
  selected,
  pendingRequests,
  workItems,
  workflows,
  executions,
  onSelect,
  onEditRule,
  onOpenChat,
  onDispatchWorkItem,
}: {
  run: AutomationRun;
  plan?: Automation;
  agent?: Agent;
  selected: boolean;
  pendingRequests: Request[];
  workItems: WorkItem[];
  workflows: ReadonlyMap<string, TaskWorkflow>;
  executions: ReadonlyMap<string, TaskExecution>;
  onSelect: () => void;
  onEditRule?: () => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onDispatchWorkItem: OpenAutomationDispatch;
}) {
  const { t, i18n } = useTranslation();
  const silent = isSilentOutcome(run, plan);
  const policy = plan ? notifyPolicyOf(plan) : "always";
  const delivery = plan ? deliveryModeOf(plan) : "deliver";
  const isSilentBubble =
    policy === "silent" &&
    (run.status === "failed" ||
      run.status === "waiting_user" ||
      pendingRequests.length > 0);
  const duration = formatRunDuration(run.createdAt, run.finishedAt, t);
  const timestamp = run.plannedAt
    ? new Date(run.plannedAt * 1000).toISOString()
    : run.createdAt;
  const compactTime = formatCompactTime(timestamp, i18n.language);
  const summaryText = cleanSummaryText(run.summary);
  const triggerText =
    run.trigger === "event"
      ? t("automations.eventsReceived", { count: run.eventCount ?? 0 })
      : t(
          run.trigger === "manual"
            ? "automations.manual"
            : "automations.schedule",
        );
  const scopePath = run.scopePath;
  const name = run.name || plan?.name;

  if (silent) {
    return (
      <div
        className="automation-run-card automation-run-card--silent"
        data-selected={selected || undefined}
        onClick={onSelect}
      >
        <div className="automation-run-top">
          <AutomationRunStatusPill status={run.status} silent />
          <button
            type="button"
            className="automation-run-title truncate"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            {name}
          </button>
          {agent && (
            <span className="automation-agent-chip">
              <AgentAvatar agent={agent} size="xs" />
              <span className="truncate">{agent.name}</span>
            </span>
          )}
          <span className="automation-run-silent-summary truncate">
            {summaryText || triggerText}
          </span>
          <time
            className="automation-run-time tabular-nums"
            dateTime={timestamp}
            title={new Date(timestamp).toLocaleString(i18n.language)}
          >
            {compactTime}
            {duration && ` · ${duration}`}
          </time>
          {run.execution && (
            <Button
              size="xs"
              variant="ghost"
              className="automation-silent-open"
              onClick={(event) => {
                event.stopPropagation();
                onOpenChat(run.execution!, plan?.name ?? run.name);
              }}
            >
              <ArrowUpRight data-icon="inline-start" />
              {t(
                run.execution.topic
                  ? "automations.openTopic"
                  : "tasks.openChat",
              )}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="automation-run-card"
      data-selected={selected || undefined}
      onClick={onSelect}
    >
      <div className="automation-run-top">
        <AutomationRunStatusPill status={run.status} />
        <span className="automation-run-title" title={name}>
          {name}
        </span>
        {agent && (
          <span className="automation-pill automation-pill--agent">
            <AgentAvatar agent={agent} size="xs" />
            <span className="truncate">{agent.name}</span>
          </span>
        )}
        <span className="automation-pill" data-tone="muted">
          {t("automations.delivery." + delivery)}
        </span>
        {isSilentBubble && (
          <span className="automation-pill" data-tone="danger">
            <BellOff className="size-3" aria-hidden="true" />
            {t("automations.silentBubble")}
          </span>
        )}
        {pendingRequests.length > 0 && (
          <span className="automation-pill" data-tone="attention">
            {t("automations.pendingApproval")}
          </span>
        )}
        <time
          className="automation-run-time tabular-nums"
          dateTime={timestamp}
          title={new Date(timestamp).toLocaleString(i18n.language)}
        >
          {compactTime}
          {duration && ` · ${duration}`}
        </time>
      </div>

      <div className="automation-run-funnel">
        <Zap className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {triggerText}
          {run.pullRequests?.length
            ? ` → ${run.pullRequests.map((pr) => `PR #${pr.number}`).join(", ")}`
            : ""}
          {run.changeSummary &&
            ` → ${t("diff.fileCount", { count: run.changeSummary.files })}`}
          {workItems.length > 0 &&
            ` → ${t("automations.linkedWorkItems", { count: workItems.length })}`}
        </span>
      </div>

      {run.error && <div className="automation-run-error">{run.error}</div>}

      {summaryText &&
        !(delivery === "audit" && run.summary === run.reportItems?.[0]) && (
          <p className="automation-run-summary">{summaryText}</p>
        )}

      <div
        onClick={(event) => {
          if ((event.target as Element).closest("a,button"))
            event.stopPropagation();
        }}
      >
        <AutomationRunOutput
          run={run}
          linkedItems={workItems}
          report={delivery === "audit"}
          onFix={onDispatchWorkItem}
          onRead={onSelect}
        />
      </div>

      <LinkedWorkItemsList
        items={workItems}
        workflows={workflows}
        executions={executions}
        onDispatch={onDispatchWorkItem}
      />

      <div
        className="automation-run-foot"
        onClick={(event) => event.stopPropagation()}
      >
        {scopePath && (
          <span
            className="automation-run-scope mono truncate"
            title={scopePath}
          >
            <bdi dir="ltr">{scopePath}</bdi>
          </span>
        )}
        {scopePath && <span aria-hidden="true">·</span>}
        <span className="shrink-0 tabular-nums">
          {t("automations.repliesCount", { count: run.replyCount ?? 0 })}
        </span>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
          {run.execution?.runId && <AutomationRunControls id={run.execution.runId} status={run.status} canPause={run.canPause} />}
          {onEditRule && (
            <Button size="xs" variant="ghost" onClick={onEditRule}>
              {t("automations.editRule")}
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={onSelect}>
            {t("automations.detailsAndChat")}
          </Button>
        </div>
      </div>
    </div>
  );
}
