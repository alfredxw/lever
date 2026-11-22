import { useMemo, useState } from "react";
import { CircleCheck, Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  Agent,
  Request,
  TaskDeadline,
  TaskExecution,
  TaskReminderSettings,
  TaskWorkflow,
  WorkItem,
} from "@/api/types.gen";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { BoardTaskDetail } from "./BoardTaskDetail";
import { TaskDeadlineBadge } from "./TaskDeadlineBadge";
import { defaultReminderSettings, formatDeadlineLabel } from "./taskDeadlines";
import {
  sortInboxTasks,
  taskInboxReason,
  type AgentQueueMetrics,
  type BoardTask,
  type InboxReason,
} from "./taskBoardModel";

export function TaskInbox({
  tasks,
  agents,
  executions,
  workflows,
  requests,
  requestRunIds,
  agentMetrics,
  deadlinesById,
  reminderSettings = defaultReminderSettings,
  nowMs = Date.now(),
  search,
  onLocate,
  onOpenChat,
  onOpenAutomation,
  onOpenRun,
  onOpenOrigin,
}: {
  tasks: BoardTask[];
  agents: Agent[];
  executions: Map<string, TaskExecution>;
  workflows: Map<string, TaskWorkflow>;
  requests: Request[];
  requestRunIds: ReadonlySet<string>;
  agentMetrics: Map<string, AgentQueueMetrics>;
  deadlinesById?: Map<string, TaskDeadline>;
  reminderSettings?: TaskReminderSettings;
  nowMs?: number;
  search: string;
  onLocate: (noteId: string, taskId: string) => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenAutomation: (id: string) => void;
  onOpenRun: OpenRun;
  onOpenOrigin: (item: WorkItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const [reasonFilter, setReasonFilter] = useState<InboxReason | "all">("all");
  const [selectedId, setSelectedId] = useState<string>();

  const requestByRunId = useMemo(() => {
    const map = new Map<string, Request>();
    for (const req of requests) {
      if (req.status === "pending" && req.runId && !map.has(req.runId)) {
        map.set(req.runId, req);
      }
    }
    return map;
  }, [requests]);

  const allInbox = useMemo(
    () => sortInboxTasks(tasks, requestRunIds),
    [tasks, requestRunIds],
  );

  const term = search.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      allInbox.filter((task) => {
        const reason = taskInboxReason(task, requestRunIds);
        if (reasonFilter !== "all" && reason !== reasonFilter) return false;
        if (!term) return true;
        return [task.title, task.project, task.agent?.name, task.noteTitle].some(
          (value) => value?.toLocaleLowerCase().includes(term),
        );
      }),
    [allInbox, requestRunIds, reasonFilter, term],
  );

  const reasonCounts = useMemo(() => {
    const counts: Record<InboxReason, number> = {
      request: 0,
      attention: 0,
      deadline: 0,
      review: 0,
      unconfirmed: 0,
    };
    for (const task of allInbox) {
      const reason = taskInboxReason(task, requestRunIds);
      if (reason) counts[reason] += 1;
    }
    return counts;
  }, [allInbox, requestRunIds]);

  const activeCategories = (
    ["request", "attention", "deadline", "review", "unconfirmed"] as const
  ).filter((key) => reasonCounts[key] > 0);

  const selectedIndex = useMemo(() => {
    if (!filtered.length) return -1;
    const index = filtered.findIndex((item) => item.id === selectedId);
    return index >= 0 ? index : 0;
  }, [filtered, selectedId]);

  // Keep a task pinned in the detail pane while an in-place follow-up/retry runs.
  const pinnedRunning = useMemo(
    () =>
      selectedId && !filtered.some((item) => item.id === selectedId)
        ? tasks.find(
            (item) => item.id === selectedId && item.status === "running",
          )
        : undefined,
    [selectedId, filtered, tasks],
  );

  const activeTask =
    pinnedRunning ?? (selectedIndex >= 0 ? filtered[selectedIndex] : undefined);

  function rowPreview(task: BoardTask, reason: InboxReason) {
    if (reason === "request" && task.execution?.runId) {
      const req = requestByRunId.get(task.execution.runId);
      if (req?.detail) return req.detail;
      if (req?.title) return req.title;
    }
    if (reason === "deadline" && task.deadline) {
      return formatDeadlineLabel(task.deadline, nowMs, t, i18n.language);
    }
    if (task.queue?.error) return task.queue.error;
    if (task.body) return task.body.split("\n")[0];
    if (task.agent?.name) return task.agent.name;
    return task.noteTitle ?? "";
  }

  return (
    <section className="task-inbox-page" aria-label={t("tasks.focus.inbox")}>
      <header className="task-inbox-topbar">
        <div className="task-inbox-heading">
          <Inbox
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <h1>{t("tasks.focus.inbox")}</h1>
          <span className="task-board-total">
            {t("tasks.inboxPendingCount", { count: allInbox.length })}
          </span>
        </div>
        <div className="task-inbox-topbar-right">
          {activeCategories.length > 1 ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              className="task-segmented-toggle"
              aria-label={t("tasks.filter")}
              value={reasonFilter}
              onValueChange={(value) => {
                if (value) setReasonFilter(value as InboxReason | "all");
              }}
            >
              <ToggleGroupItem value="all">
                {t("tasks.allView")}
              </ToggleGroupItem>
              {activeCategories.map((reason) => (
                <ToggleGroupItem key={reason} value={reason}>
                  {t("tasks.inboxReason." + reason)}
                  <span className="ml-1 text-[11px] opacity-70 tabular-nums">
                    {reasonCounts[reason]}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <span className="task-inbox-subtitle">
              {t("tasks.inboxSubtitle")}
            </span>
          )}
        </div>
      </header>

      <div className="task-inbox">
        <div className="task-inbox-list-pane">
          {filtered.length === 0 ? (
            <div className="task-inbox-empty">
              <Empty>
                <EmptyMedia variant="icon">
                  <CircleCheck />
                </EmptyMedia>
                <EmptyTitle>
                  {t(term ? "tasks.noMatches" : "tasks.inboxEmpty")}
                </EmptyTitle>
                {!term && (
                  <EmptyDescription>
                    {t("tasks.inboxEmptyDescription")}
                  </EmptyDescription>
                )}
              </Empty>
            </div>
          ) : (
            <ul className="task-inbox-items" role="list">
              {filtered.map((task) => {
                const reason = taskInboxReason(task, requestRunIds) ?? "review";
                const isCurrent = task.id === activeTask?.id;
                const preview = rowPreview(task, reason);
                const chipStatus =
                  reason === "attention" ||
                  (reason === "deadline" && task.deadline?.urgency === "overdue")
                    ? "failed"
                    : reason === "request" ||
                        reason === "review" ||
                        reason === "deadline"
                      ? "attention"
                      : "todo";
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="task-inbox-item"
                      aria-current={isCurrent ? "true" : undefined}
                      data-reason={reason}
                      onClick={() => setSelectedId(task.id)}
                    >
                      <div className="task-inbox-item-top">
                        <span className="task-inbox-item-meta">
                          <span
                            className="task-status-chip"
                            data-status={chipStatus}
                          >
                            {reason === "deadline" &&
                            task.deadline?.urgency === "overdue"
                              ? t("tasks.inboxReason.overdue")
                              : t("tasks.inboxReason." + reason)}
                          </span>
                          {task.deadline && reason !== "deadline" && (
                            <TaskDeadlineBadge
                              deadline={task.deadline}
                              nowMs={nowMs}
                              compact
                            />
                          )}
                          {(task.project || task.reference) && (
                            <span className="truncate text-muted-foreground">
                              {task.project}
                              {task.reference ? ` ${task.reference}` : ""}
                            </span>
                          )}
                        </span>
                        {task.agent ? (
                          <AgentAvatar agent={task.agent} size="sm" />
                        ) : (
                          <span
                            className="task-avatar-empty"
                            aria-hidden="true"
                          >
                            ?
                          </span>
                        )}
                      </div>
                      <div className="task-inbox-item-title line-clamp-2">
                        {task.title}
                      </div>
                      {preview && (
                        <div className="task-inbox-item-preview truncate">
                          {preview}
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="task-inbox-detail-pane">
          {activeTask ? (
            <BoardTaskDetail
              key={activeTask.id}
              embedded
              target={activeTask}
              agents={agents}
              execution={executions.get(activeTask.id)}
              workflow={workflows.get(activeTask.id)}
              requests={requests}
              agentMetrics={agentMetrics}
              localDeadline={deadlinesById?.get(activeTask.id)}
              reminderSettings={reminderSettings}
              onPrev={
                selectedIndex > 0
                  ? () => setSelectedId(filtered[selectedIndex - 1].id)
                  : undefined
              }
              onNext={
                selectedIndex < filtered.length - 1
                  ? () => setSelectedId(filtered[selectedIndex + 1].id)
                  : undefined
              }
              onLocate={onLocate}
              onOpenChat={onOpenChat}
              onOpenAutomation={onOpenAutomation}
              onOpenRun={onOpenRun}
              onOpenOrigin={onOpenOrigin}
            />
          ) : (
            <div className="task-inbox-empty">
              <Empty>
                <EmptyMedia variant="icon">
                  <CircleCheck />
                </EmptyMedia>
                <EmptyTitle>{t("tasks.inboxEmpty")}</EmptyTitle>
              </Empty>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
