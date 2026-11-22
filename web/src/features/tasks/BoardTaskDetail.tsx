import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BellOff,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Flag,
  Folder,
  GitPullRequest,
  ListTodo,
  NotebookPen,
  RotateCcw,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  ExternalTask,
  Request,
  TaskDeadline,
  TaskDeadlineInput,
  TaskExecution,
  TaskReminderSettings,
  TaskWorkflow,
  WorkItem,
  WorkItemPriority,
  WorkItemUpdate,
} from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { RequestCard } from "@/features/chat/RequestCard";
import { TaskActivity } from "./TaskActivity";
import { TaskBoardActions } from "./TaskBoardActions";
import { TaskAssignee } from "./TaskAssignee";
import {
  defaultReminderSettings,
  formatDeadlineFull,
  formatDeadlineLabel,
  formatLocalDateISO,
  formatReminderOffset,
  localEndOfDayMs,
  resolveTaskDeadline,
  useClearTaskDeadline,
  useSaveTaskDeadline,
  useSnoozeTaskDeadline,
} from "./taskDeadlines";
import { TaskDeadlinePicker } from "./TaskDeadlinePicker";
import { TaskDetailActions, TaskQueueInfo } from "./TaskDetail";
import { TaskDispatchPanel } from "./TaskDispatchPanel";
import { TaskPriorityIcon, workItemPriorities } from "./TaskPriorityIcon";
import {
  canHandOffTask,
  formatWaitDuration,
  queueWaitState,
  setTaskDoneState,
  type AgentQueueMetrics,
} from "./taskBoardModel";
import {
  taskBlocks,
  taskImages,
  taskNoteSchema,
  taskStatus,
} from "./taskDocument";
import { useTaskWorkflowUpdate } from "./taskWorkflow";
import { useTaskDispatch, type TaskTarget } from "./useTaskDispatch";
import { taskNoteQuery } from "./noteQueries";
import {
  noteDraftDocument,
  TaskNoteConflict,
  useTaskDrafts,
} from "./useTaskNote";

export function BoardTaskDetail({
  target,
  agents,
  execution,
  workflow,
  requests,
  agentMetrics,
  localDeadline,
  reminderSettings = defaultReminderSettings,
  embedded = false,
  onClose,
  onPrev,
  onNext,
  onLocate,
  onOpenChat,
  onOpenAutomation,
  onOpenRun,
  onOpenOrigin,
}: {
  target: TaskTarget;
  agents: Agent[];
  execution?: TaskExecution;
  workflow?: TaskWorkflow;
  requests?: Request[];
  agentMetrics?: Map<string, AgentQueueMetrics>;
  localDeadline?: TaskDeadline;
  reminderSettings?: TaskReminderSettings;
  embedded?: boolean;
  onClose?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onLocate: (noteId: string, taskId: string) => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenAutomation: (id: string) => void;
  onOpenRun: OpenRun;
  onOpenOrigin: (item: WorkItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const { id, noteId, record } = target;
  const automationId =
    record === "automation" ? execution?.automationId : undefined;
  const closeButton = useRef<HTMLButtonElement>(null);
  const [assigning, setAssigning] = useState(false);
  const [followup, setFollowup] = useState("");
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const dispatch = useTaskDispatch();
  const activeAgents = useMemo(
    () => agents.filter((item) => !item.archived),
    [agents],
  );
  const automation =
    record === "automation" && execution
      ? { title: execution.title ?? "", done: execution.done }
      : undefined;
  const noteQuery = useQuery({
    ...taskNoteQuery(noteId ?? ""),
    enabled: record === "note" && !!noteId,
  });
  const externalQuery = useQuery({
    queryKey: ["external-tasks", id],
    queryFn: ({ signal }) =>
      api<ExternalTask>("/tasks/external/" + id, undefined, "GET", signal),
    enabled: record === "external",
  });
  const workItemQuery = useQuery({
    queryKey: ["work-items", id],
    queryFn: ({ signal }) =>
      api<WorkItem>("/tasks/work-items/" + id, undefined, "GET", signal),
    enabled: record === "workItem",
  });
  const drafts = useTaskDrafts();
  const draft = record === "note" && noteId ? drafts.get(noteId) : undefined;
  const note = record === "note" ? (draft?.note ?? noteQuery.data) : undefined;
  const written = useMemo(() => {
    if (!note) return;
    const doc = draft
      ? noteDraftDocument(draft)
      : taskNoteSchema.nodeFromJSON(note.content);
    return taskBlocks(doc).find((block) => block.id === id);
  }, [draft, note, id]);
  const external = record === "external" ? externalQuery.data : undefined;
  const workItem = record === "workItem" ? workItemQuery.data : undefined;
  const images = written && taskImages(written);
  const query = {
    note: noteQuery,
    external: externalQuery,
    workItem: workItemQuery,
    automation: undefined,
  }[record];
  const task = written ?? external ?? workItem ?? automation;
  const queue = !execution ? workflow?.queue : undefined;
  const status =
    task &&
    taskStatus(task, execution, workflow, !!workItem?.createdByAgentId);
  const agentId =
    execution?.agentId ??
    queue?.agentId ??
    written?.agentId ??
    workItem?.assigneeAgentId;
  const agent = agents.find(({ id }) => id === agentId);
  const project =
    written?.issue?.repository || note?.project || workItem?.project || "";
  const canAssign = !!status && canHandOffTask({ record, status, execution });
  const canEditWorkItem =
    record === "workItem" && !!workItem && !execution && !queue;
  const canHaveDeadline = record !== "automation";
  const canEditDeadline =
    canHaveDeadline && status !== "done" && status !== "closed";
  const effectiveDeadline = useMemo(
    () =>
      canHaveDeadline
        ? resolveTaskDeadline({
            local: localDeadline,
            externalDueAt: external?.dueAt,
            externalDueDate: external?.dueDate,
            done: status === "done",
            closed: status === "closed",
            settings: reminderSettings,
            nowMs: Date.now(),
          })
        : undefined,
    [
      canHaveDeadline,
      localDeadline,
      external?.dueAt,
      external?.dueDate,
      status,
      reminderSettings,
    ],
  );
  const saveDeadline = useSaveTaskDeadline();
  const clearDeadline = useClearTaskDeadline();
  const snoozeDeadline = useSnoozeTaskDeadline();

  function handleDeadlineChange(next: TaskDeadlineInput | null) {
    if (next === null) {
      clearDeadline.mutate(id, {
        onError: (err) => toast.error(err.message),
      });
    } else {
      saveDeadline.mutate(
        { taskId: id, input: next },
        { onError: (err) => toast.error(err.message) },
      );
    }
  }

  function postponeToTomorrow() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const keepReminders = effectiveDeadline?.remindOffsets;
    handleDeadlineChange({
      dueAt: localEndOfDayMs(tomorrow),
      dueDate: formatLocalDateISO(tomorrow),
      remindOffsets: keepReminders ?? reminderSettings.defaultRemindOffsets,
    });
  }
  const SourceIcon = external?.kind === "pr" ? GitPullRequest : CircleDot;
  const source = external
    ? t("tasks.source." + external.source, { defaultValue: external.source })
    : "";
  const sourceLabel = t("tasks.openSource", { source });

  const pendingRequests = useMemo(() => {
    if (!execution?.runId || !requests?.length) return [];
    return requests.filter(
      (req) => req.status === "pending" && req.runId === execution.runId,
    );
  }, [requests, execution?.runId]);

  const waitState = queueWaitState(
    queue,
    queue ? agentMetrics?.get(queue.agentId) : undefined,
    Date.now(),
  );
  const waitLabel =
    waitState?.kind === "paused"
      ? t("tasks.waitReason.paused")
      : waitState?.kind === "slots"
        ? t("tasks.waitReason.slots")
        : waitState?.kind === "cooldown"
          ? t("tasks.waitReason.cooldown", {
              time: formatWaitDuration(waitState.remainingMs, t),
            })
          : undefined;

  useEffect(() => {
    if (!onPrev && !onNext) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      const el = event.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (event.key === "j" && onNext) {
        event.preventDefault();
        onNext();
      } else if (event.key === "k" && onPrev) {
        event.preventDefault();
        onPrev();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onPrev, onNext]);

  const update = useMutation({
    mutationFn: (done: boolean) =>
      setTaskDoneState(target, done, t("tasks.sourceRemoved")),
  });

  const patchWorkItem = useMutation({
    mutationFn: (patch: WorkItemUpdate) =>
      api<WorkItem>("/tasks/work-items/" + id, patch, "PATCH"),
    onError: (err) => toast.error(err.message),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["work-items"] });
    },
  });

  const sendFollowup = useMutation({
    mutationFn: async (text: string) => {
      if (!execution) return;
      await api("/messages", {
        commandId: crypto.randomUUID(),
        chatId: execution.chatId,
        sessionId: execution.topic ? execution.sessionId : undefined,
        text,
        operation: execution.topic ? "reply" : "main",
        delivery:
          active(execution.status) || execution.status === "queued"
            ? "queue"
            : undefined,
      });
    },
    onSuccess: () => {
      setFollowup("");
      toast.success(t("tasks.followupSent"));
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      if (execution?.sessionId) {
        void queryClient.invalidateQueries({
          queryKey: ["session", execution.sessionId],
        });
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const retryRun = useMutation({
    mutationFn: async () => {
      if (!execution?.runId) return;
      await api(`/runs/${execution.runId}/retry`, {
        commandId: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      toast.success(t("tasks.retriedRun"));
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (execution?.sessionId) {
        void queryClient.invalidateQueries({
          queryKey: ["session", execution.sessionId],
        });
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const workflowUpdate = useTaskWorkflowUpdate(target, queue?.id);
  const error =
    workflowUpdate.error ?? update.error ?? draft?.error ?? query?.error;
  const conflict = error instanceof TaskNoteConflict;
  const actionsDisabled =
    update.isPending ||
    workflowUpdate.isPending ||
    assigning ||
    conflict ||
    !!draft?.error;
  const retry =
    update.isError && !conflict
      ? () => update.mutate(update.variables!)
      : query?.error && !conflict && !draft?.error
        ? () => void query.refetch()
        : undefined;

  const assignedExecution = !workflow?.closed && workflow?.disposition !== "todo" && !execution?.automationId;
  const canRetryExecution =
    !!execution &&
    assignedExecution &&
    (execution.status === "failed" || execution.status === "interrupted");
  const canFollowup =
    !!execution &&
    assignedExecution &&
    !execution.done &&
    pendingRequests.length === 0;

  async function acceptAndEnqueue() {
    if (!workItem) return;
    const directAgent =
      activeAgents.find((a) => a.id === workItem.assigneeAgentId) ??
      (activeAgents.length === 1 ? activeAgents[0] : undefined);
    if (!directAgent) {
      setAssigning(true);
      return;
    }
    try {
      await dispatch({ id, record: "workItem" }, { agentId: directAgent.id });
      toast.success(t("tasks.enqueuedTo", { name: directAgent.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const inner = (
    <>
      {!embedded && !task && (
        <DialogTitle className="sr-only">{t("tasks.detail")}</DialogTitle>
      )}
      <header className="task-board-detail-header">
        {noteId && note && (
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 shrink justify-start"
            title={t("tasks.locate")}
            aria-label={t("tasks.locate")}
            onClick={() => onLocate(noteId, id)}
          >
            <NotebookPen data-icon="inline-start" />
            <span className="truncate">
              {note.title.trim() || t("tasks.note")}
            </span>
          </Button>
        )}
        {external && (
          <span className="task-board-card-context">
            {external.project && (
              <>
                <Folder className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate" title={external.project}>
                  {external.project}
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
              </>
            )}
            <span className="task-board-detail-reference">
              <SourceIcon className="size-3.5 shrink-0" aria-hidden="true" />
              {external.reference}
            </span>
          </span>
        )}
        {automationId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenAutomation(automationId)}
          >
            <Zap data-icon="inline-start" />
            {t("automations.openPlan")}
          </Button>
        )}
        {workItem && (
          <span className="task-board-card-context">
            {workItem.createdByAgentId ? (
              <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <ListTodo className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {t(
              workItem.createdByAgentId
                ? "tasks.source.agent"
                : "tasks.source.workItem",
            )}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {task && status && (
            <TaskBoardActions
              task={{ ...target, title: task.title }}
              status={status}
              disabled={actionsDisabled}
              onDeleted={onClose}
            />
          )}
          {(onPrev || onNext) && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!onPrev}
                aria-label={t("tasks.prevTask")}
                title={t("tasks.prevTask")}
                onClick={onPrev}
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!onNext}
                aria-label={t("tasks.nextTask")}
                title={t("tasks.nextTask")}
                onClick={onNext}
              >
                <ChevronDown />
              </Button>
            </>
          )}
          {workItem?.origin && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.openOrigin")}
              title={t("tasks.openOrigin")}
              onClick={() => onOpenOrigin(workItem)}
            >
              <ArrowUpRight />
            </Button>
          )}
          {external?.url && (
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={external.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={sourceLabel}
                title={sourceLabel}
              >
                <ArrowUpRight />
              </a>
            </Button>
          )}
          {!embedded && onClose && (
            <Button
              ref={closeButton}
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.closeDetail")}
              onClick={onClose}
            >
              <X />
            </Button>
          )}
        </div>
      </header>
      <div className="task-board-detail-scroll">
        {query?.isPending && !task ? (
          <Loading />
        ) : !task || !status ? (
          <ErrorNotice
            error={query?.error ?? t("tasks.sourceRemoved")}
            retry={query?.error ? () => void query.refetch() : undefined}
          />
        ) : (
          <div className="task-board-detail-content">
            {embedded ? (
              <h2 className="task-board-detail-title">
                {task.title || t("tasks.untitled")}
              </h2>
            ) : (
              <DialogTitle className="task-board-detail-title">
                {task.title || t("tasks.untitled")}
              </DialogTitle>
            )}
            <div className="task-detail-props-grid">
              <div className="task-detail-prop-cell">
                <span className="task-detail-prop-label">
                  {t("tasks.filterStatus")}
                </span>
                <div className="task-detail-prop-value">
                  <span className="task-status-chip" data-status={status}>
                    <span
                      className="task-dot"
                      data-status={status}
                      aria-hidden="true"
                    />
                    {t("tasks.status." + status)}
                  </span>
                </div>
              </div>

              <div className="task-detail-prop-cell">
                <span className="task-detail-prop-label">
                  {t("tasks.assignee")}
                </span>
                <div className="task-detail-prop-value">
                  {canEditWorkItem ? (
                    <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="task-detail-prop-trigger"
                          aria-label={t("tasks.assignee")}
                        >
                          <TaskAssignee agent={agent} assigned={!!agentId} />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="task-quick-popover w-52 p-1"
                      >
                        <button
                          type="button"
                          className="task-quick-option"
                          data-selected={!workItem.assigneeAgentId || undefined}
                          onClick={() => {
                            patchWorkItem.mutate({ assigneeAgentId: "" });
                            setAssigneeOpen(false);
                          }}
                        >
                          <UserRound className="size-3.5 text-muted-foreground" />
                          <span className="truncate">
                            {t("tasks.unassigned")}
                          </span>
                          {!workItem.assigneeAgentId && (
                            <Check className="ml-auto size-3.5" />
                          )}
                        </button>
                        {activeAgents.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="task-quick-option"
                            data-selected={
                              workItem.assigneeAgentId === item.id || undefined
                            }
                            onClick={() => {
                              patchWorkItem.mutate({
                                assigneeAgentId: item.id,
                              });
                              setAssigneeOpen(false);
                            }}
                          >
                            <AgentAvatar agent={item} size="sm" />
                            <span className="truncate">{item.name}</span>
                            {workItem.assigneeAgentId === item.id && (
                              <Check className="ml-auto size-3.5" />
                            )}
                          </button>
                        ))}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <TaskAssignee agent={agent} assigned={!!agentId} />
                  )}
                </div>
              </div>

              {(canEditWorkItem || workItem?.priority) && (
                <div className="task-detail-prop-cell">
                  <span className="task-detail-prop-label">
                    {t("tasks.priority")}
                  </span>
                  <div className="task-detail-prop-value">
                    {canEditWorkItem ? (
                      <Popover
                        open={priorityOpen}
                        onOpenChange={setPriorityOpen}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="task-detail-prop-trigger"
                            aria-label={t("tasks.priority")}
                          >
                            {workItem.priority ? (
                              <TaskPriorityIcon priority={workItem.priority} />
                            ) : (
                              <Flag className="size-3.5 text-muted-foreground" />
                            )}
                            <span>
                              {workItem.priority
                                ? t("tasks.priority." + workItem.priority)
                                : t("tasks.priority.none")}
                            </span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          className="task-quick-popover w-40 p-1"
                        >
                          <button
                            type="button"
                            className="task-quick-option"
                            data-selected={!workItem.priority || undefined}
                            onClick={() => {
                              patchWorkItem.mutate({
                                priority: "" as WorkItemPriority,
                              });
                              setPriorityOpen(false);
                            }}
                          >
                            <span className="size-3.5" />
                            <span>{t("tasks.priority.none")}</span>
                            {!workItem.priority && (
                              <Check className="ml-auto size-3.5" />
                            )}
                          </button>
                          {workItemPriorities.map((value) => (
                            <button
                              key={value}
                              type="button"
                              className="task-quick-option"
                              data-selected={
                                workItem.priority === value || undefined
                              }
                              onClick={() => {
                                patchWorkItem.mutate({ priority: value });
                                setPriorityOpen(false);
                              }}
                            >
                              <TaskPriorityIcon priority={value} />
                              <span>{t("tasks.priority." + value)}</span>
                              {workItem.priority === value && (
                                <Check className="ml-auto size-3.5" />
                              )}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <TaskPriorityIcon priority={workItem?.priority} />
                        <span>{t("tasks.priority." + workItem?.priority)}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {(canEditWorkItem || project) && (
                <div className="task-detail-prop-cell">
                  <span className="task-detail-prop-label">
                    {t("tasks.project")}
                  </span>
                  <div className="task-detail-prop-value">
                    {canEditWorkItem ? (
                      <Popover
                        open={projectOpen}
                        onOpenChange={(open) => {
                          setProjectOpen(open);
                          if (open) setProjectDraft(workItem.project ?? "");
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="task-detail-prop-trigger"
                            aria-label={t("tasks.project")}
                          >
                            <Folder className="size-3.5 text-muted-foreground" />
                            <span className="max-w-36 truncate">
                              {project || t("tasks.noProject")}
                            </span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="start"
                          className="task-quick-popover w-56 p-2"
                        >
                          <form
                            className="flex items-center gap-1"
                            onSubmit={(event) => {
                              event.preventDefault();
                              patchWorkItem.mutate({
                                project: projectDraft.trim(),
                              });
                              setProjectOpen(false);
                            }}
                          >
                            <Input
                              type="text"
                              className="h-7 text-xs"
                              placeholder={t("tasks.projectName")}
                              value={projectDraft}
                              onChange={(event) =>
                                setProjectDraft(event.target.value)
                              }
                            />
                            <Button type="submit" size="xs" variant="outline">
                              {t("common.save")}
                            </Button>
                          </form>
                        </PopoverContent>
                      </Popover>
                    ) : (
                      <span
                        className="inline-flex min-w-0 items-center gap-1.5"
                        title={project}
                      >
                        <Folder
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">{project}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {(canEditDeadline || effectiveDeadline) && (
                <div className="task-detail-prop-cell">
                  <span className="task-detail-prop-label">
                    {t("tasks.deadline.label")}
                  </span>
                  <div className="task-detail-prop-value">
                    {canEditDeadline ? (
                      <TaskDeadlinePicker
                        value={
                          effectiveDeadline
                            ? {
                                dueAt: effectiveDeadline.dueAt,
                                dueDate: effectiveDeadline.dueDate,
                                remindOffsets: effectiveDeadline.remindOffsets,
                              }
                            : undefined
                        }
                        defaultRemindOffsets={
                          reminderSettings.defaultRemindOffsets
                        }
                        allDayReminderTime={reminderSettings.allDayReminderTime}
                        allowClear={!!effectiveDeadline?.hasLocalOverride}
                        clearLabel={
                          external?.dueAt
                            ? t("tasks.deadline.resetToSource")
                            : t("tasks.deadline.clear")
                        }
                        align="start"
                        onChange={handleDeadlineChange}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="task-detail-prop-trigger task-detail-deadline-trigger tabular-nums"
                          data-urgency={effectiveDeadline?.urgency}
                          aria-label={t("tasks.deadline.label")}
                        >
                          {effectiveDeadline?.urgency === "overdue" ? (
                            <AlertTriangle
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <CalendarClock
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate">
                            {effectiveDeadline
                              ? formatDeadlineFull(
                                  effectiveDeadline,
                                  t,
                                  i18n.language,
                                )
                              : t("tasks.deadline.setDeadline")}
                          </span>
                        </Button>
                      </TaskDeadlinePicker>
                    ) : effectiveDeadline ? (
                      <span
                        className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground tabular-nums"
                        title={formatDeadlineFull(
                          effectiveDeadline,
                          t,
                          i18n.language,
                        )}
                      >
                        <CalendarClock
                          className="size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {formatDeadlineFull(
                            effectiveDeadline,
                            t,
                            i18n.language,
                          )}
                        </span>
                      </span>
                    ) : null}
                  </div>
                </div>
              )}

              {effectiveDeadline && (
                <div className="task-detail-prop-cell">
                  <span className="task-detail-prop-label">
                    {t("tasks.reminder.label")}
                  </span>
                  <div className="task-detail-prop-value">
                    {canEditDeadline ? (
                      <TaskDeadlinePicker
                        value={{
                          dueAt: effectiveDeadline.dueAt,
                          dueDate: effectiveDeadline.dueDate,
                          remindOffsets: effectiveDeadline.remindOffsets,
                        }}
                        defaultRemindOffsets={
                          reminderSettings.defaultRemindOffsets
                        }
                        allDayReminderTime={reminderSettings.allDayReminderTime}
                        allowClear={!!effectiveDeadline.hasLocalOverride}
                        clearLabel={
                          external?.dueAt
                            ? t("tasks.deadline.resetToSource")
                            : t("tasks.deadline.clear")
                        }
                        align="start"
                        onChange={handleDeadlineChange}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="task-detail-prop-trigger tabular-nums"
                          aria-label={t("tasks.reminder.label")}
                        >
                          {effectiveDeadline.remindOffsets.length > 0 ? (
                            <Bell
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          ) : (
                            <BellOff
                              className="size-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate">
                            {effectiveDeadline.remindOffsets.length > 0
                              ? effectiveDeadline.remindOffsets
                                  .map((m) =>
                                    formatReminderOffset(
                                      m,
                                      effectiveDeadline.isAllDay,
                                      reminderSettings.allDayReminderTime,
                                      t,
                                    ),
                                  )
                                  .join(" · ")
                              : t("tasks.reminder.none")}
                          </span>
                        </Button>
                      </TaskDeadlinePicker>
                    ) : (
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground tabular-nums">
                        {effectiveDeadline.remindOffsets.length > 0 ? (
                          <Bell
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <BellOff
                            className="size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="truncate">
                          {effectiveDeadline.remindOffsets.length > 0
                            ? effectiveDeadline.remindOffsets
                                .map((m) =>
                                  formatReminderOffset(
                                    m,
                                    effectiveDeadline.isAllDay,
                                    reminderSettings.allDayReminderTime,
                                    t,
                                  ),
                                )
                                .join(" · ")
                            : t("tasks.reminder.none")}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {external && (
                <>
                  <div className="task-detail-prop-cell">
                    <span className="task-detail-prop-label">
                      {t("tasks.filterKind")}
                    </span>
                    <div className="task-detail-prop-value">
                      <SourceIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span>{t("tasks.kind." + external.kind)}</span>
                    </div>
                  </div>
                  <div className="task-detail-prop-cell">
                    <span className="task-detail-prop-label">
                      {t("tasks.filterRemote")}
                    </span>
                    <div className="task-detail-prop-value">
                      <span>{t("tasks.remote." + external.state)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
            {canEditDeadline && effectiveDeadline?.attentionActive && (
              <div
                className="task-detail-deadline-banner"
                data-urgency={effectiveDeadline.urgency}
              >
                <span className="task-detail-deadline-banner-text tabular-nums">
                  {effectiveDeadline.urgency === "overdue" ? (
                    <AlertTriangle
                      className="size-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <Bell className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">
                    {formatDeadlineLabel(
                      effectiveDeadline,
                      Date.now(),
                      t,
                      i18n.language,
                    )}
                  </span>
                </span>
                <div className="task-detail-deadline-banner-actions">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={snoozeDeadline.isPending}
                    onClick={() =>
                      snoozeDeadline.mutate(
                        { taskId: id, minutes: 15 },
                        {
                          onSuccess: () =>
                            toast.success(
                              t("tasks.reminder.snoozed", { count: 15 }),
                            ),
                          onError: (err) => toast.error(err.message),
                        },
                      )
                    }
                  >
                    {t("tasks.reminder.snooze15m")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={snoozeDeadline.isPending}
                    onClick={() =>
                      snoozeDeadline.mutate(
                        { taskId: id, minutes: 60 },
                        {
                          onSuccess: () =>
                            toast.success(
                              t("tasks.reminder.snoozedHours", { count: 1 }),
                            ),
                          onError: (err) => toast.error(err.message),
                        },
                      )
                    }
                  >
                    {t("tasks.reminder.snooze1h")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={saveDeadline.isPending}
                    onClick={postponeToTomorrow}
                  >
                    {t("tasks.deadline.postponeTomorrow")}
                  </Button>
                </div>
              </div>
            )}
            {(workItem?.body || external?.body) && (
              <MessageResponse
                className="task-board-detail-description"
                text={workItem?.body || external?.body || ""}
              />
            )}
            {canAssign && assigning && (
              <TaskDispatchPanel
                task={{
                  title: task.title,
                  agentId,
                  images,
                  noteId: target.noteId,
                }}
                agents={activeAgents}
                onCancel={() => setAssigning(false)}
                onDispatch={async (options) => {
                  await dispatch({ ...target, images }, options);
                  setAssigning(false);
                }}
              />
            )}
            {!!error && (
              <ErrorNotice
                error={conflict ? t("tasks.noteConflict") : error}
                retry={retry}
              />
            )}
            {pendingRequests.length > 0 && (
              <div className="task-detail-requests">
                {pendingRequests.map((request) => (
                  <div key={request.id} className="task-detail-approval-shell">
                    <RequestCard request={request} />
                  </div>
                ))}
              </div>
            )}
            {canRetryExecution && (
              <div className="task-detail-retry-bar">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="task-btn-danger"
                  disabled={retryRun.isPending}
                  onClick={() => retryRun.mutate()}
                >
                  <RotateCcw data-icon="inline-start" />
                  {t("tasks.retryRun")}
                </Button>
              </div>
            )}
            {queue ? (
              <TaskQueueInfo queue={queue} waitLabel={waitLabel} />
            ) : (
              <TaskActivity
                execution={execution}
                agent={agent}
                agents={agents}
                onOpenRun={onOpenRun}
              />
            )}
          </div>
        )}
      </div>
      {task && status && (
        <footer className="task-board-detail-footer">
          {canFollowup && (
            <form
              className="task-detail-followup"
              onSubmit={(event) => {
                event.preventDefault();
                const text = followup.trim();
                if (!text || sendFollowup.isPending) return;
                sendFollowup.mutate(text);
              }}
            >
              <input
                type="text"
                className="task-detail-followup-input"
                aria-label={t("tasks.sendFollowup")}
                placeholder={t("tasks.followupPlaceholder")}
                value={followup}
                disabled={sendFollowup.isPending}
                onChange={(event) => setFollowup(event.target.value)}
              />
              <Button
                type="submit"
                size="xs"
                variant="outline"
                disabled={!followup.trim() || sendFollowup.isPending}
                aria-label={t("tasks.sendFollowup")}
              >
                {t("tasks.followupSend")}
              </Button>
            </form>
          )}
          <TaskDetailActions
            task={{ title: task.title, status }}
            onOpenChat={
              execution && (() => onOpenChat(execution, task.title))
            }
            openChatLabel={
              execution?.topic ? t("automations.openTopic") : undefined
            }
            onAssign={
              canAssign && !actionsDisabled
                ? () => setAssigning(true)
                : undefined
            }
            onComplete={
              actionsDisabled ? undefined : () => update.mutate(true)
            }
            onReopen={
              actionsDisabled
                ? undefined
                : status === "closed"
                  ? () => workflowUpdate.mutate("reopen")
                  : () => update.mutate(false)
            }
            onAccept={
              !actionsDisabled && status === "unconfirmed"
                ? () => workflowUpdate.mutate("accept")
                : undefined
            }
            onAcceptAndEnqueue={
              !actionsDisabled &&
              status === "unconfirmed" &&
              activeAgents.length > 0
                ? () => void acceptAndEnqueue()
                : undefined
            }
            onWithdraw={
              !actionsDisabled && queue
                ? () => workflowUpdate.mutate("withdraw")
                : undefined
            }
          />
        </footer>
      )}
    </>
  );

  if (embedded) {
    return (
      <section
        className="task-inbox-detail"
        aria-label={task?.title || t("tasks.detail")}
      >
        {inner}
      </section>
    );
  }

  return (
    <Dialog open modal={false} onOpenChange={(open) => !open && onClose?.()}>
      <DialogPrimitive.Content
        className="task-board-detail dialog-surface"
        aria-describedby={undefined}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeButton.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {inner}
      </DialogPrimitive.Content>
    </Dialog>
  );
}
