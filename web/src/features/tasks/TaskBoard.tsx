import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowDownUp,
  Bookmark,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDot,
  FileText,
  Folder,
  GitPullRequest,
  Kanban,
  LayoutGrid,
  List,
  NotebookPen,
  Play,
  Undo2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import {
  TaskSourceKindIssue,
  TaskSourceKindPR,
  type Agent,
  type Request,
  type TaskDeadlineInput,
  type TaskExecution,
  type TaskNoteSummary,
  type TaskReminderSettings,
  type TaskView,
  type TaskWorkflow,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RunStatus } from "@/features/chat/RunStatus";
import { ActivityTime } from "@/components/workbench/ActivityTime";
import { TaskAgentDock } from "./TaskAgentDock";
import { changeTaskWorkflow } from "./taskWorkflow";
import { TaskBoardActions } from "./TaskBoardActions";
import { TaskAssignee } from "./TaskAssignee";
import { TaskBoardFilter } from "./TaskBoardFilter";
import { TaskDeadlineBadge } from "./TaskDeadlineBadge";
import {
  defaultReminderSettings,
  dueFilterValues,
  matchesDueFilter,
  useClearTaskDeadline,
  useSaveTaskDeadline,
} from "./taskDeadlines";
import { TaskListView } from "./TaskListView";
import { TaskPriorityIcon } from "./TaskPriorityIcon";
import { TaskQuickCreate } from "./TaskQuickCreate";
import { taskStatuses } from "./TaskStatusIcon";
import {
  columnsByStatus,
  canHandOffTask,
  hasUnfinishedTaskRun,
  compareTasksByDeadline,
  compareTasksByPriority,
  formatWaitDuration,
  needsAttention,
  queueWaitState,
  setTaskDoneState,
  taskColumn,
  type AgentQueueMetrics,
  type BoardTask,
} from "./taskBoardModel";
import type { TaskStatus } from "./taskDocument";
import { useTaskDispatch, type TaskDispatchTarget } from "./useTaskDispatch";
import type { useTaskDrafts } from "./useTaskNote";

type Group = TaskView["group"];
export type BoardSort = "deadline" | "priority";
export type BoardView = Pick<
  TaskView,
  "group" | "sort" | "filters" | "quickFilter"
>;

const groups = {
  status: CircleDot,
  project: Folder,
  agent: UserRound,
} satisfies Record<Group, LucideIcon>;

type TaskCardAction = (
  task: TaskDispatchTarget,
  trigger: HTMLButtonElement,
) => void;

type ActiveCardDrag = {
  id: string;
  task: BoardTask;
  rect: ClientRect;
};

export function TaskBoard({
  name,
  consumingOnly = false,
  tasks,
  drafts,
  sourceLabels,
  reminderSettings = defaultReminderSettings,
  loading,
  failed,
  notes,
  agents,
  executions,
  workflows,
  requests = [],
  agentMetricsList,
  agentMetricsMap,
  view,
  search,
  selectedTaskId,
  visibleTasksRef,
  detail,
  saveLabel,
  saving,
  onViewChange,
  onSave,
  onSaveAs,
  onOpen,
  onAssign,
}: {
  name: string;
  consumingOnly?: boolean;
  tasks: BoardTask[];
  drafts: ReturnType<typeof useTaskDrafts>;
  sourceLabels: Map<string, string>;
  reminderSettings?: TaskReminderSettings;
  loading: boolean;
  failed?: { error: unknown; refetch: () => unknown };
  notes: TaskNoteSummary[];
  agents: Agent[];
  executions: Map<string, TaskExecution>;
  workflows: Map<string, TaskWorkflow>;
  requests?: Request[];
  agentMetricsList: AgentQueueMetrics[];
  agentMetricsMap: Map<string, AgentQueueMetrics>;
  view: BoardView;
  search: string;
  selectedTaskId?: string;
  visibleTasksRef?: MutableRefObject<BoardTask[]>;
  detail?: ReactNode;
  saveLabel?: string;
  saving: boolean;
  onViewChange: (view: BoardView) => void;
  onSave: () => void;
  onSaveAs?: () => void;
  onOpen: TaskCardAction;
  onAssign: TaskCardAction;
}) {
  const { t } = useTranslation();
  const dispatch = useTaskDispatch();
  const { group, filters, quickFilter } = view;
  const sort: BoardSort = view.sort === "priority" ? "priority" : "deadline";
  const setFilters = (nextFilters: BoardView["filters"]) =>
    onViewChange({ group, sort: view.sort, filters: nextFilters, quickFilter });
  const setSort = (nextSort: BoardSort) =>
    onViewChange({ group, sort: nextSort, filters, quickFilter });

  const [display, setDisplay] = useState<"board" | "list">("board");
  const [showDone, setShowDone] = useState(false);
  const [activeDrag, setActiveDrag] = useState<ActiveCardDrag>();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const quickAssignFallbackRef = useRef<HTMLButtonElement>(null);

  const saveDeadline = useSaveTaskDeadline();
  const clearDeadline = useClearTaskDeadline();
  const handleChangeDeadline = useCallback(
    (task: BoardTask, next: TaskDeadlineInput | null) => {
      if (next === null) {
        clearDeadline.mutate(task.id, {
          onError: (error) => toast.error(error.message),
        });
      } else {
        saveDeadline.mutate(
          { taskId: task.id, input: next },
          { onError: (error) => toast.error(error.message) },
        );
      }
    },
    [clearDeadline, saveDeadline],
  );

  const activeAgents = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );

  const requestByRunId = useMemo(() => {
    const map = new Map<string, Request>();
    for (const req of requests) {
      if (req.status === "pending" && req.runId && !map.has(req.runId)) {
        map.set(req.runId, req);
      }
    }
    return map;
  }, [requests]);

  const hasCoolingQueue = useMemo(
    () =>
      tasks.some(
        (task) => task.queue?.nextStartAt && task.queue.nextStartAt > nowMs,
      ),
    [tasks, nowMs],
  );
  const hasActiveDeadlines = useMemo(
    () =>
      tasks.some(
        (task) => !!task.deadline && task.deadline.urgency !== "done",
      ),
    [tasks],
  );
  useEffect(() => {
    if (!hasCoolingQueue && !hasActiveDeadlines) return;
    const interval = hasCoolingQueue ? 10_000 : 30_000;
    const timer = window.setInterval(() => setNowMs(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [hasCoolingQueue, hasActiveDeadlines]);

  const noteOptions = notes.map(({ id, title }) => ({
    id,
    label: (drafts.get(id)?.note.title ?? title).trim() || t("tasks.note"),
  }));
  const projects = new Set(tasks.map((task) => task.project));
  // Keep selected project labels editable even if their last task was moved.
  for (const project of filters.project ?? []) projects.add(project);
  const projectOptions = [...projects].map((id) => ({
    id,
    label: id || t("tasks.noProject"),
  }));
  const namedProjects = useMemo(
    () => [...projects].filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [projects],
  );

  const term = search.trim().toLocaleLowerCase();
  const scoped = tasks.filter((task) => {
    if (
      consumingOnly &&
      task.status !== "queued" &&
      task.status !== "running" &&
      task.status !== "attention"
    )
      return false;
    if (task.status === "closed" && !filters.status?.includes("closed"))
      return false;
    if (
      !filters.remote?.length &&
      !term &&
      task.remote &&
      task.remote !== "open" &&
      task.status === "todo" &&
      workflows.get(task.id)?.disposition !== "todo" &&
      !executions.has(task.id)
    )
      return false;
    const values = {
      agent: task.agentId ?? "",
      note: task.noteId ?? "",
      project: task.project,
      source: task.source,
      kind: task.kind ?? "",
      remote: task.remote ?? "",
    };
    const matchesFilters =
      (Object.keys(values) as (keyof typeof values)[]).every(
        (key) => !filters[key]?.length || filters[key].includes(values[key]),
      ) && matchesDueFilter(task.deadline, filters.due ?? [], nowMs);
    return (
      matchesFilters &&
      (!term ||
        [
          task.title,
          task.noteTitle,
          task.project,
          task.agent?.name,
          task.reference,
          task.reference && task.project + task.reference,
        ].some((value) => value?.toLocaleLowerCase().includes(term)))
    );
  });

  const explicitDoneFilter = !!filters.status?.includes("done");
  const showingDone = showDone || explicitDoneFilter;

  const shown = scoped.filter((task) => {
    if (filters.status?.length) {
      return filters.status.some(
        (status) =>
          status === task.status ||
          status === taskColumn(task.status) ||
          (status === "attention" && needsAttention(task)),
      );
    }
    if (
      (group === "status" || display === "list") &&
      !showingDone &&
      task.status === "done"
    ) {
      return false;
    }
    return true;
  });

  if (visibleTasksRef) {
    visibleTasksRef.current = shown;
  }

  const queueSizes = new Map<string, number>();
  for (const { queue } of workflows.values()) {
    if (queue?.position)
      queueSizes.set(
        queue.agentId,
        Math.max(queueSizes.get(queue.agentId) ?? 0, queue.position),
      );
  }

  const reorder = useMutation({
    mutationFn: ({ agentId, ids }: { agentId: string; ids: string[] }) =>
      api("/tasks/queue/order", { agentId, ids }, "PUT"),
    onError: (error) => toast.error(error.message),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["task-workflows"] }),
  });

  const acceptTask = useMutation({
    mutationFn: (task: BoardTask) =>
      api(
        "/tasks/workflows/" + task.id,
        { record: task.record, noteId: task.noteId, action: "accept" },
        "PATCH",
      ),
    onError: (error) => toast.error(error.message),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["task-workflows"] }),
  });

  const completeTask = useMutation({
    mutationFn: ({ task, done }: { task: BoardTask; done: boolean }) =>
      setTaskDoneState(task, done, t("tasks.sourceRemoved")),
    onError: (error) => toast.error(error.message),
  });

  const approveRequest = useMutation({
    mutationFn: (requestId: string) =>
      api(`/requests/${requestId}/answer`, { allow: true }),
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
    },
  });

  const retryRun = useMutation({
    mutationFn: (runId: string) =>
      api(`/runs/${runId}/retry`, { commandId: crypto.randomUUID() }),
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
    },
  });

  const columns = new Map<string, { label: string; tasks: BoardTask[] }>();
  if (group === "status") {
    const visibleColumns = new Set(
      shown.map(({ status }) => taskColumn(status)),
    );
    for (const status of [...columnsByStatus, "closed"] as const) {
      if (filters.status?.length) {
        if (!visibleColumns.has(status) && !filters.status.includes(status))
          continue;
      } else {
        if (status === "closed") continue;
        if (status === "done" && !showingDone) continue;
      }
      columns.set(status, {
        label: t("tasks.status." + status),
        tasks: [],
      });
    }
  }
  for (const task of shown) {
    const key =
      group === "status"
        ? taskColumn(task.status)
        : group === "agent"
          ? (task.agentId ?? "")
          : task.project;
    let column = columns.get(key);
    if (!column) {
      column = {
        label:
          group === "agent"
            ? (task.agent?.name ?? t("tasks.unassigned"))
            : task.project || t("tasks.noProject"),
        tasks: [],
      };
      columns.set(key, column);
    }
    column.tasks.push(task);
  }

  const queuedIdsByAgent = useMemo(() => {
    const map = new Map<string, string[]>();
    const queuedColumn = columns.get("queued")?.tasks ?? [];
    const byAgent = new Map<string, BoardTask[]>();
    for (const task of queuedColumn) {
      if (!task.queue?.position) continue;
      const list = byAgent.get(task.queue.agentId) ?? [];
      list.push(task);
      byAgent.set(task.queue.agentId, list);
    }
    for (const [agentId, list] of byAgent) {
      list.sort(
        (a, b) =>
          (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity),
      );
      map.set(
        agentId,
        list.map((item) => item.queue!.id),
      );
    }
    return map;
  }, [columns]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const hits = args.pointerCoordinates ? pointerWithin(args) : [];
    const dockHit = hits.find((hit) =>
      String(hit.id).startsWith("agent-dock:"),
    );
    if (dockHit) return [dockHit];

    const draggedTask = args.active.data.current?.task as BoardTask | undefined;
    if (draggedTask?.queue?.position) {
      const sameAgentContainer = args.droppableContainers.filter(
        (item) =>
          item.data.current?.queueAgentId === draggedTask.queue?.agentId,
      );
      const hitSameAgent = hits.some(
        (hit) =>
          String(hit.id) === "column:queued" ||
          sameAgentContainer.some((c) => c.id === hit.id),
      );
      if (hitSameAgent && sameAgentContainer.length > 0) {
        return closestCenter({
          ...args,
          droppableContainers: sameAgentContainer,
        });
      }
    }

    const columnHit = hits.find((hit) =>
      String(hit.id).startsWith("column:"),
    );
    if (columnHit) return [columnHit];

    return closestCenter(args);
  }, []);

  async function enqueueTaskDirect(task: BoardTask, agentId: string) {
    const agent = activeAgents.find((item) => item.id === agentId);
    if (!agent) return;
    try {
      await dispatch(task, { agentId: agent.id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function reassignQueuedTask(task: BoardTask, targetAgentId: string) {
    if (!task.queue) return;
    const agent = activeAgents.find((item) => item.id === targetAgentId);
    if (!agent) return;
    try {
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
      await dispatch(task, { agentId: agent.id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      void queryClient.invalidateQueries({ queryKey: ["task-workflows"] });
    }
  }

  async function withdrawQueuedTask(task: BoardTask) {
    if (!task.queue) return;
    try {
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
      await queryClient.invalidateQueries({ queryKey: ["task-workflows"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function handleQuickEnqueue(task: BoardTask, trigger?: HTMLButtonElement) {
    const directAgent =
      activeAgents.find((item) => item.id === task.agentId) ??
      (activeAgents.length === 1 ? activeAgents[0] : undefined);
    if (directAgent) {
      void enqueueTaskDirect(task, directAgent.id);
    } else if (trigger || quickAssignFallbackRef.current) {
      onAssign(task, trigger ?? quickAssignFallbackRef.current!);
    }
  }

  function handleDragEnd(activeId: string, overId: string | undefined, task: BoardTask | undefined) {
    setActiveDrag(undefined);
    if (!overId || !task) return;

    if (overId.startsWith("agent-dock:")) {
      const targetAgentId = overId.slice("agent-dock:".length);
      if (canHandOffTask(task)) {
        void enqueueTaskDirect(task, targetAgentId);
      } else if (task.queue && task.queue.agentId !== targetAgentId) {
        void reassignQueuedTask(task, targetAgentId);
      }
      return;
    }

    if (task.queue?.position) {
      const agentId = task.queue.agentId;
      const ids = queuedIdsByAgent.get(agentId) ?? [];
      if (ids.includes(overId) && activeId !== overId) {
        const from = ids.indexOf(activeId);
        const to = ids.indexOf(overId);
        if (from >= 0 && to >= 0 && ids.length === (queueSizes.get(agentId) ?? 0)) {
          reorder.mutate({ agentId, ids: arrayMove(ids, from, to) });
        }
        return;
      }
      if (overId === "column:todo") {
        void withdrawQueuedTask(task);
        return;
      }
    }

    if (overId === "column:queued") {
      if (canHandOffTask(task)) {
        handleQuickEnqueue(task);
      }
      return;
    }

    if (overId === "column:done") {
      if (task.status === "review" || task.status === "todo") {
        completeTask.mutate({ task, done: true });
      }
      return;
    }

    if (overId === "column:todo" && task.status !== "todo") {
      void changeTaskWorkflow(task, "todo").catch((error: Error) => toast.error(error.message));
    }
  }

  const filterCount = Object.values(filters).reduce(
    (count, values) => count + values.length,
    0,
  );
  const GroupIcon = groups[group];

  const defaultCreateAgent =
    filters.agent?.length === 1 && filters.agent[0] !== ""
      ? filters.agent[0]
      : undefined;
  const defaultCreateProject =
    filters.project?.length === 1 && filters.project[0] !== ""
      ? filters.project[0]
      : undefined;

  function moveQueuedTask(agentId: string, queueId: string, delta: -1 | 1) {
    const ids = queuedIdsByAgent.get(agentId) ?? [];
    const from = ids.indexOf(queueId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    if (ids.length !== (queueSizes.get(agentId) ?? 0)) return;
    reorder.mutate({ agentId, ids: arrayMove(ids, from, to) });
  }

  function renderCard(
    task: BoardTask,
    options?: {
      sortable?: boolean;
      onMoveUp?: () => void;
      onMoveDown?: () => void;
      onWithdraw?: () => void;
    },
  ) {
    const sortable = options?.sortable ?? false;
    const canDragCrossColumn = display === "board";
    const agentMetrics = task.queue
      ? agentMetricsMap.get(task.queue.agentId)
      : undefined;
    const waitState = queueWaitState(task.queue, agentMetrics, nowMs);
    const pendingRequest = task.execution?.runId
      ? requestByRunId.get(task.execution.runId)
      : undefined;
    const canRetry =
      !!task.execution?.runId &&
      !task.execution.automationId &&
      (task.execution.status === "failed" ||
        task.execution.status === "interrupted");
    const canEditDeadline =
      task.record !== "automation" &&
      task.status !== "done" &&
      task.status !== "closed";
    return (
      <TaskCard
        key={task.id}
        task={task}
        group={group}
        sourceLabel={sourceLabels.get(task.source) ?? task.source}
        nowMs={nowMs}
        reminderSettings={reminderSettings}
        selected={task.id === selectedTaskId}
        sortable={sortable}
        draggable={canDragCrossColumn}
        activeDrag={activeDrag}
        waitState={waitState}
        agentMetrics={agentMetrics}
        pendingRequest={pendingRequest}
        approving={approveRequest.isPending}
        retrying={retryRun.isPending}
        onOpen={onOpen}
        onAssign={onAssign}
        onQuickEnqueue={handleQuickEnqueue}
        onChangeDeadline={
          canEditDeadline
            ? (next) => handleChangeDeadline(task, next)
            : undefined
        }
        onApproveRequest={
          pendingRequest
            ? () => approveRequest.mutate(pendingRequest.id)
            : undefined
        }
        onRetryRun={
          canRetry ? () => retryRun.mutate(task.execution!.runId) : undefined
        }
        onMoveUp={options?.onMoveUp}
        onMoveDown={options?.onMoveDown}
        onWithdraw={options?.onWithdraw}
        onAccept={
          task.status === "unconfirmed"
            ? () => acceptTask.mutate(task)
            : undefined
        }
        onAcceptAndEnqueue={
          task.status === "unconfirmed" && activeAgents.length > 0
            ? (trigger) => handleQuickEnqueue(task, trigger)
            : undefined
        }
        onQuickComplete={
          task.status === "review"
            ? () => completeTask.mutate({ task, done: true })
            : undefined
        }
      />
    );
  }

  const pendingReorder = reorder.isPending ? reorder.variables : undefined;

  const content =
    loading && !shown.length ? (
      <Loading />
    ) : failed && !shown.length ? (
      <ErrorNotice error={failed.error} retry={() => void failed.refetch()} />
    ) : !shown.length ? (
      <Empty>
        <EmptyMedia variant="icon">
          <LayoutGrid />
        </EmptyMedia>
        <EmptyTitle>
          {t(filterCount || term ? "tasks.noMatches" : "tasks.emptyBoard")}
        </EmptyTitle>
        {!!filterCount && (
          <Button variant="outline" size="sm" onClick={() => setFilters({})}>
            {t("tasks.clearFilters")}
          </Button>
        )}
      </Empty>
    ) : display === "list" ? (
      <TaskListView
        tasks={shown}
        group={group}
        sort={sort}
        agents={agents}
        agentMetrics={agentMetricsMap}
        reminderSettings={reminderSettings}
        selectedTaskId={selectedTaskId}
        activeDrag={activeDrag}
        nowMs={nowMs}
        onOpen={onOpen}
        onAssign={onAssign}
        onAccept={(task) => acceptTask.mutate(task)}
        onQuickComplete={(task) => completeTask.mutate({ task, done: true })}
        onChangeDeadline={handleChangeDeadline}
      />
    ) : (
      <div
        className="task-board-columns"
        data-group={group}
        data-column-count={columns.size}
      >
        {[...columns].map(([key, { label, tasks: columnTasks }]) => {
          const agent = group === "agent" ? columnTasks[0]?.agent : undefined;
          const droppableColumn =
            group === "status" &&
            (key === "todo" || key === "queued" || key === "done");
          const comparator =
            sort === "priority"
              ? compareTasksByPriority
              : compareTasksByDeadline;
          const sortedColumnTasks =
            group === "status" && key === "running"
              ? [...columnTasks].sort((a, b) => {
                  const attDiff =
                    Number(needsAttention(b)) - Number(needsAttention(a));
                  if (attDiff !== 0) return attDiff;
                  return comparator(a, b);
                })
              : group === "status" && key === "done"
                ? columnTasks
                : [...columnTasks].sort(comparator);
          return (
            <BoardColumn
              key={key}
              columnKey={key}
              label={label}
              count={columnTasks.length}
              group={group}
              agent={agent}
              GroupIcon={GroupIcon}
              droppable={droppableColumn}
              activeDragTask={activeDrag?.task}
            >
              {columnTasks.length === 0 ? (
                <div className="task-board-column-empty">
                  {t(
                    key === "queued"
                      ? "tasks.emptyColumnQueued"
                      : "tasks.emptyColumn",
                  )}
                </div>
              ) : group === "status" && key === "queued" ? (
                <QueuedColumn
                  tasks={columnTasks}
                  queueSizes={queueSizes}
                  agentMetricsMap={agentMetricsMap}
                  pendingReorder={pendingReorder}
                  onMoveItem={moveQueuedTask}
                  onWithdrawItem={(task) => void withdrawQueuedTask(task)}
                  renderCard={renderCard}
                />
              ) : (
                <ul className="task-board-cards">
                  {sortedColumnTasks.map((task) => renderCard(task))}
                </ul>
              )}
            </BoardColumn>
          );
        })}
      </div>
    );

  return (
    <section className="tasks-board">
      <header className="task-board-toolbar">
        <div className="task-board-heading">
          <LayoutGrid
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <h1 className="truncate" title={name}>
            {name}
          </h1>
          {!loading && !failed && (
            <span className="task-board-total">
              {t("tasks.boardTotal", { count: shown.length })}
            </span>
          )}
          {saveLabel && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={onSave}
              disabled={saving}
            >
              <Bookmark data-icon="inline-start" />
              {saveLabel}
            </Button>
          )}
        </div>
        <div className="task-board-controls">
          <TaskBoardFilter
            filters={filters}
            count={filterCount}
            quickFilter={quickFilter}
            onChange={setFilters}
            onQuickFilterChange={(nextQuickFilter) =>
              onViewChange({
                group,
                sort: view.sort,
                filters,
                quickFilter: nextQuickFilter,
              })
            }
            onSaveAs={onSaveAs}
            fields={[
              {
                id: "due",
                label: t("tasks.deadline.label"),
                icon: CalendarClock,
                options: dueFilterValues.map((id) => ({
                  id,
                  label: t("tasks.deadline.filter." + id),
                })),
              },
              {
                id: "status",
                label: t("tasks.filterStatus"),
                icon: CircleDot,
                options: taskStatuses.map((id) => ({
                  id,
                  label: t("tasks.status." + id),
                })),
              },
              {
                id: "project",
                label: t("tasks.project"),
                icon: Folder,
                options: projectOptions,
              },
              {
                id: "agent",
                label: t("tasks.assignee"),
                icon: UserRound,
                options: [
                  { id: "", label: t("tasks.unassigned") },
                  ...agents.map(({ id, name }) => ({ id, label: name })),
                ],
              },
              {
                id: "note",
                label: t("tasks.filterNote"),
                icon: NotebookPen,
                options: noteOptions,
              },
              {
                id: "source",
                label: t("tasks.filterSource"),
                icon: FileText,
                options: [...sourceLabels].map(([id, label]) => ({
                  id,
                  label,
                })),
              },
              {
                id: "kind",
                label: t("tasks.filterKind"),
                icon: GitPullRequest,
                options: [
                  ...new Set([
                    TaskSourceKindIssue,
                    TaskSourceKindPR,
                    ...tasks.flatMap((task) => (task.kind ? [task.kind] : [])),
                    ...(filters.kind ?? []),
                  ]),
                ].map((id) => ({
                  id,
                  label: t("tasks.kind." + id, { defaultValue: id }),
                  shortLabel: id === TaskSourceKindPR ? "PR" : undefined,
                  icon:
                    id === TaskSourceKindIssue
                      ? CircleDot
                      : id === TaskSourceKindPR
                        ? GitPullRequest
                        : undefined,
                })),
              },
              {
                id: "remote",
                label: t("tasks.filterRemote"),
                icon: CircleCheck,
                options: [
                  ...new Set([
                    ...tasks.flatMap((task) =>
                      task.remote ? [task.remote] : [],
                    ),
                    ...(filters.remote ?? []),
                  ]),
                ].map((id) => ({ id, label: t("tasks.remote." + id) })),
              },
            ]}
          />
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            className="task-segmented-toggle task-board-sort"
            aria-label={t("tasks.sort.label")}
            value={sort}
            onValueChange={(value) => {
              if (value === "deadline" || value === "priority") setSort(value);
            }}
          >
            <ToggleGroupItem value="deadline" title={t("tasks.sort.deadlineHint")}>
              <ArrowDownUp className="size-3.5" aria-hidden="true" />
              <span>{t("tasks.sort.deadline")}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="priority" title={t("tasks.sort.priorityHint")}>
              <span>{t("tasks.sort.priority")}</span>
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            className="task-segmented-toggle task-board-group"
            aria-label={t("tasks.group")}
            value={group}
            onValueChange={(value) => {
              if (value)
                onViewChange({
                  group: value as Group,
                  sort: view.sort,
                  filters,
                  quickFilter,
                });
            }}
          >
            {Object.keys(groups).map((id) => (
              <ToggleGroupItem key={id} value={id}>
                {t("tasks.group." + id)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {!filters.status?.length && (group === "status" || display === "list") && (
            <Button
              ref={quickAssignFallbackRef}
              type="button"
              variant="ghost"
              size="xs"
              className="task-show-done-btn"
              aria-pressed={showingDone}
              data-active={showingDone || undefined}
              onClick={() => setShowDone((prev) => !prev)}
            >
              {t("tasks.showDone")}
            </Button>
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            className="task-segmented-toggle task-board-display-toggle"
            aria-label={t("tasks.display")}
            value={display}
            onValueChange={(value) => {
              if (value === "board" || value === "list") setDisplay(value);
            }}
          >
            <ToggleGroupItem value="board">
              <Kanban className="size-3.5" aria-hidden="true" />
              <span>{t("tasks.display.board")}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="list">
              <List className="size-3.5" aria-hidden="true" />
              <span>{t("tasks.display.list")}</span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </header>

      <DndContext
        id="task-board-dnd"
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={({ active, activatorEvent }) => {
          const task = active.data.current?.task as BoardTask | undefined;
          const el = (activatorEvent.target as HTMLElement | null)?.closest(
            ".task-board-card, .task-list-row",
          );
          if (task && el) {
            setActiveDrag({
              id: String(active.id),
              task,
              rect: el.getBoundingClientRect(),
            });
          }
        }}
        onDragMove={({ active }) => {
          const rect = active.rect.current.translated;
          if (rect) {
            setActiveDrag((current) => (current ? { ...current, rect } : current));
          }
        }}
        onDragCancel={() => setActiveDrag(undefined)}
        onDragEnd={({ active, over }) =>
          handleDragEnd(
            String(active.id),
            over ? String(over.id) : undefined,
            active.data.current?.task as BoardTask | undefined,
          )
        }
      >
        <TaskAgentDock
          metrics={agentMetricsList}
          selectedAgents={filters.agent ?? []}
          draggingTask={
            !!activeDrag &&
            (canHandOffTask(activeDrag.task) ||
              activeDrag.task.status === "queued")
          }
          onToggleAgentFilter={(agentId) => {
            const current = filters.agent ?? [];
            const next = current.includes(agentId)
              ? current.filter((id) => id !== agentId)
              : [agentId];
            setFilters({ ...filters, agent: next.length ? next : undefined });
          }}
        />

        <div className="task-board-subbar">
          <TaskQuickCreate
            agents={agents}
            projects={namedProjects}
            defaultAgentId={defaultCreateAgent}
            defaultProject={defaultCreateProject}
            reminderSettings={reminderSettings}
            onNeedsDispatch={onAssign}
          />
        </div>

        <div className="task-board-workspace">
          <div className="task-board-body">
            {failed && shown.length > 0 && (
              <ErrorNotice
                error={failed.error}
                retry={() => void failed.refetch()}
              />
            )}
            {content}
          </div>
          {detail}
        </div>
      </DndContext>
    </section>
  );
}

function BoardColumn({
  columnKey,
  label,
  count,
  group,
  agent,
  GroupIcon,
  droppable,
  activeDragTask,
  children,
}: {
  columnKey: string;
  label: string;
  count: number;
  group: Group;
  agent?: Agent;
  GroupIcon: LucideIcon;
  droppable: boolean;
  activeDragTask?: BoardTask;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const accepts =
    droppable &&
    !!activeDragTask &&
    ((columnKey === "queued" &&
      canHandOffTask(activeDragTask)) ||
      (columnKey === "todo" &&
        activeDragTask.status !== "todo") ||
      (columnKey === "done" &&
        (activeDragTask.status === "review" ||
          activeDragTask.status === "todo")));

  const { setNodeRef, isOver } = useDroppable({
    id: `column:${columnKey}`,
    disabled: !droppable,
    data: { type: "column", columnKey },
  });

  const dropHint =
    columnKey === "todo"
      ? t("tasks.dropColumnTodo")
      : columnKey === "queued"
        ? t("tasks.dropColumnQueued")
        : columnKey === "done"
          ? t("tasks.dropColumnDone")
          : "";

  return (
    <section
      ref={setNodeRef}
      className="task-board-column"
      data-column={columnKey}
      data-drop-accept={accepts || undefined}
      data-drop-over={(accepts && isOver) || undefined}
    >
      <h2 className="task-board-column-title">
        {group === "status" ? (
          <span
            className="task-dot"
            data-status={columnKey}
            aria-hidden="true"
          />
        ) : agent ? (
          <AgentAvatar agent={agent} size="sm" />
        ) : (
          <GroupIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="truncate" title={label}>
          {label}
        </span>
        <small className="task-board-column-count">{count}</small>
        {accepts && isOver && dropHint && (
          <span className="task-board-column-drop-hint">{dropHint}</span>
        )}
      </h2>
      <div className="task-board-column-scroll">{children}</div>
    </section>
  );
}

function QueuedColumn({
  tasks,
  queueSizes,
  agentMetricsMap,
  pendingReorder,
  onMoveItem,
  onWithdrawItem,
  renderCard,
}: {
  tasks: BoardTask[];
  queueSizes: Map<string, number>;
  agentMetricsMap: Map<string, AgentQueueMetrics>;
  pendingReorder?: { agentId: string; ids: string[] };
  onMoveItem: (agentId: string, queueId: string, delta: -1 | 1) => void;
  onWithdrawItem: (task: BoardTask) => void;
  renderCard: (
    task: BoardTask,
    options?: {
      sortable?: boolean;
      onMoveUp?: () => void;
      onMoveDown?: () => void;
      onWithdraw?: () => void;
    },
  ) => ReactNode;
}) {
  const grouped = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    if (!task.queue) continue;
    const agentId = task.queue.agentId;
    const items = grouped.get(agentId) ?? [];
    items.push(task);
    grouped.set(agentId, items);
  }
  return [...grouped].map(([agentId, groupTasks]) => (
    <QueuedGroup
      key={agentId}
      agentId={agentId}
      tasks={groupTasks}
      queueSize={queueSizes.get(agentId) ?? 0}
      metrics={agentMetricsMap.get(agentId)}
      pendingOrder={
        pendingReorder?.agentId === agentId ? pendingReorder.ids : undefined
      }
      onMoveItem={onMoveItem}
      onWithdrawItem={onWithdrawItem}
      renderCard={renderCard}
    />
  ));
}

function QueuedGroup({
  agentId,
  tasks,
  queueSize,
  metrics,
  pendingOrder,
  onMoveItem,
  onWithdrawItem,
  renderCard,
}: {
  agentId: string;
  tasks: BoardTask[];
  queueSize: number;
  metrics?: AgentQueueMetrics;
  pendingOrder?: string[];
  onMoveItem: (agentId: string, queueId: string, delta: -1 | 1) => void;
  onWithdrawItem: (task: BoardTask) => void;
  renderCard: (
    task: BoardTask,
    options?: {
      sortable?: boolean;
      onMoveUp?: () => void;
      onMoveDown?: () => void;
      onWithdraw?: () => void;
    },
  ) => ReactNode;
}) {
  const { t } = useTranslation();
  const agent = tasks[0].agent;
  const ordered = [...tasks].sort(
    (a, b) => (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity),
  );
  const ids = ordered.flatMap(({ queue }) =>
    queue?.position ? [queue.id] : [],
  );
  const sortable = ids.length > 1 && ids.length === queueSize && !pendingOrder;

  if (
    pendingOrder &&
    ids.length === pendingOrder.length &&
    ids.every((id) => pendingOrder.includes(id))
  ) {
    const ranks = new Map(pendingOrder.map((id, i) => [id, i + 1]));
    for (let i = 0; i < ordered.length; i++) {
      const task = ordered[i];
      if (task.queue?.position) {
        ordered[i] = {
          ...task,
          queue: { ...task.queue, position: ranks.get(task.queue.id) },
        };
      }
    }
    ordered.sort(
      (a, b) =>
        (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity),
    );
  }

  const isPaused = metrics?.paused ?? !!agent?.profile.taskQueuePaused;

  return (
    <div className="task-board-subgroup">
      <h3 className="task-board-subheading">
        {agent && <AgentAvatar agent={agent} size="sm" />}
        <span className="truncate">
          {agent?.name ?? t("tasks.unavailableAgent")}
        </span>
        <span className="task-board-subgroup-stat tabular-nums">
          {isPaused
            ? t("tasks.queuePaused")
            : metrics
              ? `${metrics.running}/${metrics.concurrency}`
              : null}
        </span>
      </h3>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="task-board-cards">
          {ordered.map((task, index) => {
            const queueId = task.queue?.id;
            const canReorder = sortable && !!queueId;
            return renderCard(task, {
              sortable: canReorder,
              onMoveUp:
                canReorder && index > 0
                  ? () => onMoveItem(agentId, queueId, -1)
                  : undefined,
              onMoveDown:
                canReorder && index < ordered.length - 1
                  ? () => onMoveItem(agentId, queueId, 1)
                  : undefined,
              onWithdraw: task.queue ? () => onWithdrawItem(task) : undefined,
            });
          })}
        </ul>
      </SortableContext>
    </div>
  );
}

function TaskCard({
  task,
  group,
  sourceLabel,
  nowMs,
  reminderSettings,
  selected,
  sortable,
  draggable,
  activeDrag,
  waitState,
  agentMetrics,
  pendingRequest,
  approving,
  retrying,
  onOpen,
  onAssign,
  onQuickEnqueue,
  onChangeDeadline,
  onApproveRequest,
  onRetryRun,
  onMoveUp,
  onMoveDown,
  onWithdraw,
  onAccept,
  onAcceptAndEnqueue,
  onQuickComplete,
}: {
  task: BoardTask;
  group: Group;
  sourceLabel: string;
  nowMs: number;
  reminderSettings: TaskReminderSettings;
  selected: boolean;
  sortable: boolean;
  draggable: boolean;
  activeDrag?: ActiveCardDrag;
  waitState?: ReturnType<typeof queueWaitState>;
  agentMetrics?: AgentQueueMetrics;
  pendingRequest?: Request;
  approving?: boolean;
  retrying?: boolean;
  onOpen: TaskCardAction;
  onAssign: TaskCardAction;
  onQuickEnqueue: (task: BoardTask, trigger?: HTMLButtonElement) => void;
  onChangeDeadline?: (next: TaskDeadlineInput | null) => void;
  onApproveRequest?: () => void;
  onRetryRun?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onWithdraw?: () => void;
  onAccept?: () => void;
  onAcceptAndEnqueue?: (trigger: HTMLButtonElement) => void;
  onQuickComplete?: () => void;
}) {
  const { t } = useTranslation();
  const dragId = task.queue?.id ?? `card:${task.id}`;
  const useSortableMode = sortable && !!task.queue?.position;
  const sortableHook = useSortable({
    id: dragId,
    disabled: !useSortableMode,
    data: { task, queueAgentId: task.queue?.agentId },
  });
  const draggableHook = useDraggable({
    id: dragId,
    disabled: useSortableMode || !draggable,
    data: { task },
  });

  const isDragging = useSortableMode
    ? sortableHook.isDragging
    : draggableHook.isDragging;
  const setNodeRef = useSortableMode
    ? sortableHook.setNodeRef
    : draggableHook.setNodeRef;
  const setActivatorNodeRef = useSortableMode
    ? sortableHook.setActivatorNodeRef
    : draggableHook.setActivatorNodeRef;
  const attributes = useSortableMode
    ? sortableHook.attributes
    : draggableHook.attributes;
  const listeners = useSortableMode
    ? sortableHook.listeners
    : draggableHook.listeners;
  const transform = useSortableMode ? sortableHook.transform : null;
  const transition = useSortableMode ? sortableHook.transition : undefined;

  const cardRef = useCallback(
    (node: HTMLLIElement | null) => {
      setNodeRef(node);
      if (selected) revealCard(node);
    },
    [setNodeRef, selected],
  );

  const project = group === "project" ? "" : task.project;
  const context =
    project || (!task.reference && (task.noteTitle || sourceLabel));
  const showNote = !!project && !!task.noteTitle && project !== task.noteTitle;
  const runStatus =
    (task.status === "running" || task.status === "attention" ||
      (task.status === "todo" && hasUnfinishedTaskRun(task.execution))) &&
    task.execution?.status;
  const showStatus = group !== "status" && (!runStatus || task.status === "todo");
  const groupedQueue = group === "status" && task.status === "queued";
  const queueRank = task.queue?.position ? `#${task.queue.position}` : undefined;
  const isFailed =
    (task.status === "attention" &&
      (task.execution?.status === "failed" || task.execution?.status === "interrupted")) ||
    !!task.queue?.error;

  const floatingRect =
    isDragging && activeDrag?.id === dragId ? activeDrag.rect : undefined;

  const waitLabel =
    waitState?.kind === "paused"
      ? t("tasks.waitReason.paused")
      : waitState?.kind === "slots"
        ? agentMetrics
          ? t("tasks.waitReason.slotsCount", {
              running: agentMetrics.running,
              concurrency: agentMetrics.concurrency,
            })
          : t("tasks.waitReason.slots")
        : waitState?.kind === "cooldown"
          ? t("tasks.waitReason.cooldown", {
              time: formatWaitDuration(waitState.remainingMs, t),
            })
          : undefined;

  const canDrag = useSortableMode || draggable;

  return (
    <li
      ref={cardRef}
      className="task-board-card-slot"
      data-dragging={isDragging || undefined}
      style={
        floatingRect
          ? { height: floatingRect.height }
          : useSortableMode
            ? {
                transform: CSS.Transform.toString(
                  transform && { ...transform, x: 0 },
                ),
                transition,
              }
            : undefined
      }
    >
      <div
        className="task-board-card"
        data-selected={selected}
        data-dragging={isDragging || undefined}
        data-status={task.status}
        data-attention={(needsAttention(task) && !isFailed) || undefined}
        data-failed={isFailed || undefined}
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
        <Button
          ref={canDrag ? setActivatorNodeRef : undefined}
          {...(canDrag ? attributes : {})}
          {...(canDrag ? listeners : {})}
          variant="ghost"
          className="task-board-card-open"
          aria-haspopup="dialog"
          aria-expanded={selected}
          onClick={(event) => onOpen(task, event.currentTarget)}
        >
          <span className="task-board-card-meta">
            <span className="task-board-card-context">
              {task.priority && <TaskPriorityIcon priority={task.priority} />}
              {context && (
                <span className="truncate" title={context}>
                  {context}
                </span>
              )}
              {task.reference && (
                <span className="shrink-0 font-mono">{task.reference}</span>
              )}
            </span>
            <span className="task-board-card-badges">
              {groupedQueue && queueRank && (
                <span className="task-board-card-position font-mono">
                  {queueRank}
                </span>
              )}
              {runStatus && <RunStatus status={runStatus} />}
              {!runStatus && task.status === "review" && (
                <span className="task-status-chip" data-status="review">
                  {t("tasks.status.review")}
                </span>
              )}
              {!runStatus && task.status === "unconfirmed" && (
                <span className="task-status-chip">
                  {t("tasks.status.unconfirmed")}
                </span>
              )}
              {!runStatus && task.queue?.error && (
                <span className="task-status-chip" data-status="failed">
                  {t("tasks.status.attention")}
                </span>
              )}
            </span>
          </span>
          <span
            className="task-board-card-title line-clamp-2"
            title={task.title}
          >
            {task.title}
          </span>
          {(showStatus || showNote || task.remote) && (
            <span className="task-board-card-tags">
              {showStatus && (
                <span className="task-status-chip" data-status={task.status}>
                  <span
                    className="task-dot"
                    data-status={task.status}
                    aria-hidden="true"
                  />
                  {t("tasks.status." + task.status)}
                </span>
              )}
              {showNote && (
                <span className="task-list-tag truncate" title={task.noteTitle}>
                  {task.noteTitle}
                </span>
              )}
              {task.remote && (
                <span className="task-list-tag">
                  {t("tasks.remote." + task.remote)}
                </span>
              )}
            </span>
          )}
        </Button>

        {pendingRequest && (
          <div className="task-card-approval-strip">
            <span
              className="task-card-strip-text truncate"
              title={pendingRequest.detail || pendingRequest.title}
            >
              <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{pendingRequest.title}</span>
            </span>
            {onApproveRequest && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="task-card-micro-btn task-btn-positive"
                disabled={approving}
                onClick={onApproveRequest}
              >
                {t("tasks.approveQuick")}
              </Button>
            )}
          </div>
        )}

        {!pendingRequest && isFailed && (
          <div className="task-card-retry-strip">
            <span className="task-card-strip-text truncate">
              {task.queue?.error ||
                t("status." + (task.execution?.status ?? "failed"))}
            </span>
            {onRetryRun && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="task-card-micro-btn task-btn-danger"
                disabled={retrying}
                onClick={onRetryRun}
              >
                {t("tasks.retryQuick")}
              </Button>
            )}
          </div>
        )}

        {task.status === "queued" && !task.queue?.error && (
          <div className="task-card-queue-row">
            <span
              className="task-board-card-wait truncate"
              data-reason={waitState?.kind}
            >
              {waitLabel || t("tasks.waitReason.ready")}
            </span>
            {groupedQueue && (onMoveUp || onMoveDown || onWithdraw) && (
              <span className="task-card-queue-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="task-card-queue-btn"
                  disabled={!onMoveUp}
                  aria-label={t("tasks.moveUp")}
                  title={t("tasks.moveUp")}
                  onClick={onMoveUp}
                >
                  <ChevronUp className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="task-card-queue-btn"
                  disabled={!onMoveDown}
                  aria-label={t("tasks.moveDown")}
                  title={t("tasks.moveDown")}
                  onClick={onMoveDown}
                >
                  <ChevronDown className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="task-card-queue-btn"
                  disabled={!onWithdraw}
                  aria-label={t("tasks.withdraw")}
                  title={t("tasks.withdraw")}
                  onClick={onWithdraw}
                >
                  <Undo2 className="size-3" />
                </Button>
              </span>
            )}
          </div>
        )}

        {task.deadline && (
          <div className="task-board-card-deadline-row">
            <TaskDeadlineBadge
              deadline={task.deadline}
              nowMs={nowMs}
              defaultRemindOffsets={reminderSettings.defaultRemindOffsets}
              allDayReminderTime={reminderSettings.allDayReminderTime}
              editable={!!onChangeDeadline}
              onChange={onChangeDeadline}
            />
          </div>
        )}

        <div className="task-board-card-footer">
          {groupedQueue ? (
            <span className="task-board-card-source truncate">
              {sourceLabel}
            </span>
          ) : (
            <TaskAssignee agent={task.agent} assigned={!!task.agentId} />
          )}

          {task.status === "unconfirmed" && (onAccept || onAcceptAndEnqueue) ? (
            <span className="task-card-footer-actions">
              {onAccept && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="task-card-micro-btn"
                  onClick={onAccept}
                >
                  {t("tasks.acceptTask")}
                </Button>
              )}
              {onAcceptAndEnqueue && (
                <Button
                  type="button"
                  size="xs"
                  className="task-card-micro-btn"
                  onClick={(event) => onAcceptAndEnqueue(event.currentTarget)}
                >
                  {t("tasks.acceptAndEnqueue")}
                </Button>
              )}
            </span>
          ) : canHandOffTask(task) ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="task-card-micro-btn task-card-inline-action"
              aria-label={t("tasks.assign")}
              title={t("tasks.assign")}
              aria-haspopup={task.agentId ? undefined : "dialog"}
              onClick={(event) => {
                if (task.agentId) onQuickEnqueue(task, event.currentTarget);
                else onAssign(task, event.currentTarget);
              }}
            >
              <Play className="size-2.5 fill-current" aria-hidden="true" />
              {t("tasks.enqueue")}
            </Button>
          ) : onQuickComplete ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="task-card-micro-btn task-btn-positive"
              aria-label={t("tasks.complete")}
              title={t("tasks.complete")}
              onClick={onQuickComplete}
            >
              <Check className="size-3" aria-hidden="true" />
              {t("tasks.reviewQuick")}
            </Button>
          ) : !groupedQueue && queueRank ? (
            <span className="task-board-card-position font-mono">
              {queueRank}
            </span>
          ) : !groupedQueue && task.execution?.activityAt ? (
            <ActivityTime timestamp={task.execution.activityAt} compact />
          ) : null}
          <TaskBoardActions task={task} status={task.status} />
        </div>
      </div>
    </li>
  );
}

function revealCard(card: HTMLLIElement | null) {
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
