import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  MessageCircle,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { active, api } from "@/api/client";
import type {
  SessionRuns,
  TaskExecution,
  TaskQueueEntry,
} from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { RunStatus } from "@/features/chat/RunStatus";
import type { TaskStatus } from "./taskDocument";
import type { Agent } from "@/api/types.gen";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { TaskDelegations } from "./TaskActivity";

export function TaskDetail({
  task,
  agents,
  execution,
  queue,
  workflowError,
  onLocate,
  onClose,
  onComplete,
  onReopen,
  onOpenChat,
  onOpenRun,
  onWithdraw,
}: {
  task: { title: string; status: TaskStatus; owner?: string };
  agents: Agent[];
  execution?: TaskExecution;
  queue?: TaskQueueEntry;
  workflowError?: unknown;
  onLocate?: () => void;
  onClose?: () => void;
  onComplete?: () => void;
  onReopen?: () => void;
  onOpenChat: () => void;
  onOpenRun: OpenRun;
  onWithdraw?: () => void;
}) {
  const { t } = useTranslation();
  const result = useQuery({
    queryKey: [
      "task-result",
      execution?.sessionId,
      execution?.runId,
      execution?.status,
    ],
    queryFn: ({ signal }) =>
      api<SessionRuns>(
        "/sessions/" + execution!.sessionId + "/runs",
        undefined,
        "GET",
        signal,
      ),
    enabled:
      !!execution?.runId &&
      execution.status !== "queued" &&
      !active(execution.status),
  });
  const run = result.data?.runs.find((item) => item.id === execution?.runId);
  const output = run?.items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join("\n\n");
  return (
    <aside className="task-detail" aria-label={t("tasks.detail")}>
      {onClose && (
        <header className="flex items-center justify-between gap-2">
          {onLocate && (
            <Button variant="ghost" size="sm" onClick={onLocate}>
              <ArrowLeft data-icon="inline-start" />
              {t("tasks.locate")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t("tasks.closeDetail")}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
      )}
      <div className="task-detail-content">
        <h2>{task.title || t("tasks.untitled")}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="task-detail-status" data-status={task.status}>
            {t("tasks.status." + task.status)}
          </span>
          {task.owner && <span>{task.owner}</span>}
          {execution?.status && task.status === "attention" && (
            <RunStatus status={execution.status} />
          )}
        </div>
        <TaskQueueInfo queue={queue} />
        {!!workflowError && <ErrorNotice error={workflowError} />}
        {execution && (
          <section className="task-result">
            <h3>{t("tasks.result")}</h3>
            {result.isFetching && !run ? (
              <Loading />
            ) : result.error ? (
              <ErrorNotice
                error={result.error}
                retry={() => void result.refetch()}
              />
            ) : (
              <>
                {run?.error && <ErrorNotice error={run.error} />}
                {output ? (
                  <MessageResponse text={output} />
                ) : (
                  !run?.error && (
                    <p className="text-sm text-muted-foreground">
                      {t(
                        execution.status === "queued"
                          ? "status.queued"
                          : task.status === "running"
                            ? "tasks.inProgress"
                            : task.status === "attention"
                              ? "tasks.chatNeedsAttention"
                              : "tasks.noResult",
                      )}
                    </p>
                  )
                )}
              </>
            )}
            <TaskDelegations
              execution={execution}
              agents={agents}
              onOpenRun={onOpenRun}
            />
          </section>
        )}
        <TaskDetailActions
          task={task}
          onOpenChat={execution ? onOpenChat : undefined}
          openChatLabel={
            execution?.topic ? t("automations.openTopic") : undefined
          }
          onComplete={onComplete}
          onReopen={onReopen}
          onWithdraw={onWithdraw}
        />
      </div>
    </aside>
  );
}

export function TaskQueueInfo({
  queue,
  waitLabel,
}: {
  queue?: TaskQueueEntry;
  waitLabel?: string;
}) {
  const { t } = useTranslation();
  if (queue?.error) return <ErrorNotice error={queue.error} />;
  if (!queue?.position) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {t("tasks.queuePosition", { count: queue.position })}
      {waitLabel ? ` · ${waitLabel}` : ""}
    </p>
  );
}

export function TaskDetailActions({
  task,
  onOpenChat,
  openChatLabel,
  onAssign,
  onComplete,
  onReopen,
  onAccept,
  onAcceptAndEnqueue,
  onWithdraw,
}: {
  task: { title: string; status: TaskStatus };
  onOpenChat?: () => void;
  openChatLabel?: string;
  onAssign?: () => void;
  onComplete?: () => void;
  onReopen?: () => void;
  onAccept?: () => void;
  onAcceptAndEnqueue?: () => void;
  onWithdraw?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="task-detail-actions flex flex-wrap justify-end gap-2">
      {onWithdraw && (
        <Button size="sm" variant="outline" onClick={onWithdraw}>
          <Undo2 data-icon="inline-start" />
          {t("tasks.withdraw")}
        </Button>
      )}
      {onOpenChat && (
        <Button size="sm" variant="outline" onClick={onOpenChat}>
          <MessageCircle data-icon="inline-start" />
          {openChatLabel ?? t("tasks.openChat")}
        </Button>
      )}
      {onAssign && (
        <Button size="sm" variant="outline" onClick={onAssign}>
          <ArrowUpRight data-icon="inline-start" />
          {t("tasks.assign")}
        </Button>
      )}
      {onComplete &&
        (task.status === "review" ||
          task.status === "todo" ||
          task.status === "unconfirmed") && (
          <Button
            size="sm"
            variant={onAccept ? "outline" : "default"}
            disabled={!task.title}
            onClick={onComplete}
          >
            <Check data-icon="inline-start" />
            {t("tasks.complete")}
          </Button>
        )}
      {onAccept && (
        <Button
          size="sm"
          variant={onAcceptAndEnqueue ? "outline" : "default"}
          onClick={onAccept}
        >
          <Check data-icon="inline-start" />
          {t("tasks.acceptTask")}
        </Button>
      )}
      {onAcceptAndEnqueue && (
        <Button size="sm" onClick={onAcceptAndEnqueue}>
          <ArrowUpRight data-icon="inline-start" />
          {t("tasks.acceptAndEnqueue")}
        </Button>
      )}
      {onReopen && (task.status === "done" || task.status === "closed") && (
        <Button size="sm" variant="outline" onClick={onReopen}>
          <RotateCcw data-icon="inline-start" />
          {t("tasks.reopen")}
        </Button>
      )}
    </div>
  );
}
