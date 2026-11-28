import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Ellipsis, Inbox, Plus, Rss, Search, SquareKanban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import type {
  Agent,
  Chat,
  Request,
  TaskExecution,
  TaskLocation,
  TaskSource,
  TaskView,
  TaskViewFilters,
} from "@/api/types.gen";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SecondarySidebar } from "@/components/workbench/SecondarySidebar";
import { BoardTaskDetail } from "./BoardTaskDetail";
import {
  resolveTaskNoteId,
  selectedTaskNoteKey,
  taskNoteQuery,
  taskNotesQuery,
} from "./noteQueries";
import { TaskBoard, type BoardView } from "./TaskBoard";
import { TaskDispatchPanel } from "./TaskDispatchPanel";
import { TaskInbox } from "./TaskInbox";
import { TaskLabelDialog } from "./TaskLabelDialog";
import { TaskNoteList } from "./TaskNoteList";
import type { TaskReveal } from "./TaskNoteView";
import { TaskNotePane } from "./TaskNotePane";
import {
  buildAgentQueueMetrics,
  pendingRequestRunIds,
  taskInboxReason,
  useBoardTasks,
  type BoardTask,
} from "./taskBoardModel";
import { useTaskActivity } from "./taskWorkflow";
import {
  TaskSidebarGroups,
  TaskSidebarItems,
  type TaskSection,
} from "./TaskSidebar";
import {
  AddTaskSourceDialog,
  TaskSourceDetail,
  useTaskSources,
} from "./TaskSources";
import {
  useTaskDispatch,
  type TaskDispatchTarget,
  type TaskTarget,
} from "./useTaskDispatch";
import {
  createTaskNote,
  useTaskDraftSummaries,
  useUnsavedTaskWarning,
} from "./useTaskNote";
import { removeTaskView, saveTaskView, useTaskViews } from "./useTaskViews";
import "./tasks.css";

const defaultBoard: BoardView = { group: "status", sort: "deadline", filters: {} };

type PageSection = TaskSection | "inbox";

type ViewDialog =
  | { mode: "new" | "saveAs"; from: BoardView }
  | { mode: "rename"; view: TaskView };

function sameBoard(left: BoardView, right: BoardView) {
  if (left.group !== right.group) return false;
  if ((left.sort || "deadline") !== (right.sort || "deadline")) return false;
  if ((left.quickFilter ?? "agent") !== (right.quickFilter ?? "agent"))
    return false;
  const fields = Object.keys({
    ...left.filters,
    ...right.filters,
  }) as (keyof TaskViewFilters)[];
  return fields.every((field) => {
    const a = left.filters[field] ?? [];
    const b = right.filters[field] ?? [];
    return a.length === b.length && a.every((value) => b.includes(value));
  });
}

export type TaskDestination = { id: string; kind: "task" | "card" | "note" };

export default function TasksPage({
  visible,
  agents,
  chats,
  requests = [],
  revealTask,
  onLocated,
  onOpenChat,
  onOpenAutomation,
  onOpenRun,
}: {
  visible: boolean;
  agents: Agent[];
  chats: Chat[];
  requests?: Request[];
  revealTask?: TaskDestination;
  onLocated: () => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenAutomation: (id: string) => void;
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  const [sidebar, setSidebar] = useState(() => innerWidth >= 760);
  const [section, setSection] = useState<PageSection>("note");
  const showInbox = section === "inbox";
  const showBoard = section === "board";
  const showSources = section === "sources";
  const [boardTask, setBoardTask] = useState<TaskTarget>();
  const [assignment, setAssignment] = useState<TaskDispatchTarget>();
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const taskDialogTrigger = useRef<HTMLButtonElement>(null);
  const visibleBoardTasksRef = useRef<BoardTask[]>([]);
  const dispatch = useTaskDispatch();
  const [viewId, setViewId] = useState<string>();
  const [activePreset, setActivePreset] = useState(false);
  const [boardEdits, setBoardEdits] = useState<{
    view: BoardView;
    revision: number;
  }>();
  const [viewDialog, setViewDialog] = useState<ViewDialog>();
  const [deletingView, setDeletingView] = useState<TaskView>();
  const views = useTaskViews(visible);
  const selectedView = views.data?.find((view) => view.id === viewId);
  useEffect(() => {
    if (viewId && views.data && !selectedView) {
      setViewId(undefined);
      setBoardEdits(undefined);
    }
  }, [viewId, views.data, selectedView]);
  const savedBoard = activePreset
    ? defaultBoard
    : (selectedView ?? defaultBoard);
  const boardView = boardEdits?.view ?? savedBoard;
  const [selected, setSelected] = useState(
    () => localStorage.getItem(selectedTaskNoteKey) ?? "",
  );
  const [creating, setCreating] = useState<"note" | "sources">();
  const createTrigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState({
    board: true,
    note: true,
    sources: true,
  });
  const setGroupOpen = useCallback((group: TaskSection, open: boolean) => {
    setExpanded((old) =>
      old[group] === open ? old : { ...old, [group]: open },
    );
  }, []);
  const [search, setSearch] = useState("");
  const [sourceId, setSourceId] = useState<string>();
  const sources = useTaskSources(visible);
  const selectedSource = sources.data?.find((source) => source.id === sourceId);
  const sourceSearch = search.trim().toLocaleLowerCase();
  const matchesSource = (source: TaskSource) =>
    source.name.toLocaleLowerCase().includes(sourceSearch);
  useEffect(() => {
    if (section === "sources" && sources.data && !selectedSource) {
      setSection("board");
      setSourceId(undefined);
      setViewId(undefined);
      setActivePreset(false);
      setBoardEdits(undefined);
      setGroupOpen("board", true);
    }
  }, [section, sources.data, selectedSource, setGroupOpen]);
  const [searchStep, setSearchStep] = useState(0);
  const [reveal, setReveal] = useState<TaskReveal>();
  const notes = useQuery({ ...taskNotesQuery, enabled: visible });
  const draft = useTaskDraftSummaries();
  const liveNotes = useMemo(
    () =>
      notes.data?.filter(
        (item) => item.state !== "deleted" && !item.conflict,
      ) ?? [],
    [notes.data],
  );
  const id = resolveTaskNoteId(notes.data, selected, draft.has(selected));
  const { runQuery, workflowQuery, executions, workflows } =
    useTaskActivity(visible);
  const deletedBoardSource =
    (boardTask && workflows.get(boardTask.id)?.disposition === "deleted") ||
    (boardTask?.noteId &&
      notes.data?.some((item) => item.id === boardTask.noteId && item.state === "deleted"));
  useEffect(() => {
    if (deletedBoardSource) {
      setBoardTask(undefined);
      detailTrigger.current = null;
    }
  }, [deletedBoardSource]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const boardData = useBoardTasks({
    visible,
    notes: liveNotes,
    noteList: {
      isPending: notes.isPending,
      error: notes.error,
      refetch: notes.refetch,
    },
    agents,
    executions,
    workflows,
    nowMs,
  });

  const requestRunIds = useMemo(
    () => pendingRequestRunIds(requests),
    [requests],
  );

  const agentMetricsList = useMemo(
    () =>
      buildAgentQueueMetrics(agents, boardData.tasks, workflows, requestRunIds),
    [agents, boardData.tasks, workflows, requestRunIds],
  );
  const agentMetricsMap = useMemo(
    () => new Map(agentMetricsList.map((item) => [item.agent.id, item])),
    [agentMetricsList],
  );

  const inboxStats = useMemo(() => {
    let count = 0;
    let urgent = false;
    for (const task of boardData.tasks) {
      const reason = taskInboxReason(task, requestRunIds);
      if (!reason) continue;
      count += 1;
      if (
        reason === "request" ||
        reason === "attention" ||
        reason === "deadline"
      )
        urgent = true;
    }
    return { count, urgent };
  }, [boardData.tasks, requestRunIds]);
  const consumingStats = useMemo(() => {
    let running = 0;
    let queued = 0;
    for (const task of boardData.tasks) {
      if (task.status === "running" || task.status === "attention") running += 1;
      else if (task.status === "queued") queued += 1;
    }
    return { running, queued, total: running + queued };
  }, [boardData.tasks]);

  useUnsavedTaskWarning();

  function openInbox() {
    setBoardTask(undefined);
    detailTrigger.current = null;
    setActivePreset(false);
    setSection("inbox");
    setReveal(undefined);
    if (innerWidth < 760) setSidebar(false);
  }

  function openActiveBoard() {
    setBoardTask(undefined);
    detailTrigger.current = null;
    setViewId(undefined);
    setActivePreset(true);
    setBoardEdits(undefined);
    setSection("board");
    setReveal(undefined);
    if (innerWidth < 760) setSidebar(false);
  }

  function openBoard(next?: string) {
    setBoardTask(undefined);
    detailTrigger.current = null;
    if (next !== viewId || showBoard || activePreset) {
      setViewId(next);
      setActivePreset(false);
      setBoardEdits(undefined);
    }
    setGroupOpen("board", true);
    setSection("board");
    setReveal(undefined);
    if (innerWidth < 760) setSidebar(false);
  }

  const deleteView = useMutation({
    mutationFn: removeTaskView,
    onSuccess: () => setDeletingView(undefined),
    onError: () => void views.refetch(),
  });
  const updateView = useMutation({
    mutationFn: saveTaskView,
    onSuccess: (saved) => {
      setBoardEdits((edits) => {
        if (saved.id !== viewId || !edits) return edits;
        return sameBoard(edits.view, saved)
          ? undefined
          : { ...edits, revision: saved.revision };
      });
    },
    onError: (error) => {
      if (error instanceof APIError && error.status === 409) {
        toast.error(t("tasks.viewConflict"));
        void views.refetch();
      } else toast.error(error.message);
    },
  });
  const boardChanged = !sameBoard(boardView, savedBoard);
  const saveLabel =
    !activePreset && views.isSuccess && (!selectedView || boardChanged)
      ? t(selectedView ? "tasks.updateView" : "tasks.saveView")
      : undefined;

  const openNote = useCallback(
    (noteId: string, task?: TaskReveal) => {
      setBoardTask(undefined);
      detailTrigger.current = null;
      setActivePreset(false);
      setSection("note");
      setSelected(noteId);
      setGroupOpen("note", true);
      setSearchStep(0);
      setReveal(task);
      localStorage.setItem(selectedTaskNoteKey, noteId);
      if (innerWidth < 760) setSidebar(false);
    },
    [setGroupOpen],
  );
  const openBoardTask = useCallback(
    (target: TaskTarget, trigger?: HTMLButtonElement) => {
      detailTrigger.current = trigger ?? null;
      setGroupOpen("board", true);
      setSection("board");
      setReveal(undefined);
      setBoardTask(target);
      if (innerWidth <= 760) setSidebar(false);
    },
    [setGroupOpen],
  );
  useEffect(() => {
    if (!boardTask) return;
    const narrow = matchMedia("(max-width: 760px)");
    const onResize = () => {
      if (narrow.matches) setSidebar(false);
    };
    narrow.addEventListener("change", onResize);
    return () => narrow.removeEventListener("change", onResize);
  }, [boardTask]);
  const taskFocusTarget = (trigger: HTMLButtonElement | null) =>
    trigger?.isConnected && !trigger.closest("[hidden], [inert]")
      ? trigger
      : document.querySelector<HTMLButtonElement>(
          showBoard
            ? '.tasks-board [role="tab"][aria-selected="true"]'
            : "#task-sidebar [aria-current=page]",
        );
  function closeBoardTask(restoreFocus = true) {
    const trigger = detailTrigger.current;
    detailTrigger.current = null;
    setBoardTask(undefined);
    if (restoreFocus)
      requestAnimationFrame(() =>
        taskFocusTarget(trigger)?.focus({ preventScroll: true }),
      );
  }
  function openSource(id: string) {
    closeBoardTask(false);
    setActivePreset(false);
    setGroupOpen("sources", true);
    setSection("sources");
    setSourceId(id);
    setReveal(undefined);
    if (innerWidth <= 760) setSidebar(false);
  }
  function restoreCreateFocus(event: Event) {
    const trigger = createTrigger.current;
    createTrigger.current = null;
    if (trigger?.isConnected && !trigger.closest("[inert], [hidden]")) {
      event.preventDefault();
      trigger.focus({ preventScroll: true });
    }
  }
  const restoreTaskFocus = (event: Event) => {
    if (!visible) return;
    const target = taskFocusTarget(taskDialogTrigger.current);
    taskDialogTrigger.current = null;
    if (target) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
  };

  useEffect(() => {
    if (!visible || !revealTask) return;
    const controller = new AbortController();
    const { id, kind } = revealTask;
    const location =
      kind === "note"
        ? queryClient
            .fetchQuery({ ...taskNoteQuery(id), staleTime: 0 })
            .then((): TaskLocation => ({ record: "note", noteId: id }))
        : api<TaskLocation>(
            "/tasks/locate/" + encodeURIComponent(id),
            undefined,
            "GET",
            controller.signal,
          );
    void location.then(
      (value) => {
        if (controller.signal.aborted) return;
        if (kind === "note") openNote(id);
        else if (kind === "task" && value.noteId)
          openNote(value.noteId, { id, detail: false });
        else openBoardTask({ id, ...value });
        onLocated();
      },
      (error) => {
        if (controller.signal.aborted) return;
        if (error instanceof APIError && error.status === 404)
          toast.info(t("tasks.sourceRemoved"));
        else toast.error(String(error));
        onLocated();
      },
    );
    return () => controller.abort();
  }, [visible, revealTask, openNote, openBoardTask, onLocated, t]);

  const onRevealed = useCallback(() => setReveal(undefined), []);

  const boardTaskIndex = boardTask
    ? visibleBoardTasksRef.current.findIndex((item) => item.id === boardTask.id)
    : -1;
  const stepBoardTask = (delta: number) => {
    const list = visibleBoardTasksRef.current;
    const next = list[boardTaskIndex + delta];
    if (next) {
      setBoardTask({ id: next.id, record: next.record, noteId: next.noteId });
    }
  };

  return (
    <div
      className="workspace-frame tasks-frame"
      hidden={!visible}
      inert={!visible}
    >
      <SecondarySidebar
        id="task-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <header className="sidebar-heading">
          <h1>{t("nav.tasks")}</h1>
        </header>
        <form
          role="search"
          className="task-sidebar-search"
          onSubmit={(event) => {
            event.preventDefault();
            if (section === "note") setSearchStep((step) => step + 1);
          }}
        >
          <InputGroup className="sidebar-search-control">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={t("tasks.search")}
              placeholder={t("tasks.search")}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSearchStep(0);
              }}
            />
          </InputGroup>
        </form>
        <nav className="task-sidebar-nav" aria-label={t("nav.tasks")}>
          <div className="task-sidebar-focus">
            <div className="task-sidebar-section-label">{t("tasks.focus")}</div>
            <Button
              variant="ghost"
              className="sidebar-nav-item task-focus-item"
              aria-current={showInbox ? "page" : undefined}
              onClick={openInbox}
            >
              <Inbox data-icon="inline-start" />
              <span className="truncate">{t("tasks.focus.inbox")}</span>
              {inboxStats.count > 0 && (
                <span
                  className="task-focus-badge tabular-nums"
                  data-tone="attention"
                >
                  {inboxStats.count}
                </span>
              )}
            </Button>
            <Button
              variant="ghost"
              className="sidebar-nav-item task-focus-item"
              aria-current={showBoard && activePreset ? "page" : undefined}
              onClick={openActiveBoard}
            >
              <span
                className="task-dot task-focus-dot"
                data-status={consumingStats.running > 0 ? "running" : "queued"}
                aria-hidden="true"
              />
              <span className="truncate">{t("tasks.focus.active")}</span>
              {consumingStats.total > 0 && (
                <span
                  className="task-focus-badge tabular-nums"
                  data-tone="running"
                >
                  {consumingStats.running > 0 && consumingStats.queued > 0
                    ? `${consumingStats.running}+${consumingStats.queued}`
                    : consumingStats.total}
                </span>
              )}
            </Button>
          </div>
          <TaskSidebarGroups
            expanded={expanded}
            onOpenChange={setGroupOpen}
            onCreate={(group, trigger) => {
              createTrigger.current = trigger;
              if (group === "board")
                setViewDialog({ mode: "new", from: defaultBoard });
              else setCreating(group);
            }}
          >
            {{
              board: (
                <>
                  <ul
                    className="task-nav-children"
                    aria-label={t("tasks.board")}
                  >
                    <li>
                      <Button
                        variant="ghost"
                        className="sidebar-nav-item task-nav-child"
                        aria-current={
                          showBoard && !selectedView && !activePreset
                            ? "page"
                            : undefined
                        }
                        onClick={() => openBoard()}
                      >
                        <SquareKanban
                          className="task-nav-child-icon"
                          aria-hidden="true"
                        />
                        {t("tasks.allView")}
                      </Button>
                    </li>
                    <TaskSidebarItems scope="views" items={views.data ?? []}>
                      {(view, drag) => (
                        <div className="task-saved-view-row">
                          <Button
                            {...drag}
                            variant="ghost"
                            className="sidebar-nav-item task-nav-child"
                            aria-current={
                              showBoard && selectedView?.id === view.id
                                ? "page"
                                : undefined
                            }
                            title={view.name}
                            onClick={() => openBoard(view.id)}
                          >
                            <SquareKanban
                              className="task-nav-child-icon"
                              aria-hidden="true"
                            />
                            <span className="truncate">{view.name}</span>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                disabled={updateView.isPending}
                                className="task-saved-view-menu"
                                aria-label={t("tasks.viewActions", {
                                  name: view.name,
                                })}
                              >
                                <Ellipsis />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem
                                onSelect={() =>
                                  setViewDialog({ mode: "rename", view })
                                }
                              >
                                {t("tasks.renameView")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  deleteView.reset();
                                  setDeletingView(view);
                                }}
                              >
                                {t("tasks.deleteView")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </TaskSidebarItems>
                  </ul>
                  {!!views.error && (
                    <ErrorNotice
                      error={views.error}
                      retry={() => void views.refetch()}
                    />
                  )}
                </>
              ),
              note: (
                <TaskNoteList
                  notes={notes.data ?? []}
                  currentId={section === "note" ? id : undefined}
                  onOpen={openNote}
                />
              ),
              sources: (
                <>
                  {!!sources.data?.length && (
                    <ul
                      className="task-nav-children"
                      aria-label={t("tasks.sources")}
                    >
                      <TaskSidebarItems
                        scope="sources"
                        items={sources.data}
                        matches={matchesSource}
                      >
                        {(source, drag) => (
                          <Button
                            {...drag}
                            variant="ghost"
                            className="sidebar-nav-item task-nav-child"
                            aria-current={
                              showSources && selectedSource?.id === source.id
                                ? "page"
                                : undefined
                            }
                            title={source.name}
                            onClick={() => openSource(source.id)}
                          >
                            <Rss
                              className="task-nav-child-icon"
                              aria-hidden="true"
                            />
                            <span className="truncate">{source.name}</span>
                          </Button>
                        )}
                      </TaskSidebarItems>
                    </ul>
                  )}
                  {!!sources.error && (
                    <ErrorNotice
                      error={sources.error}
                      retry={() => void sources.refetch()}
                    />
                  )}
                </>
              ),
            }}
          </TaskSidebarGroups>
        </nav>
      </SecondarySidebar>
      <main className="tasks-content">
        {showSources ? (
          selectedSource ? (
            <TaskSourceDetail
              key={selectedSource.id}
              source={selectedSource}
              visible={visible}
            />
          ) : (
            <Loading />
          )
        ) : showInbox ? (
          workflowQuery.isPending ? (
            <Loading />
          ) : (
            <TaskInbox
              tasks={boardData.tasks}
              agents={agents}
              executions={executions}
              workflows={workflows}
              requests={requests}
              requestRunIds={requestRunIds}
              agentMetrics={agentMetricsMap}
              deadlinesById={boardData.deadlinesById}
              reminderSettings={boardData.reminderSettings}
              nowMs={nowMs}
              search={search}
              onLocate={(noteId, taskId) =>
                openNote(noteId, { id: taskId, detail: false })
              }
              onOpenChat={onOpenChat}
              onOpenRun={onOpenRun}
              onOpenAutomation={onOpenAutomation}
              onOpenOrigin={(item) => {
                if (!item.origin || !item.createdByAgentId) return;
                onOpenRun(
                  { ...item.origin, agentId: item.createdByAgentId },
                  item.title,
                );
              }}
            />
          )
        ) : showBoard && workflowQuery.isPending ? (
          <Loading />
        ) : showBoard ? (
          <TaskBoard
            name={
              activePreset
                ? t("tasks.focus.active")
                : (selectedView?.name ?? t("tasks.allView"))
            }
            consumingOnly={activePreset}
            tasks={boardData.tasks}
            drafts={boardData.drafts}
            sourceLabels={boardData.sourceLabels}
            reminderSettings={boardData.reminderSettings}
            loading={boardData.loading}
            failed={boardData.failed}
            notes={liveNotes}
            agents={agents}
            executions={executions}
            workflows={workflows}
            requests={requests}
            agentMetricsList={agentMetricsList}
            agentMetricsMap={agentMetricsMap}
            view={boardView}
            search={search}
            selectedTaskId={boardTask?.id}
            visibleTasksRef={visibleBoardTasksRef}
            detail={
              visible &&
              boardTask && (
                <BoardTaskDetail
                  key={boardTask.id}
                  target={boardTask}
                  agents={agents}
                  execution={executions.get(boardTask.id)}
                  workflow={workflows.get(boardTask.id)}
                  requests={requests}
                  agentMetrics={agentMetricsMap}
                  localDeadline={boardData.deadlinesById.get(boardTask.id)}
                  reminderSettings={boardData.reminderSettings}
                  onClose={() => closeBoardTask()}
                  onPrev={
                    boardTaskIndex > 0 ? () => stepBoardTask(-1) : undefined
                  }
                  onNext={
                    boardTaskIndex >= 0 &&
                    boardTaskIndex < visibleBoardTasksRef.current.length - 1
                      ? () => stepBoardTask(1)
                      : undefined
                  }
                  onLocate={(noteId, taskId) =>
                    openNote(noteId, { id: taskId, detail: false })
                  }
                  onOpenChat={(execution, title) => {
                    closeBoardTask(false);
                    onOpenChat(execution, title);
                  }}
                  onOpenRun={(run, title) => {
                    closeBoardTask(false);
                    onOpenRun(run, title);
                  }}
                  onOpenAutomation={(id) => {
                    closeBoardTask(false);
                    onOpenAutomation(id);
                  }}
                  onOpenOrigin={(item) => {
                    if (!item.origin || !item.createdByAgentId) return;
                    closeBoardTask(false);
                    onOpenRun(
                      { ...item.origin, agentId: item.createdByAgentId },
                      item.title,
                    );
                  }}
                />
              )
            }
            saveLabel={saveLabel}
            saving={updateView.isPending}
            onViewChange={(view) =>
              setBoardEdits({
                view,
                revision: boardEdits?.revision ?? selectedView?.revision ?? 0,
              })
            }
            onSaveAs={
              selectedView && !updateView.isPending
                ? () => setViewDialog({ mode: "saveAs", from: boardView })
                : undefined
            }
            onSave={() => {
              if (selectedView) {
                updateView.mutate({
                  ...selectedView,
                  group: boardView.group,
                  filters: boardView.filters,
                  quickFilter: boardView.quickFilter,
                  revision: boardEdits?.revision ?? selectedView.revision,
                });
              } else setViewDialog({ mode: "saveAs", from: boardView });
            }}
            onOpen={openBoardTask}
            onAssign={(task, trigger) => {
              taskDialogTrigger.current = trigger;
              setAssignment(task);
            }}
          />
        ) : (
          <TaskNotePane
            onOpenNote={openNote}
            id={id}
            notes={notes}
            visible={visible}
            agents={agents}
            chats={chats}
            executions={executions}
            workflows={workflows}
            search={search}
            searchStep={searchStep}
            reveal={reveal}
            onRevealed={onRevealed}
            onOpenChat={onOpenChat}
            onOpenRun={onOpenRun}
            empty={
              <div className="task-notes-empty">
                <Button
                  variant="outline"
                  onClick={(event) => {
                    createTrigger.current = event.currentTarget;
                    setCreating("note");
                  }}
                >
                  <Plus data-icon="inline-start" />
                  {t("tasks.newNote")}
                </Button>
              </div>
            }
          />
        )}
        {(runQuery.error || workflowQuery.error) && (
          <div className="task-execution-error">
            <ErrorNotice
              error={runQuery.error ?? workflowQuery.error}
              retry={() =>
                void (runQuery.error
                  ? runQuery.refetch()
                  : workflowQuery.refetch())
              }
            />
          </div>
        )}
      </main>
      {visible && assignment && (
        <TaskDispatchPanel
          key={assignment.id}
          task={assignment}
          agents={agents.filter((agent) => !agent.archived)}
          dialog={{ onCloseAutoFocus: restoreTaskFocus }}
          onCancel={() => setAssignment(undefined)}
          onDispatch={async (options) => {
            await dispatch(assignment, options);
            setAssignment(undefined);
          }}
        />
      )}
      {visible && creating === "sources" && (
        <AddTaskSourceDialog
          onClose={() => setCreating(undefined)}
          onCloseAutoFocus={restoreCreateFocus}
          onAdded={(source) => {
            if (!matchesSource(source)) setSearch("");
            openSource(source.id);
          }}
        />
      )}
      {visible && viewDialog && (
        <TaskLabelDialog
          title={t(
            viewDialog.mode === "rename"
              ? "tasks.renameView"
              : viewDialog.mode === "new"
                ? "tasks.newView"
                : "tasks.saveView",
          )}
          label={t("tasks.viewName")}
          initialValue={
            viewDialog.mode === "rename" ? viewDialog.view.name : ""
          }
          saveLabel={
            viewDialog.mode === "new" ? t("tasks.createView") : undefined
          }
          onClose={() => setViewDialog(undefined)}
          onCloseAutoFocus={
            viewDialog.mode === "new" ? restoreCreateFocus : undefined
          }
          onSave={async (name, id) => {
            if (viewDialog.mode === "rename") {
              const { view } = viewDialog;
              if (name === view.name) return;
              const saved = await saveTaskView({ ...view, name });
              if (saved.id === viewId) {
                setBoardEdits((edits) =>
                  edits?.revision === view.revision
                    ? { ...edits, revision: saved.revision }
                    : edits,
                );
              }
              return;
            }
            const saved = await saveTaskView({
              ...viewDialog.from,
              id,
              name,
              revision: 0,
            });
            if (viewDialog.mode === "new") setSearch("");
            openBoard(saved.id);
          }}
        />
      )}
      {deletingView && (
        <Dialog
          open
          onOpenChange={(open) =>
            !open && !deleteView.isPending && setDeletingView(undefined)
          }
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("tasks.deleteView")}</DialogTitle>
              <DialogDescription>
                {t("tasks.deleteViewConfirm", { name: deletingView.name })}
              </DialogDescription>
            </DialogHeader>
            {!!deleteView.error && <ErrorNotice error={deleteView.error} />}
            <DialogFooter>
              <Button
                variant="ghost"
                disabled={deleteView.isPending}
                onClick={() => setDeletingView(undefined)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={deleteView.isPending}
                onClick={() => deleteView.mutate(deletingView)}
              >
                {t("tasks.deleteView")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {visible && creating === "note" && (
        <TaskLabelDialog
          title={t("tasks.newNote")}
          label={t("tasks.noteTitle")}
          saveLabel={t("tasks.create")}
          onClose={() => setCreating(undefined)}
          onCloseAutoFocus={restoreCreateFocus}
          onSave={async (title, id) => {
            const created = await createTaskNote({ id, title });
            void queryClient.invalidateQueries({
              queryKey: taskNotesQuery.queryKey,
            });
            openNote(created.id);
          }}
        />
      )}
    </div>
  );
}
