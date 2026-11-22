import { useMemo, useState } from "react";
import { useDraggable, type ClientRect } from "@dnd-kit/core";
import {
  ArrowUpRight,
  Check,
  Clock,
  Folder,
  PauseCircle,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  TaskDeadlineInput,
  TaskReminderSettings,
  TaskView,
} from "@/api/types.gen";
import { ActivityTime } from "@/components/workbench/ActivityTime";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RunStatus } from "@/features/chat/RunStatus";
import { TaskAssignee } from "./TaskAssignee";
import { TaskBoardActions } from "./TaskBoardActions";
import { TaskDeadlineBadge } from "./TaskDeadlineBadge";
import { defaultReminderSettings } from "./taskDeadlines";
import { TaskPriorityIcon } from "./TaskPriorityIcon";
import {
  canHandOffTask,
  compareTasksByDeadline,
  compareTasksByPriority,
  formatWaitDuration,
  needsAttention,
  queueWaitState,
  setTaskDoneState,
  type AgentQueueMetrics,
  type BoardTask,
} from "./taskBoardModel";
import type { TaskStatus } from "./taskDocument";
import { useTaskDispatch, type TaskDispatchTarget } from "./useTaskDispatch";

type Group = TaskView["group"];

export type ActiveListDrag = {
  id: string;
  task: BoardTask;
  rect: ClientRect;
};

const statusGroupOrder = [
  "running",
  "queued",
  "review",
  "unconfirmed",
  "todo",
  "done",
  "closed",
] as const;

function listStatusGroup(status: TaskStatus) {
  return status === "attention" ? "running" : status;
}

export function TaskListView({
  tasks,
  group,
  sort = "deadline",
  agents,
  agentMetrics,
  reminderSettings = defaultReminderSettings,
  selectedTaskId,
  activeDrag,
  nowMs,
  onOpen,
  onAssign,
  onAccept,
  onQuickComplete,
  onChangeDeadline,
}: {
  tasks: BoardTask[];
  group: Group;
  sort?: "deadline" | "priority";
  agents: Agent[];
  agentMetrics: Map<string, AgentQueueMetrics>;
  reminderSettings?: TaskReminderSettings;
  selectedTaskId?: string;
  activeDrag?: ActiveListDrag;
  nowMs: number;
  onOpen: (task: TaskDispatchTarget, trigger: HTMLButtonElement) => void;
  onAssign: (task: TaskDispatchTarget, trigger: HTMLButtonElement) => void;
  onAccept?: (task: BoardTask) => void;
  onQuickComplete?: (task: BoardTask) => void;
  onChangeDeadline?: (task: BoardTask, next: TaskDeadlineInput | null) => void;
}) {
  const { t } = useTranslation();
  const dispatch = useTaskDispatch();
  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [enqueueOpen, setEnqueueOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const visibleIds = useMemo(() => new Set(tasks.map((item) => item.id)), [tasks]);
  const selectedTasks = useMemo(
    () => tasks.filter((item) => selectedIds.has(item.id)),
    [tasks, selectedIds],
  );
  const allChecked =
    tasks.length > 0 && selectedTasks.length === tasks.length;
  const someChecked =
    selectedTasks.length > 0 && selectedTasks.length < tasks.length;

  const dispatchableSelected = selectedTasks.filter(canHandOffTask);
  const queuedSelected = selectedTasks.filter((item) => !!item.queue);
  const completableSelected = selectedTasks.filter(
    (item) => item.status === "todo" || item.status === "review",
  );

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        agent?: Agent;
        statusDot?: string;
        items: BoardTask[];
      }
    >();

    for (const task of tasks) {
      const key =
        group === "status"
          ? listStatusGroup(task.status)
          : group === "agent"
            ? (task.agentId ?? "")
            : task.project;
      let bucket = map.get(key);
      if (!bucket) {
        bucket = {
          key,
          label:
            group === "status"
              ? t("tasks.status." + key)
              : group === "agent"
                ? (task.agent?.name ?? t("tasks.unassigned"))
                : task.project || t("tasks.noProject"),
          agent: group === "agent" ? task.agent : undefined,
          statusDot: group === "status" ? key : undefined,
          items: [],
        };
        map.set(key, bucket);
      }
      bucket.items.push(task);
    }

    const list = [...map.values()];
    if (group === "status") {
      list.sort(
        (a, b) =>
          statusGroupOrder.indexOf(
            a.key as (typeof statusGroupOrder)[number],
          ) -
          statusGroupOrder.indexOf(b.key as (typeof statusGroupOrder)[number]),
      );
    }

    const comparator =
      sort === "priority" ? compareTasksByPriority : compareTasksByDeadline;
    for (const bucket of list) {
      if (group === "status" && bucket.key === "running") {
        bucket.items.sort((a, b) => {
          const attDiff = Number(needsAttention(b)) - Number(needsAttention(a));
          if (attDiff !== 0) return attDiff;
          return comparator(a, b);
        });
      } else if (group === "status" && bucket.key === "queued") {
        bucket.items.sort((a, b) => {
          const agDiff = (a.agent?.name ?? "").localeCompare(
            b.agent?.name ?? "",
          );
          if (agDiff !== 0) return agDiff;
          return (
            (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity)
          );
        });
      } else {
        bucket.items.sort(comparator);
      }
    }
    return list;
  }, [tasks, group, sort, t]);

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((item) => visibleIds.has(item)));
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? new Set(tasks.map((item) => item.id)) : new Set());
  }

  async function batchEnqueueTo(agent: Agent) {
    if (!dispatchableSelected.length || batchBusy) return;
    setEnqueueOpen(false);
    setBatchBusy(true);
    let succeeded = 0;
    try {
      for (const task of dispatchableSelected) {
        try {
          await dispatch(task, { agentId: agent.id });
          succeeded += 1;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }
      if (succeeded > 0) {
        setSelectedIds(new Set());
      }
    } finally {
      setBatchBusy(false);
    }
  }

  async function batchWithdraw() {
    if (!queuedSelected.length || batchBusy) return;
    setBatchBusy(true);
    try {
      for (const task of queuedSelected) {
        if (!task.queue) continue;
        await api(
          "/tasks/workflows/" + task.id,
          {
            record: task.record,
            noteId: task.noteId,
            action: "withdraw",
            queueId: task.queue.id,
          },
          "PATCH",
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["task-workflows"] });
      setSelectedIds(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchBusy(false);
    }
  }

  async function batchComplete() {
    if (!completableSelected.length || batchBusy) return;
    setBatchBusy(true);
    try {
      for (const task of completableSelected) {
        await setTaskDoneState(task, true, t("tasks.sourceRemoved"));
      }
      setSelectedIds(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchBusy(false);
    }
  }

  return (
    <div className="task-list-view">
      <div className="task-list-scroll">
        {grouped.map((bucket, bucketIndex) => {
          const metrics = bucket.agent
            ? agentMetrics.get(bucket.agent.id)
            : undefined;
          return (
            <section
              key={bucket.key}
              className="task-list-group"
              data-group-key={bucket.key}
            >
              <div className="task-list-group-bar">
                {bucketIndex === 0 ? (
                  <Checkbox
                    aria-label={t("tasks.selectAllTasks")}
                    checked={
                      allChecked
                        ? true
                        : someChecked
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                  />
                ) : (
                  <span className="task-list-check-spacer" aria-hidden="true" />
                )}
                <h2 className="task-list-group-head">
                  {bucket.statusDot ? (
                    <span
                      className="task-dot"
                      data-status={bucket.statusDot}
                      aria-hidden="true"
                    />
                  ) : bucket.agent ? (
                    <AgentAvatar agent={bucket.agent} size="sm" />
                  ) : group === "agent" ? (
                    <UserRound
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <Folder
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <span className="truncate">{bucket.label}</span>
                  <span className="task-list-group-count tabular-nums">
                    {bucket.items.length}
                  </span>
                  {metrics && (
                    <span className="task-list-group-slots tabular-nums">
                      {t("tasks.agentDockRunning", {
                        running: metrics.running,
                        concurrency: metrics.concurrency,
                      })}
                      {metrics.paused ? ` · ${t("tasks.queuePaused")}` : ""}
                    </span>
                  )}
                </h2>
              </div>

              <ul className="task-list-rows" role="list">
                {bucket.items.map((task) => (
                  <TaskListRow
                    key={task.id}
                    task={task}
                    group={group}
                    nowMs={nowMs}
                    reminderSettings={reminderSettings}
                    checked={selectedIds.has(task.id)}
                    selected={task.id === selectedTaskId}
                    activeDrag={activeDrag}
                    waitState={queueWaitState(
                      task.queue,
                      task.queue
                        ? agentMetrics.get(task.queue.agentId)
                        : undefined,
                      nowMs,
                    )}
                    onToggleCheck={(value) => toggleOne(task.id, value)}
                    onOpen={onOpen}
                    onAssign={onAssign}
                    onAccept={onAccept}
                    onQuickComplete={onQuickComplete}
                    onChangeDeadline={onChangeDeadline}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {selectedTasks.length > 0 && (
        <div
          className="task-batch-bar"
          role="region"
          aria-label={t("tasks.batchSelected", { count: selectedTasks.length })}
        >
          <span className="task-batch-count tabular-nums">
            {t("tasks.batchSelected", { count: selectedTasks.length })}
          </span>
          <span className="task-batch-divider" aria-hidden="true" />
          <div className="task-batch-actions">
            {dispatchableSelected.length > 0 && activeAgents.length > 0 && (
              <Popover open={enqueueOpen} onOpenChange={setEnqueueOpen}>
                <PopoverTrigger asChild>
                  <Button size="xs" disabled={batchBusy}>
                    <ArrowUpRight data-icon="inline-start" />
                    {t("tasks.batchEnqueue")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="center"
                  side="top"
                  aria-label={t("tasks.batchEnqueue")}
                  className="task-quick-popover w-52 p-1"
                >
                  {activeAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className="task-quick-option"
                      onClick={() => void batchEnqueueTo(agent)}
                    >
                      <AgentAvatar agent={agent} size="sm" />
                      <span className="truncate">{agent.name}</span>
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            )}
            {queuedSelected.length > 0 && (
              <Button
                size="xs"
                variant="outline"
                disabled={batchBusy}
                onClick={() => void batchWithdraw()}
              >
                <Undo2 data-icon="inline-start" />
                {t("tasks.batchWithdraw")}
              </Button>
            )}
            {completableSelected.length > 0 && (
              <Button
                size="xs"
                variant="outline"
                disabled={batchBusy}
                onClick={() => void batchComplete()}
              >
                <Check data-icon="inline-start" />
                {t("tasks.batchComplete")}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={batchBusy}
              aria-label={t("tasks.clearSelection")}
              title={t("tasks.clearSelection")}
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskListRow({
  task,
  group,
  nowMs,
  reminderSettings,
  checked,
  selected,
  activeDrag,
  waitState,
  onToggleCheck,
  onOpen,
  onAssign,
  onAccept,
  onQuickComplete,
  onChangeDeadline,
}: {
  task: BoardTask;
  group: Group;
  nowMs: number;
  reminderSettings: TaskReminderSettings;
  checked: boolean;
  selected: boolean;
  activeDrag?: ActiveListDrag;
  waitState?: ReturnType<typeof queueWaitState>;
  onToggleCheck: (checked: boolean) => void;
  onOpen: (task: TaskDispatchTarget, trigger: HTMLButtonElement) => void;
  onAssign: (task: TaskDispatchTarget, trigger: HTMLButtonElement) => void;
  onAccept?: (task: BoardTask) => void;
  onQuickComplete?: (task: BoardTask) => void;
  onChangeDeadline?: (task: BoardTask, next: TaskDeadlineInput | null) => void;
}) {
  const { t } = useTranslation();
  const dragId = task.queue?.id ?? `card:${task.id}`;
  const draggable =
    task.record !== "automation" &&
    (task.status === "todo" ||
      task.status === "unconfirmed" ||
      task.status === "queued");

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({
    id: dragId,
    disabled: !draggable,
    data: { task },
  });

  const floatingRect =
    isDragging && activeDrag?.id === dragId ? activeDrag.rect : undefined;

  const canAssign = canHandOffTask(task);
  const contextTag =
    (group === "project" ? "" : task.project) || task.noteTitle || "";
  const waitText =
    waitState?.kind === "paused"
      ? t("tasks.waitReason.paused")
      : waitState?.kind === "slots"
        ? t("tasks.waitReason.slots")
        : waitState?.kind === "cooldown"
          ? t("tasks.waitReason.cooldown", {
              time: formatWaitDuration(waitState.remainingMs, t),
            })
          : undefined;

  const chipStatus =
    task.status === "attention" &&
    (task.execution?.status === "failed" ||
      task.execution?.status === "interrupted" ||
      !!task.queue?.error)
      ? "failed"
      : task.status;

  const canEditDeadline =
    !!onChangeDeadline &&
    task.record !== "automation" &&
    task.status !== "done" &&
    task.status !== "closed";

  return (
    <li
      ref={setNodeRef}
      className="task-list-row-slot"
      data-dragging={isDragging || undefined}
      style={floatingRect ? { height: floatingRect.height } : undefined}
    >
      <div
        className="task-list-row"
        data-selected={selected || undefined}
        data-checked={checked || undefined}
        data-dragging={isDragging || undefined}
        data-status={task.status}
        data-overdue={task.deadline?.urgency === "overdue" || undefined}
        style={
          floatingRect
            ? {
                position: "fixed",
                left: floatingRect.left,
                top: floatingRect.top,
                width: floatingRect.width,
                height: floatingRect.height,
                zIndex: 40,
                pointerEvents: "none",
              }
            : undefined
        }
      >
        <Checkbox
          aria-label={t("tasks.selectTask", { title: task.title })}
          checked={checked}
          onCheckedChange={(value) => onToggleCheck(value === true)}
        />
        <button
          ref={draggable ? setActivatorNodeRef : undefined}
          {...(draggable ? attributes : {})}
          {...(draggable ? listeners : {})}
          type="button"
          className="task-list-row-open"
          aria-haspopup="dialog"
          aria-expanded={selected}
          onClick={(event) => onOpen(task, event.currentTarget)}
        >
          <span className="task-list-row-prio">
            <TaskPriorityIcon priority={task.priority} />
          </span>
          <span className="task-list-row-main">
            <span
              className="task-dot"
              data-status={chipStatus}
              aria-hidden="true"
            />
            <span className="task-list-row-title truncate">{task.title}</span>
            {contextTag && (
              <span className="task-list-tag truncate" title={contextTag}>
                {contextTag}
              </span>
            )}
            {task.reference && (
              <span className="task-list-tag task-list-ref shrink-0">
                {task.reference}
              </span>
            )}
          </span>
          <span className="task-list-row-status">
            {task.status === "running" || task.status === "attention" ? (
              task.execution?.status ? (
                <RunStatus status={task.execution.status} />
              ) : (
                <span className="task-status-chip" data-status={chipStatus}>
                  {t("tasks.status." + task.status)}
                </span>
              )
            ) : (
              <span className="task-status-chip" data-status={chipStatus}>
                {t("tasks.status." + task.status)}
                {task.queue?.position ? ` #${task.queue.position}` : ""}
              </span>
            )}
          </span>
          <span className="task-list-row-owner">
            <TaskAssignee agent={task.agent} assigned={!!task.agentId} />
          </span>
          <span className="task-list-row-meta tabular-nums">
            {waitText ? (
              <span
                className="task-list-wait-inline"
                data-reason={waitState?.kind}
                title={waitText}
              >
                {waitState?.kind === "paused" ? (
                  <PauseCircle className="size-3 shrink-0" aria-hidden="true" />
                ) : (
                  <Clock className="size-3 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">{waitText}</span>
              </span>
            ) : (
              <ActivityTime
                timestamp={task.execution?.activityAt ?? task.updatedAt}
                compact
              />
            )}
          </span>
        </button>
        <div className="task-list-row-due">
          {task.deadline && (
            <TaskDeadlineBadge
              deadline={task.deadline}
              nowMs={nowMs}
              defaultRemindOffsets={reminderSettings.defaultRemindOffsets}
              allDayReminderTime={reminderSettings.allDayReminderTime}
              editable={canEditDeadline}
              compact
              onChange={(next) => onChangeDeadline?.(task, next)}
            />
          )}
        </div>
        <div className="task-list-row-actions">
          {task.status === "unconfirmed" && onAccept && (
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="task-row-inline-btn"
              aria-label={t("tasks.acceptTask")}
              title={t("tasks.acceptTask")}
              onClick={() => onAccept(task)}
            >
              <Check className="size-3.5" />
            </Button>
          )}
          {canAssign && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="task-row-inline-btn"
              aria-label={t("tasks.assign")}
              title={t("tasks.assign")}
              aria-haspopup="dialog"
              onClick={(event) => onAssign(task, event.currentTarget)}
            >
              <ArrowUpRight data-icon="inline-start" />
              <span>{t("tasks.enqueue")}</span>
            </Button>
          )}
          {task.status === "review" && onQuickComplete && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="task-row-inline-btn task-btn-positive"
              aria-label={t("tasks.complete")}
              title={t("tasks.complete")}
              onClick={() => onQuickComplete(task)}
            >
              <Check data-icon="inline-start" />
              <span>{t("tasks.complete")}</span>
            </Button>
          )}
          <TaskBoardActions task={task} status={task.status} />
        </div>
      </div>
    </li>
  );
}
