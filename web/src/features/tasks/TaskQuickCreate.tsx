import { useId, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  CalendarClock,
  Check,
  Expand,
  Flag,
  Folder,
  Plus,
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
  UserWorkItemCreate,
  WorkItem,
  WorkItemPriority,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { TaskAgentSelect } from "./TaskAgentSelect";
import {
  defaultReminderSettings,
  formatDeadlineLabel,
  formatReminderOffset,
} from "./taskDeadlines";
import { TaskDeadlinePicker } from "./TaskDeadlinePicker";
import { TaskPriorityIcon, workItemPriorities } from "./TaskPriorityIcon";
import { useTaskDispatch, type TaskDispatchTarget } from "./useTaskDispatch";

const isMac =
  typeof navigator !== "undefined" && navigator.platform.includes("Mac");

export function TaskQuickCreate({
  agents,
  projects,
  defaultAgentId,
  defaultProject,
  reminderSettings = defaultReminderSettings,
  onNeedsDispatch,
}: {
  agents: Agent[];
  projects: string[];
  defaultAgentId?: string;
  defaultProject?: string;
  reminderSettings?: TaskReminderSettings;
  onNeedsDispatch: (task: TaskDispatchTarget, trigger: HTMLButtonElement) => void;
}) {
  const { t, i18n } = useTranslation();
  const dispatch = useTaskDispatch();
  const activeAgents = agents.filter((agent) => !agent.archived);
  const inputRef = useRef<HTMLInputElement>(null);
  const enqueueTriggerRef = useRef<HTMLButtonElement>(null);

  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<WorkItemPriority | "">("");
  const [project, setProject] = useState(defaultProject ?? "");
  const [assigneeAgentId, setAssigneeAgentId] = useState(defaultAgentId ?? "");
  const [deadline, setDeadline] = useState<TaskDeadlineInput | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [priorityOpen, setPriorityOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogBody, setDialogBody] = useState("");
  const [dialogError, setDialogError] = useState<unknown>();

  const selectedAgent = activeAgents.find((a) => a.id === assigneeAgentId);
  const effectiveProject = project.trim();
  const titleId = useId();
  const bodyId = useId();
  const projectInputId = useId();

  const deadlineSummary = deadline
    ? formatDeadlineLabel(
        {
          dueAt: deadline.dueAt,
          dueDate: deadline.dueDate ?? "",
          isAllDay: !!deadline.dueDate,
          urgency: deadline.dueAt < Date.now() ? "overdue" : "upcoming",
        },
        Date.now(),
        t,
        i18n.language,
      )
    : undefined;
  const deadlineHasReminder =
    !!deadline && (deadline.remindOffsets?.length ?? 0) > 0;

  async function submit(enqueue: boolean, body?: string) {
    const cleanTitle = title.trim();
    if (!cleanTitle || submitting) return;
    setSubmitting(true);
    setDialogError(undefined);
    try {
      const payload: UserWorkItemCreate = {
        title: cleanTitle,
        body: body?.trim() || undefined,
        project: effectiveProject || undefined,
        priority: priority || undefined,
        assigneeAgentId: assigneeAgentId || undefined,
        deadline: deadline ?? undefined,
      };
      const created = await api<WorkItem>("/tasks/work-items", payload, "POST");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["work-items"] }),
        ...(deadline
          ? [queryClient.invalidateQueries({ queryKey: ["task-deadlines"] })]
          : []),
      ]);
      setTitle("");
      setDialogBody("");
      setDeadline(null);
      setDialogOpen(false);
      if (enqueue) {
        const targetAgent =
          activeAgents.find((a) => a.id === assigneeAgentId) ??
          (activeAgents.length === 1 ? activeAgents[0] : undefined);
        if (targetAgent) {
          await dispatch(
            { id: created.id, record: "workItem" },
            { agentId: targetAgent.id },
          );
        } else {
          onNeedsDispatch(
            {
              id: created.id,
              record: "workItem",
              title: created.title,
              agentId: created.assigneeAgentId || undefined,
            },
            enqueueTriggerRef.current!,
          );
        }
      }
      if (!enqueue) {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } catch (error) {
      if (dialogOpen) setDialogError(error);
      else toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <form
        className="task-quick-create"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <div className="task-quick-create-input-wrap">
          <Plus
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            type="text"
            className="task-quick-create-input"
            aria-label={t("tasks.quickCreateLabel")}
            placeholder={t("tasks.quickCreatePlaceholder", {
              shortcut: isMac ? "⌘↵" : "Ctrl+↵",
            })}
            value={title}
            disabled={submitting}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit(true);
              }
            }}
          />
        </div>
        <div className="task-quick-create-controls">
          <TaskDeadlinePicker
            value={deadline ?? undefined}
            defaultRemindOffsets={reminderSettings.defaultRemindOffsets}
            allDayReminderTime={reminderSettings.allDayReminderTime}
            align="end"
            disabled={submitting}
            onChange={setDeadline}
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="task-quick-chip tabular-nums"
              data-active={!!deadline || undefined}
              aria-label={t("tasks.deadline.label")}
              title={deadlineSummary ?? t("tasks.deadline.label")}
            >
              <CalendarClock className="size-3.5" aria-hidden="true" />
              <span className="max-w-28 truncate">
                {deadlineSummary ?? t("tasks.deadline.shortLabel")}
              </span>
              {deadlineHasReminder && (
                <Bell className="size-3 shrink-0 opacity-75" aria-hidden="true" />
              )}
            </Button>
          </TaskDeadlinePicker>

          <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="task-quick-chip"
                data-active={!!priority || undefined}
                aria-label={t("tasks.priority")}
                title={t("tasks.priority")}
              >
                {priority ? (
                  <TaskPriorityIcon priority={priority} />
                ) : (
                  <Flag className="size-3.5" aria-hidden="true" />
                )}
                <span>
                  {priority
                    ? t("tasks.priority." + priority)
                    : t("tasks.priority")}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="task-quick-popover w-40 p-1"
              aria-label={t("tasks.priority")}
            >
              <button
                type="button"
                className="task-quick-option"
                data-selected={!priority || undefined}
                onClick={() => {
                  setPriority("");
                  setPriorityOpen(false);
                }}
              >
                <span className="size-3.5" />
                <span className="truncate">{t("tasks.priority.none")}</span>
                {!priority && <Check className="ml-auto size-3.5" />}
              </button>
              {workItemPriorities.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="task-quick-option"
                  data-selected={priority === value || undefined}
                  onClick={() => {
                    setPriority(value);
                    setPriorityOpen(false);
                  }}
                >
                  <TaskPriorityIcon priority={value} />
                  <span className="truncate">{t("tasks.priority." + value)}</span>
                  {priority === value && <Check className="ml-auto size-3.5" />}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <Popover open={projectOpen} onOpenChange={setProjectOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="task-quick-chip"
                data-active={!!effectiveProject || undefined}
                aria-label={t("tasks.project")}
                title={effectiveProject || t("tasks.project")}
              >
                <Folder className="size-3.5" aria-hidden="true" />
                <span className="max-w-28 truncate">
                  {effectiveProject || t("tasks.project")}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="task-quick-popover w-56 p-2"
              aria-label={t("tasks.project")}
            >
              <div className="flex items-center gap-1">
                <Input
                  type="text"
                  value={project}
                  placeholder={t("tasks.projectName")}
                  aria-label={t("tasks.projectName")}
                  className="h-7 text-xs"
                  onChange={(event) => setProject(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      setProjectOpen(false);
                    }
                  }}
                />
                {project && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("tasks.clearSelection")}
                    onClick={() => setProject("")}
                  >
                    <X className="size-3" />
                  </Button>
                )}
              </div>
              {projects.length > 0 && (
                <div className="mt-1.5 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                  {projects
                    .filter(
                      (item) =>
                        !effectiveProject ||
                        item
                          .toLocaleLowerCase()
                          .includes(effectiveProject.toLocaleLowerCase()),
                    )
                    .map((item) => (
                      <button
                        key={item}
                        type="button"
                        className="task-quick-option"
                        data-selected={effectiveProject === item || undefined}
                        onClick={() => {
                          setProject(item);
                          setProjectOpen(false);
                        }}
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item}</span>
                        {effectiveProject === item && (
                          <Check className="ml-auto size-3.5 shrink-0" />
                        )}
                      </button>
                    ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          {activeAgents.length > 0 && (
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="task-quick-chip"
                  data-active={!!selectedAgent || undefined}
                  aria-label={t("tasks.selectAgent")}
                  title={selectedAgent?.name ?? t("tasks.assignee")}
                >
                  {selectedAgent ? (
                    <AgentAvatar agent={selectedAgent} size="sm" />
                  ) : (
                    <UserRound className="size-3.5" aria-hidden="true" />
                  )}
                  <span className="max-w-28 truncate">
                    {selectedAgent?.name ?? t("tasks.unassigned")}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="task-quick-popover w-52 p-1"
                aria-label={t("tasks.selectAgent")}
              >
                <button
                  type="button"
                  className="task-quick-option"
                  data-selected={!assigneeAgentId || undefined}
                  onClick={() => {
                    setAssigneeAgentId("");
                    setAgentOpen(false);
                  }}
                >
                  <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t("tasks.unassigned")}</span>
                  {!assigneeAgentId && (
                    <Check className="ml-auto size-3.5 shrink-0" />
                  )}
                </button>
                {activeAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="task-quick-option"
                    data-selected={assigneeAgentId === agent.id || undefined}
                    onClick={() => {
                      setAssigneeAgentId(agent.id);
                      setAgentOpen(false);
                    }}
                  >
                    <AgentAvatar agent={agent} size="sm" />
                    <span className="truncate">{agent.name}</span>
                    {assigneeAgentId === agent.id && (
                      <Check className="ml-auto size-3.5 shrink-0" />
                    )}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}

          <div className="task-quick-create-actions">
            <Button
              type="submit"
              variant="outline"
              size="xs"
              disabled={!title.trim() || submitting}
            >
              {t("tasks.quickCreateAdd")}
            </Button>
            {activeAgents.length > 0 && (
              <Button
                ref={enqueueTriggerRef}
                type="button"
                variant={title.trim() ? "default" : "outline"}
                size="xs"
                disabled={!title.trim() || submitting}
                onClick={() => void submit(true)}
              >
                <ArrowUpRight data-icon="inline-start" />
                {t("tasks.quickCreateEnqueue")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("tasks.newWorkItem")}
              title={t("tasks.newWorkItem")}
              onClick={() => {
                setDialogError(undefined);
                setDialogOpen(true);
              }}
            >
              <Expand className="size-3.5" />
            </Button>
          </div>
        </div>
      </form>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => !submitting && setDialogOpen(open)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("tasks.newWorkItem")}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false, dialogBody);
            }}
          >
            <FieldGroup className="gap-3">
              <Field className="gap-1.5">
                <FieldLabel htmlFor={titleId}>
                  {t("tasks.quickCreateLabel")}
                </FieldLabel>
                <Input
                  id={titleId}
                  type="text"
                  autoFocus
                  value={title}
                  disabled={submitting}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor={bodyId}>
                  {t("tasks.workItemBody")}
                </FieldLabel>
                <Textarea
                  id={bodyId}
                  rows={4}
                  placeholder={t("tasks.workItemBodyPlaceholder")}
                  value={dialogBody}
                  disabled={submitting}
                  onChange={(event) => setDialogBody(event.target.value)}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field className="gap-1.5">
                  <FieldLabel htmlFor={projectInputId}>
                    {t("tasks.project")}
                  </FieldLabel>
                  <Input
                    id={projectInputId}
                    type="text"
                    placeholder={t("tasks.projectName")}
                    value={project}
                    disabled={submitting}
                    onChange={(event) => setProject(event.target.value)}
                  />
                </Field>
                <div className="grid gap-1.5">
                  <span className="text-sm font-medium">
                    {t("tasks.assignee")}
                  </span>
                  <TaskAgentSelect
                    agents={activeAgents}
                    label={t("tasks.selectAgent")}
                    value={assigneeAgentId || undefined}
                    onChange={setAssigneeAgentId}
                    disabled={submitting}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">
                  {t("tasks.deadline.label")}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <TaskDeadlinePicker
                    value={deadline ?? undefined}
                    defaultRemindOffsets={reminderSettings.defaultRemindOffsets}
                    allDayReminderTime={reminderSettings.allDayReminderTime}
                    align="start"
                    disabled={submitting}
                    onChange={setDeadline}
                  >
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-start tabular-nums"
                    >
                      <CalendarClock data-icon="inline-start" />
                      <span>
                        {deadlineSummary ?? t("tasks.deadline.setDeadline")}
                      </span>
                    </Button>
                  </TaskDeadlinePicker>
                  {deadline && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {deadline.remindOffsets?.length
                        ? deadline.remindOffsets
                            .map((m) =>
                              formatReminderOffset(
                                m,
                                !!deadline.dueDate,
                                reminderSettings.allDayReminderTime,
                                t,
                              ),
                            )
                            .join(" · ")
                        : t("tasks.reminder.none")}
                    </span>
                  )}
                </div>
              </div>
              <div className="grid gap-1.5">
                <span className="text-sm font-medium">
                  {t("tasks.priority")}
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-label={t("tasks.priority")}
                  value={priority || "none"}
                  onValueChange={(value) => {
                    if (value === "none") setPriority("");
                    else if (value) setPriority(value as WorkItemPriority);
                  }}
                >
                  <ToggleGroupItem value="none">
                    {t("tasks.priority.none")}
                  </ToggleGroupItem>
                  {workItemPriorities.map((value) => (
                    <ToggleGroupItem key={value} value={value}>
                      <TaskPriorityIcon priority={value} />
                      {t("tasks.priority." + value)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </FieldGroup>
            {!!dialogError && <ErrorNotice error={dialogError} />}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={submitting}
                onClick={() => setDialogOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={!title.trim() || submitting}
              >
                {t("tasks.quickCreateAdd")}
              </Button>
              {activeAgents.length > 0 && (
                <Button
                  type="button"
                  disabled={!title.trim() || submitting}
                  onClick={() => void submit(true, dialogBody)}
                >
                  <ArrowUpRight data-icon="inline-start" />
                  {t("tasks.createAndEnqueue")}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
