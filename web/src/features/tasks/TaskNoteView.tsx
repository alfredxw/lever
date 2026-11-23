import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ShareNote } from "./ShareNote";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import type { Range } from "@tiptap/core";
import {
  ChevronRight,
  Ellipsis,
  Folder,
  List,
  Paperclip,
  Plus,
  Search,
  UserCog,
} from "lucide-react";
import { toast } from "sonner";
import { active } from "@/api/client";
import type {
  Agent,
  Chat,
  TaskExecution,
  TaskNote,
  TaskWorkflow,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { directoryName } from "@/lib/paths";
import { TaskDetail } from "./TaskDetail";
import type { OpenRun } from "@/features/chat/DelegatedTasks";
import { TaskDispatchPanel } from "./TaskDispatchPanel";
import { NoteHandoverSettings } from "./NoteHandoverSettings";
import { TaskLabelDialog } from "./TaskLabelDialog";
import { noteBlockItems } from "./NoteBlockMenu";
import { TaskNoteAgentPicker } from "./TaskNoteAgentPicker";
import { TaskNoteEditor, type NoteSelection } from "./TaskNoteEditor";
import { useTaskWorkflowUpdate } from "./taskWorkflow";
import {
  agentMentionContent,
  setTaskMarker,
  taskBlocks,
  taskImages,
  taskPrompt,
  taskStatus,
  type TaskBlock,
} from "./taskDocument";
import { isolateNoteEdit, noteTableDepth } from "./taskEditing";
import { useTaskControls } from "./useTaskControls";
import {
  noteHandoverQuery,
  taskDispatchAgent,
  type TaskDispatchOptions,
  useTaskDispatch,
} from "./useTaskDispatch";
import {
  changeTaskNote,
  finishTaskNoteComposition,
  recoverTaskNote,
  saveTaskNote,
  TaskNoteConflict,
} from "./useTaskNote";

export type TaskReveal = { id: string; detail: boolean };

export function TaskNoteView({
  note,
  visible,
  saveError,
  agents,
  chats,
  executions,
  workflows,
  toolbarAction,
  search = "",
  searchStep = 0,
  reveal,
  onRevealed,
  onOpenChat,
  onOpenRun,
}: {
  note: TaskNote;
  visible: boolean;
  saveError?: unknown;
  agents: Agent[];
  chats: Chat[];
  executions: Map<string, TaskExecution>;
  workflows: Map<string, TaskWorkflow>;
  toolbarAction?: ReactNode;
  search?: string;
  searchStep?: number;
  reveal?: TaskReveal;
  onRevealed?: () => void;
  onOpenChat: (execution: TaskExecution, title: string) => void;
  onOpenRun: OpenRun;
}) {
  const { t } = useTranslation();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [assignment, setAssignment] = useState<TaskBlock>();
  const assignmentTrigger = useRef<HTMLButtonElement>(null);
  const [handoverSettings, setHandoverSettings] = useState(false);
  const handover = useQuery({
    ...noteHandoverQuery(note.id),
    enabled: visible,
  });
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [detail, setDetail] = useState<string>();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [find, setFind] = useState("");
  const [findStep, setFindStep] = useState(0);
  const [editingProject, setEditingProject] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const layout = useRef<HTMLDivElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const returnToEditor = useRef(false);
  const dispatch = useTaskDispatch();
  const [selection, setSelection] = useState<NoteSelection>();

  useEffect(() => {
    if (visible) return;
    setAssignment(undefined);
    setHandoverSettings(false);
  }, [visible]);

  const refreshSelection = useCallback((next: NoteSelection) => {
    setSelection((current) =>
      current?.doc === next.doc && current.pos === next.pos ? current : next,
    );
  }, []);
  const available = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
  const doc = selection?.doc;
  const activeLine = selection?.pos;
  const agentNames = useMemo(
    () => new Map(agents.map(({ id, name }) => [id, name])),
    [agents],
  );
  const lines = useMemo(() => {
    if (!doc) return [];
    return taskBlocks(doc, { includeListItems: true }).map((block) => {
      const execution = block.id ? executions.get(block.id) : undefined;
      const workflow = block.id ? workflows.get(block.id) : undefined;
      const status = taskStatus(block, execution, workflow);
      const executionAgentId = execution?.agentId ?? workflow?.queue?.agentId;
      const agentId = executionAgentId ?? block.agentId;
      const sending = !!block.id && sendingIds.has(block.id);
      return {
        ...block,
        oneClickAgentId:
          handover.isSuccess && handover.data.oneClick
            ? taskDispatchAgent(available, block.agentId, handover.data)?.id
            : undefined,
        sending,
        owner: agentId ? agentNames.get(agentId) : undefined,
        executionAgentId,
        linked: !!execution || status === "queued" || status === "closed",
        busy:
          sending ||
          status === "queued" ||
          status === "closed" ||
          (!!execution &&
            (active(execution.status) || execution.status === "queued")),
        status,
      };
    });
  }, [
    doc,
    agentNames,
    executions,
    workflows,
    handover.isSuccess,
    handover.data,
    available,
    sendingIds,
  ]);
  const headings = useMemo(() => {
    const items: { pos: number; level: number; text: string }[] = [];
    if (!outlineOpen) return items;
    doc?.descendants((node, pos) => {
      if (node.type.name !== "heading") return;
      const text = node
        .textBetween(0, node.content.size, " ", (child) =>
          child.type.name === "agentMention" ? "@" + child.attrs.label : "",
        )
        .trim();
      if (text) items.push({ pos, level: node.attrs.level, text });
      return false;
    });
    return items;
  }, [doc, outlineOpen]);
  const path = note.path?.split("/") ?? [];
  const archived = note.state === "archived";
  if (archived) path.shift();
  const folder = path.slice(0, -1);
  if (archived) folder.unshift(t("common.archived"));
  const title = note.title.trim() || t("tasks.note");
  const matches = useMemo(() => {
    const result: Range[] = [];
    const text = (finding ? find : search).trim().toLocaleLowerCase();
    if (text)
      doc?.descendants((node, pos) => {
        if (
          node.isTextblock &&
          node
            .textBetween(0, node.content.size, " ", (child) =>
              child.type.name === "agentMention" ? child.attrs.label : "",
            )
            .toLocaleLowerCase()
            .includes(text)
        )
          result.push({ from: pos, to: pos + node.nodeSize });
      });
    return result;
  }, [doc, find, finding, search]);
  const assignTask =
    assignment &&
    lines.find((line) =>
      assignment.id
        ? line.id === assignment.id
        : line.paragraph === assignment.paragraph,
    );
  const detailTask = lines.find((line) => detail && line.id === detail);
  const detailExecution = detail ? executions.get(detail) : undefined;
  const detailQueue =
    detail && !detailExecution ? workflows.get(detail)?.queue : undefined;
  const workflowUpdate = useTaskWorkflowUpdate(
    detail ? { id: detail, noteId: note.id, record: "note" } : undefined,
    detailQueue?.id,
  );

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width) setNarrow(entry.contentRect.width < 700);
    });
    if (layout.current) observer.observe(layout.current);
    return () => observer.disconnect();
  }, []);

  function locate(pos: number, focus = true) {
    if (!editor || editor.isDestroyed) return;
    if (focus)
      editor
        .chain()
        .focus(pos + 1, { scrollIntoView: false })
        .run();
    const node = editor.view.nodeDOM(pos);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
  }

  useEffect(() => {
    if (!editor || !reveal || !doc || editor.view.composing) return;
    const task = lines.find((line) => line.id === reveal.id);
    if (!task) toast.info(t("tasks.sourceRemoved"));
    else {
      setAssignment(undefined);
      setDetail(reveal.detail ? task.id : undefined);
      locate(task.pos, !reveal.detail);
    }
    onRevealed?.();
  }, [editor, reveal, doc, lines, onRevealed, t]);

  const locateSearchMatch = useEffectEvent((step: number) => {
    if (step && matches.length)
      locate(matches[(step - 1) % matches.length].from, false);
  });
  useEffect(() => locateSearchMatch(searchStep), [searchStep, editor]);

  async function dispatchLine(block: TaskBlock, options: TaskDispatchOptions) {
    if (
      !editor ||
      editor.isDestroyed ||
      editor.view.composing ||
      editor.state.doc.nodeAt(block.pos) !== block.paragraph
    )
      throw new Error(t("tasks.sourceRemoved"));
    const id = block.id ?? setTaskMarker(editor, block, false, false);
    if (!block.id)
      setAssignment((current) =>
        current?.paragraph === block.paragraph ? { ...current, id } : current,
      );
    setSendingIds((current) => new Set(current).add(id));
    try {
      finishTaskNoteComposition(note, editor.state.doc);
      await dispatch(
        { id, noteId: note.id, record: "note", images: taskImages(block) },
        options,
      );
      setAssignment((current) => (current?.id === id ? undefined : current));
    } finally {
      setSendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  function selectLine(pos: number, check: boolean, trigger: HTMLButtonElement) {
    if (!editor || editor.view.composing) return;
    const line = lines.find((item) => item.pos === pos);
    if (!line || editor.state.doc.nodeAt(pos) !== line.paragraph) return;
    if (check) {
      if (line.checkbox && !line.busy) setTaskMarker(editor, line, !line.done);
      return;
    }
    if (!line.title && !line.linked) return;
    if (line.linked || line.done) {
      setAssignment(undefined);
      setDetail(detail === line.id ? undefined : line.id);
    } else if (line.sending || handover.isPending) {
      return;
    } else if (line.oneClickAgentId) {
      setDetail(undefined);
      void dispatchLine(line, { agentId: line.oneClickAgentId }).catch(
        (error) =>
          toast.error(error instanceof Error ? error.message : String(error)),
      );
    } else if (assignTask?.pos === pos) {
      setAssignment(undefined);
    } else {
      setDetail(undefined);
      assignmentTrigger.current = trigger;
      setAssignment(line);
    }
  }

  const addAgent = useCallback(
    (id: string, agent: Agent) => {
      if (!editor || editor.isDestroyed || editor.view.composing) return;
      const task = taskBlocks(editor.state.doc).find((line) => line.id === id);
      if (
        !task?.title ||
        !task.checkbox ||
        task.done ||
        task.mention ||
        executions.has(id) ||
        workflows.get(id)?.queue ||
        workflows.get(id)?.closed
      )
        return;
      const lastText = task.paragraph.lastChild?.text;
      const content = agentMentionContent(agent);
      if (lastText && !/\s$/.test(lastText))
        content.unshift({ type: "text", text: " " });
      editor
        .chain()
        .focus()
        .insertContentAt(task.pos + task.paragraph.nodeSize - 1, content)
        .command(({ tr }) => {
          isolateNoteEdit(tr);
          return true;
        })
        .run();
    },
    [editor, executions, workflows],
  );

  const slots = useTaskControls({
    editor,
    doc,
    lines,
    active: activeLine,
    loadingHandover: handover.isPending,
    matches,
    assignment: assignTask?.pos,
    detail,
    inlineDetail: narrow ? detail : undefined,
    onAction: (action, pos, trigger) =>
      selectLine(pos, action === "check", trigger),
    t,
  });
  const agentPickers = useMemo(
    () =>
      Array.from(slots.agentSlots, ([id, slot]) =>
        createPortal(
          <TaskNoteAgentPicker
            agents={available}
            onSelect={(agent) => addAgent(id, agent)}
          />,
          slot,
          id,
        ),
      ),
    [slots.agentSlots, available, addAgent],
  );

  const closeDetail = () => {
    setDetail(undefined);
    if (detailTask) locate(detailTask.pos);
  };
  const result = detailTask && (
    <TaskDetail
      agents={agents}
      onOpenRun={onOpenRun}
      task={detailTask}
      execution={detailExecution}
      queue={detailQueue}
      workflowError={workflowUpdate.error}
      onWithdraw={
        detailQueue && !workflowUpdate.isPending
          ? () => workflowUpdate.mutate("withdraw")
          : undefined
      }
      onLocate={closeDetail}
      onClose={closeDetail}
      onComplete={() => editor && setTaskMarker(editor, detailTask, true)}
      onReopen={
        detailTask.status === "closed"
          ? workflowUpdate.isPending
            ? undefined
            : () => workflowUpdate.mutate("reopen")
          : detailTask.checkbox
            ? undefined
            : () => editor && setTaskMarker(editor, detailTask, false)
      }
      onOpenChat={() =>
        detailExecution && onOpenChat(detailExecution, detailTask.title)
      }
    />
  );
  const dispatchPanel = visible &&
    assignment &&
    assignTask &&
    !assignTask.linked && (
      <TaskDispatchPanel
        key={assignment.pos}
        task={{
          ...assignTask,
          noteId: note.id,
          images: taskImages(assignTask),
        }}
        agents={available}
        noteContext={{ title, text: taskPrompt(assignTask) }}
        dialog={{
          onCloseAutoFocus: (event) => {
            event.preventDefault();
            if (!visible || !editor || editor.isDestroyed) return;
            const trigger = assignmentTrigger.current;
            assignmentTrigger.current = null;
            const block = editor.view.nodeDOM(assignTask.pos);
            const action = trigger?.isConnected
              ? trigger
              : block instanceof HTMLElement
                ? block.querySelector<HTMLButtonElement>(".task-line-status")
                : null;
            if (action) action.focus({ preventScroll: true });
            else locate(assignTask.pos);
          },
        }}
        onCancel={() => setAssignment(undefined)}
        onDispatch={(options) => dispatchLine(assignTask, options)}
      />
    );
  const conflict = saveError instanceof TaskNoteConflict;
  async function recover() {
    if (editor?.view.composing) return;
    if (editor) finishTaskNoteComposition(note, editor.state.doc);
    setRecovering(true);
    try {
      const title = t("tasks.recoveredNote", {
        title: Array.from(note.title.trim() || t("tasks.note"))
          .slice(0, 75)
          .join(""),
      });
      const copy = await recoverTaskNote(note.id, title);
      if (copy) toast.success(t("tasks.recovered", { title: copy.title }));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRecovering(false);
    }
  }

  return (
    <div ref={layout} className="task-note-workspace">
      <header className="task-document-toolbar">
        <div className="task-document-crumb" title={path.join("/")}>
          {folder.length > 0 && (
            <>
              <span>{folder.join(" / ")}</span>
              <ChevronRight aria-hidden="true" />
            </>
          )}
          <Input
            className="task-document-title"
            aria-label={t("tasks.noteTitle")}
            value={note.title}
            placeholder={title}
            maxLength={100}
            onChange={(event) =>
              changeTaskNote(note, { title: event.target.value })
            }
          />
        </div>
        <TooltipProvider delayDuration={350}>
          <ToolbarButton
            ref={settingsTrigger}
            label={t("tasks.handoverSettings")}
            aria-haspopup="dialog"
            onClick={() => setHandoverSettings(true)}
          >
            <UserCog />
          </ToolbarButton>
        </TooltipProvider>
        <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.outline")}
            >
              <List />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="task-document-outline"
            side="bottom"
            align="start"
          >
            <nav aria-label={t("tasks.outline")}>
              {headings.length ? (
                headings.map((heading) => (
                  <Button
                    key={heading.pos}
                    variant="ghost"
                    size="sm"
                    style={{
                      paddingInlineStart: 8 + (heading.level - 1) * 10,
                    }}
                    onClick={() => {
                      setOutlineOpen(false);
                      locate(heading.pos, false);
                    }}
                  >
                    <span className="truncate">{heading.text}</span>
                  </Button>
                ))
              ) : (
                <p>{t("tasks.emptyOutline")}</p>
              )}
            </nav>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.noteActions")}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              aria-label={t("tasks.noteProject")}
              onSelect={() => setEditingProject(true)}
            >
              <Folder />
              {note.project || t("tasks.noteProject")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!editor}
              onSelect={() => assetInput.current?.click()}
            >
              <Paperclip />
              {t("tasks.addAsset")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover
          open={finding}
          onOpenChange={(open) => {
            setFinding(open);
            setFindStep(0);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.findInNote")}
            >
              <Search />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-2">
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setFindStep((step) => step + 1);
              }}
            >
              <Input
                type="search"
                aria-label={t("tasks.findInNote")}
                placeholder={t("tasks.findInNote")}
                value={find}
                onChange={(event) => {
                  setFind(event.target.value);
                  setFindStep(0);
                }}
              />
              {find && (
                <output className="text-xs text-muted-foreground">
                  {matches.length}
                </output>
              )}
            </form>
          </PopoverContent>
        </Popover>
        <ShareNote note={note}/>
        {toolbarAction ?? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("tasks.insertBlock")}
                disabled={!editor}
              >
                <Plus />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (!returnToEditor.current) return;
                returnToEditor.current = false;
                event.preventDefault();
                editor?.commands.focus();
              }}
            >
              {noteBlockItems.map(({ type, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={type}
                  onSelect={() => {
                    if (!editor || editor.view.composing) return;
                    const {
                      doc,
                      selection: { $from, empty },
                    } = editor.state;
                    const depth =
                      type !== "table" &&
                      type !== "columns" &&
                      $from.parent.isTextblock &&
                      noteTableDepth($from) !== undefined
                        ? $from.depth
                        : 1;
                    const chain = editor.chain().focus();
                    if (
                      !(
                        empty &&
                        $from.parent.type.name === "paragraph" &&
                        !$from.parent.content.size &&
                        !$from.parent.attrs.taskId &&
                        $from.depth === depth
                      )
                    ) {
                      const pos = $from.depth
                        ? $from.after(depth)
                        : doc.content.size;
                      chain
                        .insertContentAt(pos, { type: "paragraph" })
                        .setTextSelection(pos + 1);
                    }
                    returnToEditor.current = chain.setNoteBlock(type).run();
                  }}
                >
                  <Icon />
                  {t(label, { level: type })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div className="task-note-layout">
        <div className="task-note-scroll">
          <article className="task-note-article">
            {editingProject && (
              <TaskLabelDialog
                title={t("tasks.noteProject")}
                label={t("tasks.projectName")}
                initialValue={note.project}
                allowEmpty
                suggestions={[
                  ...new Set(
                    available.flatMap((agent) =>
                      agent.profile.roots.map((root) =>
                        directoryName(root.path),
                      ),
                    ),
                  ),
                ].filter(Boolean)}
                onClose={() => setEditingProject(false)}
                onSave={(project) => {
                  if (project !== (note.project ?? ""))
                    changeTaskNote(note, { project });
                }}
              />
            )}
            {!!saveError && (
              <div className="task-save-error">
                <ErrorNotice
                  error={conflict ? t("tasks.noteConflict") : saveError}
                  retry={
                    conflict
                      ? undefined
                      : () => void saveTaskNote(note.id).catch(() => {})
                  }
                />
                {conflict && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={recovering}
                    onClick={() => void recover()}
                  >
                    {t("tasks.recoverNote")}
                  </Button>
                )}
              </div>
            )}
            <TaskNoteEditor
              note={note}
              agents={agents}
              onEditor={setEditor}
              onStateChange={refreshSelection}
              onFindText={(text) => {
                setFind(text);
                setFindStep(0);
                setFinding(true);
              }}
              assetInput={assetInput}
            />
            {agentPickers}
            {narrow &&
              slots.detailSlot &&
              result &&
              createPortal(result, slots.detailSlot)}
          </article>
        </div>
        {!narrow && result}
      </div>
      {dispatchPanel}
      {visible && handoverSettings && (
        <NoteHandoverSettings
          note={note}
          agents={available}
          chats={chats}
          onClose={() => setHandoverSettings(false)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (visible)
              settingsTrigger.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
