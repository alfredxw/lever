import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Transform } from "@tiptap/pm/transform";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { active, api, queryClient } from "@/api/client";
import type {
  Agent,
  ExternalTask,
  Plugin,
  Request,
  TaskExecution,
  TaskNote,
  TaskNoteSummary,
  TaskQueueEntry,
  TaskWorkflow,
  WorkItem,
  WorkItemPriority,
} from "@/api/types.gen";
import { taskNoteQuery } from "./noteQueries";
import {
  taskBlocks,
  taskImages,
  taskNoteSchema,
  taskStatus,
  type TaskStatus,
} from "./taskDocument";
import type { TaskDispatchTarget, TaskTarget } from "./useTaskDispatch";
import {
  changeTaskNoteDocument,
  noteDraftDocument,
  saveTaskNote,
  TaskNoteConflict,
  taskNoteSnapshot,
  useTaskDrafts,
} from "./useTaskNote";

import {
  defaultReminderSettings,
  resolveTaskDeadline,
  useTaskDeadlines,
  useTaskReminderSettings,
  type EffectiveTaskDeadline,
} from "./taskDeadlines";

export type BoardTask = TaskDispatchTarget & {
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
  priority?: WorkItemPriority | "";
  createdByAgentId?: string;
  body?: string;
  updatedAt?: string;
  deadline?: EffectiveTaskDeadline;
};

export const columnsByStatus = [
  "todo",
  "queued",
  "running",
  "review",
  "done",
] as const;

export function taskColumn(status: TaskStatus) {
  if (status === "unconfirmed") return "todo";
  if (status === "attention") return "running";
  return status;
}

export function needsAttention(task: BoardTask) {
  return task.status === "attention" || !!task.queue?.error;
}

export function hasUnfinishedTaskRun(execution?: TaskExecution) {
  return !!execution && (active(execution.status) || execution.status === "paused" || execution.status === "queued");
}

export function canHandOffTask(task: Pick<BoardTask, "record" | "status" | "execution">) {
  return task.record !== "automation" &&
    (task.status === "todo" || task.status === "unconfirmed") &&
    !hasUnfinishedTaskRun(task.execution);
}

export function isActiveConsumption(task: BoardTask) {
  return (
    task.status === "running" ||
    task.status === "attention" ||
    task.status === "queued"
  );
}

export function pendingRequestRunIds(requests: Request[]) {
  const ids = new Set<string>();
  for (const request of requests) {
    if (request.status === "pending" && request.runId) ids.add(request.runId);
  }
  return ids;
}

export type InboxReason =
  | "request"
  | "attention"
  | "deadline"
  | "review"
  | "unconfirmed";

export function taskInboxReason(
  task: BoardTask,
  requestRunIds: ReadonlySet<string>,
): InboxReason | undefined {
  if (task.status === "closed") return undefined;
  if (task.execution?.runId && requestRunIds.has(task.execution.runId))
    return "request";
  if (needsAttention(task)) return "attention";
  if (task.deadline?.attentionActive) return "deadline";
  if (task.status === "review") return "review";
  if (task.status === "unconfirmed") return "unconfirmed";
  return undefined;
}

const inboxRank: Record<InboxReason, number> = {
  request: 0,
  attention: 1,
  deadline: 2,
  review: 3,
  unconfirmed: 4,
};

const priorityOrder: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function priorityRank(priority?: string) {
  return priority && priority in priorityOrder ? priorityOrder[priority] : 4;
}

export function compareTasksByDeadline(a: BoardTask, b: BoardTask) {
  const dueA = a.deadline?.dueAt ?? 0;
  const dueB = b.deadline?.dueAt ?? 0;
  if (dueA > 0 && dueB > 0) {
    if (dueA !== dueB) return dueA - dueB;
  } else if (dueA > 0) {
    return -1;
  } else if (dueB > 0) {
    return 1;
  }
  const unconfirmedDiff =
    Number(b.status === "unconfirmed") - Number(a.status === "unconfirmed");
  if (unconfirmedDiff !== 0) return unconfirmedDiff;
  const prioDiff = priorityRank(a.priority) - priorityRank(b.priority);
  if (prioDiff !== 0) return prioDiff;
  const timeA = a.updatedAt ?? "";
  const timeB = b.updatedAt ?? "";
  return timeB.localeCompare(timeA);
}

export function compareTasksByPriority(a: BoardTask, b: BoardTask) {
  const unconfirmedDiff =
    Number(b.status === "unconfirmed") - Number(a.status === "unconfirmed");
  if (unconfirmedDiff !== 0) return unconfirmedDiff;
  const prioDiff = priorityRank(a.priority) - priorityRank(b.priority);
  if (prioDiff !== 0) return prioDiff;
  const dueA = a.deadline?.dueAt ?? 0;
  const dueB = b.deadline?.dueAt ?? 0;
  if (dueA > 0 && dueB > 0 && dueA !== dueB) return dueA - dueB;
  if (dueA > 0) return -1;
  if (dueB > 0) return 1;
  return 0;
}

export function sortInboxTasks(
  tasks: BoardTask[],
  requestRunIds: ReadonlySet<string>,
) {
  return tasks
    .filter((task) => taskInboxReason(task, requestRunIds) !== undefined)
    .sort((a, b) => {
      const rankDiff =
        inboxRank[taskInboxReason(a, requestRunIds)!] -
        inboxRank[taskInboxReason(b, requestRunIds)!];
      if (rankDiff !== 0) return rankDiff;
      const dueA = a.deadline?.dueAt ?? 0;
      const dueB = b.deadline?.dueAt ?? 0;
      if (dueA > 0 && dueB > 0 && dueA !== dueB) return dueA - dueB;
      if (dueA > 0 && dueB === 0) return -1;
      if (dueB > 0 && dueA === 0) return 1;
      const prioDiff = priorityRank(a.priority) - priorityRank(b.priority);
      if (prioDiff !== 0) return prioDiff;
      const timeA = a.execution?.activityAt ?? a.updatedAt ?? "";
      const timeB = b.execution?.activityAt ?? b.updatedAt ?? "";
      return timeB.localeCompare(timeA);
    });
}

export type AgentQueueMetrics = {
  agent: Agent;
  running: number;
  concurrency: number;
  queued: number;
  queueErrors: number;
  attention: number;
  paused: boolean;
  intervalMinutes: number;
  nextStartAt: number;
};

export function buildAgentQueueMetrics(
  agents: Agent[],
  tasks: BoardTask[],
  workflows: Map<string, TaskWorkflow>,
  requestRunIds: ReadonlySet<string>,
): AgentQueueMetrics[] {
  const byAgent = new Map<string, AgentQueueMetrics>();
  for (const agent of agents) {
    if (agent.archived) continue;
    byAgent.set(agent.id, {
      agent,
      running: 0,
      concurrency: Math.max(1, agent.profile.taskConcurrency ?? 1),
      queued: 0,
      queueErrors: 0,
      attention: 0,
      paused: !!agent.profile.taskQueuePaused,
      intervalMinutes: agent.profile.taskStartIntervalMinutes ?? 0,
      nextStartAt: 0,
    });
  }
  for (const task of tasks) {
    const id = task.agentId;
    if (!id) continue;
    const metrics = byAgent.get(id);
    if (!metrics) continue;
    if (
      task.execution &&
      (active(task.execution.status) || task.execution.status === "queued")
    ) {
      metrics.running += 1;
    }
    if (
      needsAttention(task) ||
      (task.execution?.runId && requestRunIds.has(task.execution.runId))
    ) {
      metrics.attention += 1;
    }
  }
  for (const { queue } of workflows.values()) {
    if (!queue) continue;
    const metrics = byAgent.get(queue.agentId);
    if (!metrics) continue;
    if (queue.error) {
      metrics.queueErrors += 1;
    } else {
      metrics.queued += 1;
      if (queue.nextStartAt && queue.nextStartAt > metrics.nextStartAt) {
        metrics.nextStartAt = queue.nextStartAt;
      }
    }
  }
  return [...byAgent.values()];
}

export type QueueWaitState =
  | { kind: "error"; message: string }
  | { kind: "paused" }
  | { kind: "cooldown"; remainingMs: number }
  | { kind: "slots" }
  | { kind: "ready" };

export function queueWaitState(
  queue: TaskQueueEntry | undefined,
  metrics: AgentQueueMetrics | undefined,
  nowMs: number,
): QueueWaitState | undefined {
  if (!queue) return undefined;
  if (queue.error) return { kind: "error", message: queue.error };
  if (metrics?.paused) return { kind: "paused" };
  if (metrics && metrics.running >= metrics.concurrency)
    return { kind: "slots" };
  if (queue.nextStartAt && queue.nextStartAt > nowMs) {
    return { kind: "cooldown", remainingMs: queue.nextStartAt - nowMs };
  }
  return { kind: "ready" };
}

export function formatWaitDuration(ms: number, t?: TFunction) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60)
    return t ? t("chat.durationSeconds", { count: seconds }) : `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return t ? t("chat.durationMinutes", { count: minutes }) : `${minutes}m`;
}

export async function setTaskDoneState(
  target: TaskTarget,
  done: boolean,
  sourceRemovedMessage: string,
) {
  const { id, record, noteId } = target;
  if (record === "automation") {
    await api("/tasks/automation-runs/" + id, { done }, "PATCH");
  } else if (record === "workItem") {
    await api("/tasks/work-items/" + id, { done }, "PATCH");
  } else if (record === "external") {
    await api("/tasks/external/" + id, { done }, "PUT");
  } else {
    if (!noteId) throw new Error(sourceRemovedMessage);
    const note =
      queryClient.getQueryData<TaskNote>(["task-note", noteId]) ??
      (await queryClient.fetchQuery(taskNoteQuery(noteId)));
    if (!note) throw new Error(sourceRemovedMessage);
    const snapshot = taskNoteSnapshot(note);
    if (snapshot.error instanceof TaskNoteConflict) throw snapshot.error;
    const before = noteDraftDocument(snapshot);
    const block = taskBlocks(before).find((item) => item.id === id);
    if (!block?.title) throw new Error(sourceRemovedMessage);
    const after = new Transform(before).setNodeAttribute(
      block.pos,
      "done",
      done,
    ).doc;
    changeTaskNoteDocument(snapshot.note, before, after);
    await saveTaskNote(note.id);
  }
  if (record === "external")
    void queryClient.invalidateQueries({ queryKey: ["external-tasks"] });
  if (record === "workItem")
    void queryClient.invalidateQueries({ queryKey: ["work-items"] });
  void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
}

export function useBoardTasks({
  visible,
  notes,
  noteList,
  agents,
  executions,
  workflows,
  nowMs = Date.now(),
}: {
  visible: boolean;
  notes: TaskNoteSummary[];
  noteList: { isPending: boolean; error: Error | null; refetch: () => void };
  agents: Agent[];
  executions: Map<string, TaskExecution>;
  workflows: Map<string, TaskWorkflow>;
  nowMs?: number;
}) {
  const { t } = useTranslation();
  const drafts = useTaskDrafts();
  const results = useQueries({
    queries: notes.map((note) => ({
      ...taskNoteQuery(note.id),
      enabled: visible,
    })),
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
    enabled: visible,
    refetchOnWindowFocus: true,
  });
  const workItems = useQuery({
    queryKey: ["work-items"],
    queryFn: ({ signal }) =>
      api<WorkItem[]>("/tasks/work-items", undefined, "GET", signal),
    enabled: visible,
  });
  const deadlinesQuery = useTaskDeadlines(visible);
  const reminderSettingsQuery = useTaskReminderSettings(visible);
  const reminderSettings = reminderSettingsQuery.data ?? defaultReminderSettings;
  const deadlinesById = useMemo(
    () => new Map((deadlinesQuery.data ?? []).map((item) => [item.taskId, item])),
    [deadlinesQuery.data],
  );
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: ({ signal }) =>
      api<Plugin[]>("/plugins", undefined, "GET", signal),
    enabled: visible,
  });

  const sourceLabels = useMemo(
    () =>
      new Map([
        ["written", t("tasks.source.written")],
        ["workItem", t("tasks.source.workItem")],
        ["agent", t("tasks.source.agent")],
        ["github", t("tasks.source.github")],
        ["automation", t("automations.title")],
        ...(plugins.data?.flatMap((plugin) =>
          (plugin.manifest.contributes.taskSources ?? []).map(
            ({ id, name }) => [id, name] as const,
          ),
        ) ?? []),
      ]),
    [plugins.data, t],
  );

  const tasks = useMemo(() => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    function cardState(
      task: { id: string; done: boolean; dueAt?: number; dueDate?: string },
      assignee?: string,
      proposed = false,
    ) {
      const execution = executions.get(task.id);
      const workflow = workflows.get(task.id);
      const queue = !execution ? workflow?.queue : undefined;
      const agentId = execution?.agentId ?? queue?.agentId ?? assignee;
      const status = taskStatus(task, execution, workflow, proposed);
      const deadline = resolveTaskDeadline({
        local: deadlinesById.get(task.id),
        externalDueAt: task.dueAt,
        externalDueDate: task.dueDate,
        done: status === "done",
        closed: status === "closed",
        settings: reminderSettings,
        nowMs,
      });
      return {
        status,
        agentId,
        agent: agentsById.get(agentId ?? ""),
        queue,
        execution,
        deadline,
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
        body: task.body,
      }),
    );
    const automated: BoardTask[] = [];
    for (const execution of executions.values()) {
      if (!execution.automationId || !execution.title) continue;
      automated.push({
        id: execution.taskId,
        record: "automation",
        title: execution.title,
        status: taskStatus(execution, execution, workflows.get(execution.taskId)),
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
        ...cardState(item, item.assigneeAgentId, !!item.createdByAgentId),
        project: item.project ?? "",
        priority: item.priority ?? "",
        source: item.createdByAgentId ? "agent" : "workItem",
        createdByAgentId: item.createdByAgentId,
        body: item.body,
        updatedAt: item.createdAt,
      }),
    );
    return [...native, ...written, ...synced, ...automated].filter((task) => workflows.get(task.id)?.disposition !== "deleted");
  }, [
    results.documents,
    drafts,
    executions,
    workflows,
    agents,
    t,
    external.data,
    workItems.data,
    deadlinesById,
    reminderSettings,
    nowMs,
  ]);

  const loading =
    noteList.isPending ||
    results.pending ||
    external.isPending ||
    workItems.isPending;
  const failed = [noteList, results.failed, external, workItems].find(
    (source) => source?.error,
  );

  return {
    tasks,
    drafts,
    sourceLabels,
    deadlinesById,
    reminderSettings,
    loading,
    failed,
  };
}
