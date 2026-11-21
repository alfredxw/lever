import { useCallback, useMemo, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Bookmark,
  CircleCheck,
  CircleAlert,
  CircleDot,
  FileText,
  Folder,
  GitPullRequest,
  LayoutGrid,
  NotebookPen,
  UserRound,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import {
  TaskSourceKindIssue,
  TaskSourceKindPR,
  type Agent,
  type ExternalTask,
  type Plugin,
  type TaskExecution,
  type TaskNoteSummary,
  type TaskQueueEntry,
  type TaskView,
  type TaskWorkflow,
  type WorkItem,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { RunStatus } from "@/features/chat/RunStatus";
import { ActivityTime } from "@/components/workbench/ActivityTime";
import { TaskAssignee } from "./TaskAssignee";
import { TaskBoardFilter } from "./TaskBoardFilter";
import { TaskStatusIcon, taskStatuses } from "./TaskStatusIcon";
import {
  taskBlocks,
  taskImages,
  taskNoteSchema,
  taskStatus,
  type TaskStatus,
} from "./taskDocument";
import type { TaskDispatchTarget } from "./useTaskDispatch";
import { taskNoteQuery } from "./noteQueries";
import { useTaskDrafts } from "./useTaskNote";

type Group = TaskView["group"];
export type BoardView = Pick<TaskView, "group" | "filters" | "quickFilter">;

const groups = {
  status: CircleDot,
  project: Folder,
  agent: UserRound,
} satisfies Record<Group, LucideIcon>;

type BoardTask = TaskDispatchTarget & {
  status: TaskStatus;
  noteTitle?: string;
  agent?: Agent;
  execution?: TaskExecution;
  queue?: TaskQueueEntry;
  project: string;
  source: string;
  kind?: string;
  remote?: string;
  reference?: string;
};

const columnsByStatus = [
  "todo",
  "queued",
  "running",
  "review",
  "done",
] as const;

function taskColumn(status: TaskStatus) {
  if (status === "unconfirmed") return "todo";
  if (status === "attention") return "running";
  return status;
}

function needsAttention(task: BoardTask) {
  return task.status === "attention" || !!task.queue?.error;
}

type TaskCardAction = (
  task: TaskDispatchTarget,
  trigger: HTMLButtonElement,
) => void;

export function TaskBoard({
  name,
  notes,
  noteList,
  agents,
  executions,
  workflows,
  view,
  search,
  selectedTaskId,
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
  notes: TaskNoteSummary[];
  noteList: { isPending: boolean; error: Error | null; refetch: () => void };
  agents: Agent[];
  executions: Map<string, TaskExecution>;
  workflows: Map<string, TaskWorkflow>;
  view: BoardView;
  search: string;
  selectedTaskId?: string;
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
  const { group, filters, quickFilter } = view;
  const setFilters = (filters: BoardView["filters"]) =>
    onViewChange({ group, filters, quickFilter });
  const drafts = useTaskDrafts();
  const results = useQueries({
    queries: notes.map((note) => taskNoteQuery(note.id)),
    combine: (queries) => ({
      documents: queries.flatMap((query) => (query.data ? [query.data] : [])),
      pending: queries.some((query) => query.isPending),
      failed: queries.find((query) => query.isError),
    }),
  });
  const external = useQuery({
    queryKey: ["external-tasks"],
    queryFn: ({ signal }) =>
      api<ExternalTask[]>("/tasks/external", undefined, "GET", signal),
    refetchOnWindowFocus: true,
  });
  const workItems = useQuery({
    queryKey: ["work-items"],
    queryFn: ({ signal }) =>
      api<WorkItem[]>("/tasks/work-items", undefined, "GET", signal),
  });
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: ({ signal }) =>
      api<Plugin[]>("/plugins", undefined, "GET", signal),
  });
  const sourceLabels = new Map([
    ["written", t("tasks.source.written")],
    ["agent", t("tasks.source.agent")],
    ["github", t("tasks.source.github")],
    ["automation", t("automations.title")],
    ...(plugins.data?.flatMap((plugin) =>
      (plugin.manifest.contributes.taskSources ?? []).map(
        ({ id, name }) => [id, name] as const,
      ),
    ) ?? []),
  ]);
  const tasks = useMemo(() => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    function cardState(
      task: { id: string; done: boolean },
      assignee?: string,
      proposed = false,
    ) {
      const execution = executions.get(task.id);
      const workflow = workflows.get(task.id);
      const queue = !execution ? workflow?.queue : undefined;
      const agentId = execution?.agentId ?? queue?.agentId ?? assignee;
      return {
        status: taskStatus(task, execution, workflow, proposed),
        agentId,
        agent: agentsById.get(agentId ?? ""),
        queue,
        execution,
      };
    }
    const written = results.documents.flatMap((saved) => {
      const draft = drafts.get(saved.id);
      const note = draft?.note ?? saved;
      const noteTitle = note.title.trim() || t("tasks.note");
      return taskBlocks(
        draft?.doc ?? taskNoteSchema.nodeFromJSON(note.content),
      ).flatMap((task): BoardTask[] => {
        if (!task.id || !task.title) return [];
        return [
          {
            id: task.id,
            record: "note",
            title: task.title,
            ...cardState({ id: task.id, done: task.done }, task.agentId),
            noteId: note.id,
            noteTitle,
            images: taskImages(task),
            project: task.issue?.repository || note.project || "",
            source: task.issue ? "github" : "written",
            kind: task.issue ? "issue" : undefined,
          },
        ];
      });
    });
    const synced = (external.data ?? []).map(
      (task): BoardTask => ({
        id: task.id,
        record: "external",
        title: task.title,
        ...cardState(task),
        project: task.project,
        source: task.source,
        kind: task.kind,
        remote: task.state,
        reference: task.reference,
      }),
    );
    const automated: BoardTask[] = [];
    for (const execution of executions.values()) {
      if (!execution.automationId || !execution.title) continue;
      automated.push({
        id: execution.taskId,
        record: "automation",
        title: execution.title,
        status: taskStatus(execution, execution),
        agentId: execution.agentId,
        agent: agentsById.get(execution.agentId),
        project: "",
        source: "automation",
        execution,
      });
    }
    const native = (workItems.data ?? []).map(
      (item): BoardTask => ({
        id: item.id,
        record: "workItem",
        title: item.title,
        ...cardState(item, item.assigneeAgentId, true),
        project: "",
        source: "agent",
      }),
    );
    return [...native, ...written, ...synced, ...automated];
  }, [
    results.documents,
    drafts,
    executions,
    workflows,
    agents,
    t,
    external.data,
    workItems.data,
  ]);

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

  const term = search.trim().toLocaleLowerCase();
  const scoped = tasks.filter((task) => {
    if (task.status === "closed" && !filters.status?.includes("closed"))
      return false;
    if (
      !filters.remote?.length &&
      !term &&
      task.remote &&
      task.remote !== "open" &&
      task.status === "todo" &&
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
    const matchesFilters = (
      Object.keys(values) as (keyof typeof values)[]
    ).every(
      (key) => !filters[key]?.length || filters[key].includes(values[key]),
    );
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
  const shown = scoped.filter(
    (task) =>
      !filters.status?.length ||
      filters.status.some(
        (status) =>
          status === task.status ||
          status === taskColumn(task.status) ||
          (status === "attention" && needsAttention(task)),
      ),
  );
  const attentionCount = scoped.filter(needsAttention).length;
  const onlyAttention =
    filters.status?.length === 1 && filters.status[0] === "attention";
  const queueSizes = new Map<string, number>();
  for (const { queue } of workflows.values()) {
    if (queue?.position)
      queueSizes.set(
        queue.agentId,
        Math.max(queueSizes.get(queue.agentId) ?? 0, queue.position),
      );
  }

  const columns = new Map<string, { label: string; tasks: BoardTask[] }>();
  if (group === "status") {
    const visibleColumns = new Set(
      shown.map(({ status }) => taskColumn(status)),
    );
    for (const status of [...columnsByStatus, "closed"] as const) {
      if (filters.status?.length) {
        if (!visibleColumns.has(status) && !filters.status.includes(status))
          continue;
      } else if (status === "closed") continue;
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
  const filterCount = Object.values(filters).reduce(
    (count, values) => count + values.length,
    0,
  );
  const GroupIcon = groups[group];
  const loading =
    noteList.isPending ||
    results.pending ||
    external.isPending ||
    workItems.isPending;
  const failed = [noteList, results.failed, external, workItems].find(
    (source) => source?.error,
  );

  function renderCard(task: BoardTask, sortable = false) {
    return (
      <TaskCard
        key={task.id}
        task={task}
        group={group}
        sourceLabel={sourceLabels.get(task.source) ?? task.source}
        selected={task.id === selectedTaskId}
        sortable={sortable}
        onOpen={onOpen}
        onAssign={onAssign}
      />
    );
  }

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
    ) : (
      <div className="task-board-columns" data-group={group}>
        {[...columns].map(([key, { label, tasks }]) => {
          const agent = group === "agent" ? tasks[0]?.agent : undefined;
          return (
            <section className="task-board-column" key={key}>
              <h2 className="task-board-column-title">
                {group === "status" ? (
                  <TaskStatusIcon status={key as TaskStatus} />
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
                <small className="task-board-column-count">
                  {tasks.length}
                </small>
              </h2>
              <div className="task-board-column-scroll">
                {group === "status" && key === "queued" ? (
                  <QueuedColumn
                    tasks={tasks}
                    queueSizes={queueSizes}
                    renderCard={renderCard}
                  />
                ) : (
                  <>
                    {group === "status" &&
                      key === "todo" &&
                      tasks.some(({ status }) => status === "unconfirmed") && (
                        <div className="task-board-subgroup">
                          <h3 className="task-board-subheading">
                            <TaskStatusIcon status="unconfirmed" />
                            {t("tasks.status.unconfirmed")}
                          </h3>
                          <ul className="task-board-cards">
                            {tasks
                              .filter(({ status }) => status === "unconfirmed")
                              .map((task) => renderCard(task))}
                          </ul>
                        </div>
                      )}
                    <ul className="task-board-cards">
                      {(group === "status" && key === "todo"
                        ? tasks.filter(({ status }) => status !== "unconfirmed")
                        : group === "status" && key === "running"
                          ? [...tasks].sort(
                              (a, b) =>
                                Number(needsAttention(b)) -
                                Number(needsAttention(a)),
                            )
                          : tasks
                      ).map((task) => renderCard(task))}
                    </ul>
                  </>
                )}
              </div>
            </section>
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
          {(attentionCount > 0 || onlyAttention) && (
            <Button
              variant="outline"
              aria-pressed={onlyAttention}
              data-filtered={onlyAttention}
              onClick={() =>
                setFilters({
                  ...filters,
                  status: onlyAttention ? undefined : ["attention"],
                })
              }
            >
              <CircleAlert data-icon="inline-start" />
              {t("tasks.status.attention")}
              <span className="task-board-count">{attentionCount}</span>
            </Button>
          )}
          <TaskBoardFilter
            filters={filters}
            count={filterCount}
            quickFilter={quickFilter}
            onChange={setFilters}
            onQuickFilterChange={(quickFilter) =>
              onViewChange({ group, filters, quickFilter })
            }
            onSaveAs={onSaveAs}
            fields={[
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
            className="task-board-group"
            aria-label={t("tasks.group")}
            value={group}
            onValueChange={(value) => {
              if (value)
                onViewChange({ group: value as Group, filters, quickFilter });
            }}
          >
            {Object.keys(groups).map((id) => (
              <ToggleGroupItem key={id} value={id}>
                {t("tasks.group." + id)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </header>
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
    </section>
  );
}

function QueuedColumn({
  tasks,
  queueSizes,
  renderCard,
}: {
  tasks: BoardTask[];
  queueSizes: Map<string, number>;
  renderCard: (task: BoardTask, sortable?: boolean) => ReactNode;
}) {
  const grouped = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    if (!task.queue) continue;
    const agentId = task.queue.agentId;
    const items = grouped.get(agentId) ?? [];
    items.push(task);
    grouped.set(agentId, items);
  }
  return [...grouped].map(([agentId, tasks]) => (
    <QueuedGroup
      key={agentId}
      agentId={agentId}
      tasks={tasks}
      queueSize={queueSizes.get(agentId) ?? 0}
      renderCard={renderCard}
    />
  ));
}

function QueuedGroup({
  agentId,
  tasks,
  queueSize,
  renderCard,
}: {
  agentId: string;
  tasks: BoardTask[];
  queueSize: number;
  renderCard: (task: BoardTask, sortable?: boolean) => ReactNode;
}) {
  const { t } = useTranslation();
  const agent = tasks[0].agent;
  const ordered = [...tasks].sort(
    (a, b) => (a.queue?.position ?? Infinity) - (b.queue?.position ?? Infinity),
  );
  const ids = ordered.flatMap(({ queue }) =>
    queue?.position ? [queue.id] : [],
  );
  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api("/tasks/queue/order", { agentId, ids }, "PUT"),
    onError: (error) => toast.error(error.message),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["task-workflows"] }),
  });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: { y: 10 } } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const sortable =
    ids.length > 1 && ids.length === queueSize && !reorder.isPending;
  const pendingOrder = reorder.isPending ? reorder.variables : undefined;
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

  return (
    <div className="task-board-subgroup">
      <h3 className="task-board-subheading">
        {agent && <AgentAvatar agent={agent} size="sm" />}
        <span className="truncate">
          {agent?.name ?? t("tasks.unavailableAgent")}
        </span>
      </h3>
      <DndContext
        id={`task-queue-${agentId}`}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={({ active, over }) => {
          if (!sortable || !over || active.id === over.id) return;
          const from = ids.indexOf(String(active.id));
          const to = ids.indexOf(String(over.id));
          if (from >= 0 && to >= 0) reorder.mutate(arrayMove(ids, from, to));
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="task-board-cards">
            {ordered.map((task) =>
              renderCard(task, sortable && !!task.queue?.position),
            )}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function TaskCard({
  task,
  group,
  sourceLabel,
  selected,
  sortable,
  onOpen,
  onAssign,
}: {
  task: BoardTask;
  group: Group;
  sourceLabel: string;
  selected: boolean;
  sortable: boolean;
  onOpen: TaskCardAction;
  onAssign: TaskCardAction;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    setNodeRef,
    setActivatorNodeRef,
  } = useSortable({ id: task.queue?.id ?? task.id, disabled: !sortable });
  const cardRef = useCallback(
    (node: HTMLLIElement | null) => {
      setNodeRef(node);
      if (selected) revealCard(node);
    },
    [setNodeRef, selected],
  );
  const SourceIcon =
    task.source === "automation"
      ? Zap
      : task.record === "workItem"
        ? UserRound
        : task.kind === "pr"
          ? GitPullRequest
          : task.kind === "issue"
            ? CircleDot
            : FileText;
  const project = group === "project" ? "" : task.project;
  const context =
    project || (!task.reference && (task.noteTitle || sourceLabel));
  const showNote = !!project && !!task.noteTitle && project !== task.noteTitle;
  const runStatus =
    (task.status === "running" || task.status === "attention") &&
    task.execution?.status;
  const showStatus = group !== "status" && !runStatus;
  const canAssign = task.status === "todo" || task.status === "unconfirmed";
  const groupedQueue = group === "status" && task.status === "queued";
  const queuePosition = task.queue?.position
    ? t("tasks.queuePosition", { count: task.queue.position })
    : undefined;
  return (
    <li
      ref={cardRef}
      className="task-board-card"
      data-selected={selected}
      {...(sortable ? listeners : {})}
      style={
        sortable
          ? {
              transform: CSS.Transform.toString(
                transform && { ...transform, x: 0 },
              ),
              transition,
              zIndex: isDragging ? 1 : undefined,
            }
          : undefined
      }
    >
      <Button
        ref={sortable ? setActivatorNodeRef : undefined}
        {...(sortable ? attributes : {})}
        variant="ghost"
        className="task-board-card-open"
        aria-haspopup="dialog"
        aria-expanded={selected}
        onClick={(event) => onOpen(task, event.currentTarget)}
      >
        <span className="task-board-card-meta">
          <span className="task-board-card-context">
            <SourceIcon className="size-3.5" aria-hidden="true" />
            {context && (
              <span className="truncate" title={context}>
                {context}
              </span>
            )}
            {task.reference && (
              <span className="shrink-0">{task.reference}</span>
            )}
          </span>
          {runStatus && <RunStatus status={runStatus} />}
          {groupedQueue && queuePosition && (
            <span className="task-board-card-position">{queuePosition}</span>
          )}
          {task.queue?.error && (
            <Badge variant="outline">
              <TaskStatusIcon status="attention" />
              {t("tasks.status.attention")}
            </Badge>
          )}
        </span>
        <span className="task-board-card-title line-clamp-3" title={task.title}>
          {task.title}
        </span>
        {(showStatus || showNote || task.remote) && (
          <span className="task-board-card-tags">
            {showStatus && (
              <Badge variant="secondary">
                <TaskStatusIcon status={task.status} />
                {t("tasks.status." + task.status)}
              </Badge>
            )}
            {showNote && (
              <Badge
                variant="secondary"
                className="min-w-0 shrink"
                title={task.noteTitle}
              >
                <span className="truncate">{task.noteTitle}</span>
              </Badge>
            )}
            {task.remote && (
              <Badge variant="secondary">
                {t("tasks.remote." + task.remote)}
              </Badge>
            )}
          </span>
        )}
        {!groupedQueue && (
          <span className="task-board-card-footer">
            <TaskAssignee agent={task.agent} assigned={!!task.agentId} />
            {queuePosition ? (
              <span className="task-board-card-position">{queuePosition}</span>
            ) : (
              <ActivityTime
                timestamp={task.execution?.activityAt}
                compact
              />
            )}
          </span>
        )}
      </Button>
      {canAssign && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="task-board-card-assign"
          aria-label={t("tasks.assign")}
          title={t("tasks.assign")}
          aria-haspopup="dialog"
          onClick={(event) => onAssign(task, event.currentTarget)}
        >
          <ArrowUpRight />
        </Button>
      )}
    </li>
  );
}

function revealCard(card: HTMLLIElement | null) {
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
