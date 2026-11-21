import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Transform } from "@tiptap/pm/transform";
import {
  ArrowUpRight,
  ChevronRight,
  CircleDot,
  Folder,
  GitPullRequest,
  NotebookPen,
  UserRound,
  X,
  Zap,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  ExternalTask,
  TaskExecution,
  TaskWorkflow,
  WorkItem,
} from "@/api/types.gen";
import { MessageResponse } from "@/components/ai-elements/message-response";
import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { TaskActivity } from "./TaskActivity";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { TaskAssignee } from "./TaskAssignee";
import { TaskDetailActions, TaskQueueInfo } from "./TaskDetail";
import { useTaskWorkflowUpdate } from "./taskWorkflow";
import { TaskDispatchPanel } from "./TaskDispatchPanel";
import { TaskStatusIcon } from "./TaskStatusIcon";
import {
  taskBlocks,
  taskImages,
  taskNoteSchema,
  taskStatus,
} from "./taskDocument";
import { useTaskDispatch, type TaskTarget } from "./useTaskDispatch";
import { taskNoteQuery } from "./noteQueries";
import {
  changeTaskNoteDocument,
  noteDraftDocument,
  saveTaskNote,
  TaskNoteConflict,
  taskNoteSnapshot,
  useTaskDrafts,
} from "./useTaskNote";

export function BoardTaskDetail({
  target,
  agents,
  execution,
  workflow,
  onClose,
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
  onClose: () => void;
  onLocate: (noteId: string, taskId: string) => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenAutomation: (id: string) => void;
  onOpenRun: OpenRun;
  onOpenOrigin: (item: WorkItem) => void;
}) {
  const { t } = useTranslation();
  const { id, noteId, record } = target;
  const automationId =
    record === "automation" ? execution?.automationId : undefined;
  const closeButton = useRef<HTMLButtonElement>(null);
  const [assigning, setAssigning] = useState(false);
  const dispatch = useTaskDispatch();
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
  const status = task && taskStatus(task, execution, workflow, !!workItem);
  const agentId =
    execution?.agentId ??
    queue?.agentId ??
    written?.agentId ??
    workItem?.assigneeAgentId;
  const agent = agents.find(({ id }) => id === agentId);
  const project = written?.issue?.repository || note?.project;
  const canAssign =
    record !== "automation" &&
    !execution &&
    (status === "todo" || status === "unconfirmed");
  const SourceIcon = external?.kind === "pr" ? GitPullRequest : CircleDot;
  const source = external
    ? t("tasks.source." + external.source, { defaultValue: external.source })
    : "";
  const sourceLabel = t("tasks.openSource", { source });

  const update = useMutation({
    mutationFn: async (done: boolean) => {
      if (record === "automation") {
        await api("/tasks/automation-runs/" + id, { done }, "PATCH");
        return;
      }
      if (record === "workItem") {
        await api("/tasks/work-items/" + id, { done }, "PATCH");
        return;
      }
      if (record === "external") {
        await api("/tasks/external/" + id, { done }, "PUT");
        return;
      }
      if (!note) throw new Error(t("tasks.sourceRemoved"));
      const snapshot = taskNoteSnapshot(note);
      if (snapshot.error instanceof TaskNoteConflict) throw snapshot.error;
      const before = noteDraftDocument(snapshot);
      const block = taskBlocks(before).find((item) => item.id === id);
      if (!block?.title) throw new Error(t("tasks.sourceRemoved"));
      const after = new Transform(before).setNodeAttribute(
        block.pos,
        "done",
        done,
      ).doc;
      changeTaskNoteDocument(snapshot.note, before, after);
      await saveTaskNote(note.id);
    },
    onSuccess: () => {
      if (record === "external")
        void queryClient.invalidateQueries({ queryKey: ["external-tasks"] });
      if (record === "workItem")
        void queryClient.invalidateQueries({ queryKey: ["work-items"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
    },
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

  return (
    <Dialog open modal={false} onOpenChange={(open) => !open && onClose()}>
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
        {!task && (
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
              <UserRound aria-hidden="true" />
              {t("tasks.source.agent")}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
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
            <Button
              ref={closeButton}
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.closeDetail")}
              onClick={onClose}
            >
              <X />
            </Button>
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
              <DialogTitle className="task-board-detail-title">
                {task.title || t("tasks.untitled")}
              </DialogTitle>
              <div className="task-board-detail-properties">
                <Badge variant="outline">
                  <TaskStatusIcon status={status} />
                  <span className="sr-only">{t("tasks.filterStatus")}: </span>
                  {t("tasks.status." + status)}
                </Badge>
                <Badge variant="outline">
                  <span className="sr-only">{t("tasks.assignee")}: </span>
                  <TaskAssignee agent={agent} assigned={!!agentId} />
                </Badge>
                {project && (
                  <Badge variant="outline" title={project}>
                    <Folder aria-hidden="true" />
                    <span className="sr-only">{t("tasks.project")}: </span>
                    <span className="truncate">{project}</span>
                  </Badge>
                )}
                {external && (
                  <>
                    <Badge variant="outline">
                      <SourceIcon aria-hidden="true" />
                      {t("tasks.kind." + external.kind)}
                    </Badge>
                    <Badge variant="outline">
                      <span className="sr-only">
                        {t("tasks.filterRemote")}:{" "}
                      </span>
                      {t("tasks.remote." + external.state)}
                    </Badge>
                  </>
                )}
              </div>
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
                  agents={agents.filter((agent) => !agent.archived)}
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
              {queue ? (
                <TaskQueueInfo queue={queue} />
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
              onCloseTask={
                !actionsDisabled && canAssign
                  ? () => workflowUpdate.mutate("close")
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
      </DialogPrimitive.Content>
    </Dialog>
  );
}
