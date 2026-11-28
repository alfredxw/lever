import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { NoteFindControl, type FindRequest } from "./NoteFindControl";
import { appendTaskBlocks, taskAtImagePosition } from "./noteImageEditing";
import { NoteTableSize, type TableSize } from "./NoteTableSize";
import { NoteOutline } from "./NoteOutline";
import { NoteImport } from "./NoteImport";
import { NoteBacklinks } from "./NoteBacklinks";
import { exportNoteMarkdown, printNote } from "./noteFiles";
import { ShareNote } from "./ShareNote";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import {
  ChevronRight,
  Ellipsis,
  Folder,
  List,
  Paperclip,
  Plus,
  UserCog,
} from "lucide-react";
import { toast } from "sonner";
import { active } from "@/api/client";
import type {
  Agent,
  Chat,
  TaskExecution,
  TaskNoteSummary,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  noteTaskIndex,
  taskPrompt,
  taskStatus,
  type TaskBlock,
} from "./taskDocument";
import {
  isolateNoteEdit,
  noteTableDepth,
  type NoteBlockType,
} from "./taskEditing";
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
  onOpenNote,
  library,
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
  onOpenNote: (id: string) => void;
  library: TaskNoteSummary[];
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
  const [outlineOpen, setOutlineOpen] = useState(
    () => localStorage.getItem("lever:notes:outline") === "true",
  );
  const [findRequest, setFindRequest] = useState<FindRequest>();
  const [editingProject, setEditingProject] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const layout = useRef<HTMLDivElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const returnToEditor = useRef(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const dispatch = useTaskDispatch();
  const [selection, setSelection] = useState<NoteSelection>();

  useEffect(() => {
    if (visible) return;
    setAssignment(undefined);
    setHandoverSettings(false);
  }, [visible]);

  const refreshSelection = useCallback((next: NoteSelection) => {
    setSelection((current) =>
      current && current.revision === next.revision && current.pos === next.pos
        ? current
        : next,
    );
  }, []);
  const available = useMemo(
    () => agents.filter((agent) => !agent.archived),
    [agents],
  );
  const doc = editor?.state.doc;
  const indexed = editor && noteTaskIndex.getState(editor.state)?.blocks;
  const activeLine = selection?.pos;
  const agentNames = useMemo(
    () => new Map(agents.map(({ id, name }) => [id, name])),
    [agents],
  );
  const lines = useMemo(() => {
    if (!doc) return [];
    return (indexed ?? []).map((block) => {
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
    indexed,
    agentNames,
    executions,
    workflows,
    handover.isSuccess,
    handover.data,
    available,
    sendingIds,
  ]);
  const path = note.path?.split("/") ?? [];
  const archived = note.state === "archived";
  if (archived) path.shift();
  const folder = path.slice(0, -1);
  if (archived) folder.unshift(t("common.archived"));
  const title = note.title.trim() || t("tasks.note");
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
    const current = noteTaskIndex
      .getState(editor.state)
      ?.blocks.find((item) => item.pos === pos);
    const decorated =
      current && lines.find((item) => item.paragraph === current.paragraph);
    if (!current || !decorated) return;
    const line = { ...decorated, ...current };
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

  function insertBlock(type: NoteBlockType, size?: TableSize) {
    if (!editor || editor.view.composing) return;
    const {
      doc,
      selection: { $from, empty },
    } = editor.state;
    const task = type === "noteWhiteboard" && taskAtImagePosition($from);
    if (task) {
      const tr = editor.state.tr;
      if (
        appendTaskBlocks(tr, task.id, [
          editor.schema.nodes.noteWhiteboard.create(),
        ])
      ) {
        isolateNoteEdit(tr);
        editor.view.dispatch(tr);
        returnToEditor.current = true;
        return;
      }
    }
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
      const pos = $from.depth ? $from.after(depth) : doc.content.size;
      chain
        .insertContentAt(pos, { type: "paragraph" })
        .setTextSelection(pos + 1);
    }
    returnToEditor.current = chain
      .setNoteBlock(type, false, undefined, size)
      .run();
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
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("tasks.outline")}
          aria-expanded={outlineOpen}
          onClick={() => {
            setOutlineOpen(!outlineOpen);
            localStorage.setItem("lever:notes:outline", String(!outlineOpen));
          }}
        >
          <List />
        </Button>
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
              disabled={!editor}
              onSelect={() =>
                editor &&
                void exportNoteMarkdown(title, editor).catch((e) =>
                  toast.error(String(e)),
                )
              }
            >
              {t("tasks.exportMarkdown")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!editor}
              onSelect={() =>
                editor &&
                void printNote(title, editor).catch((e) =>
                  toast.error(String(e)),
                )
              }
            >
              {t("tasks.printPDF")}
            </DropdownMenuItem>
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
        <NoteFindControl
          editor={editor}
          request={findRequest}
          search={search}
          searchStep={searchStep}
        />
        <NoteImport onOpen={onOpenNote} />
        <ShareNote note={note} />
        {toolbarAction ?? (
          <DropdownMenu open={insertOpen} onOpenChange={setInsertOpen}>
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
              {noteBlockItems.map(({ type, label, icon: Icon }) =>
                type === "table" ? (
                  <DropdownMenuSub key={type}>
                    <DropdownMenuSubTrigger>
                      <Icon />
                      {t(label)}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <NoteTableSize
                        onChoose={(size) => {
                          insertBlock(type, size);
                          setInsertOpen(false);
                        }}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem
                    key={type}
                    onSelect={() => insertBlock(type)}
                  >
                    <Icon />
                    {t(label, { level: type })}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div className="task-note-layout">
        {outlineOpen && editor && (
          <NoteOutline
            editor={editor}
            compact={narrow}
            onClose={() => setOutlineOpen(false)}
          />
        )}
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
              library={library}
              onOpenNote={onOpenNote}
              onEditor={setEditor}
              onStateChange={refreshSelection}
              onFindText={(text, replace = false) =>
                setFindRequest({ text, replace })
              }
              assetInput={assetInput}
            />
            <NoteBacklinks id={note.id} library={library} onOpen={onOpenNote} />
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
