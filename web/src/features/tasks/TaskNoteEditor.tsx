import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { FileText, Image, Paperclip, Plus } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { NodeSelection, Selection, type Transaction } from "@tiptap/pm/state";
import type { EditorProps } from "@tiptap/pm/view";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import type { Agent, TaskNote, TaskNoteSummary } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { textPrompt } from "@/features/chat/prompt";
import { NoteAgentsContext } from "./AgentMentionView";
import {
  NoteBlockMenu,
  noteBlockItems,
  noteBlockTarget,
  type NoteBlockTarget,
} from "./NoteBlockMenu";
import { noteImage, uploadNoteAsset } from "./noteAsset";
import {
  appendTaskBlocks,
  imageDropPosition,
  imageSlice,
  taskAtImagePosition,
} from "./noteImageEditing";
import { NoteTableSize, type TableSize } from "./NoteTableSize";
import { NoteImageGallery } from "./NoteImageGallery";
import { NoteTableControls } from "./NoteTableControls";
import { tableAtSelection, type NoteTableTarget } from "./NoteTableMenu";
import { NoteInlineToolbar } from "./NoteInlineToolbar";
import {
  agentMentionContent,
  parseTaskMarkdown,
  taskDocumentChange,
  taskNoteExtensions,
  noteTaskIndex,
} from "./taskDocument";
import {
  isolateNoteEdit,
  showTaskImageDrop,
  type NoteBlockType,
} from "./taskEditing";
import {
  changeTaskNoteDocument,
  finishTaskNoteComposition,
  markTaskNoteComposing,
  noteDraftDocument,
  saveTaskNote,
  taskNoteSnapshot,
} from "./useTaskNote";

const basicBlockItems = noteBlockItems.filter(
  ({ type }) => !["table", "columns", "noteWhiteboard"].includes(String(type)),
);
const commonBlockItems = [
  noteBlockItems.find(({ type }) => type === "task")!,
  { type: "image", label: "tasks.block.image", icon: Image },
  { type: "file", label: "tasks.block.file", icon: Paperclip },
  ...noteBlockItems.filter(
    ({ type }) =>
      type === "table" ||
      type === "columns" ||
      type === "callout" ||
      type === "noteWhiteboard",
  ),
] as const;

const blockKeywords: Record<string, string> = {
  paragraph: "duanluo dl zhengwen zw",
  bulletList: "wuxuliebiao wxlb",
  orderedList: "youxuliebiao yxlb",
  task: "daiban db renwu rw",
  blockquote: "yinyong yy",
  codeBlock: "daimakuai dmk",
  callout: "gaoliangkuai glk tishikuai tsk",
  columns: "fenlan fl",
  table: "biaoge bg",
  horizontalRule: "fengexian fgx",
  noteWhiteboard: "huaban hb drawnix whiteboard",
  image: "tupian tp",
  file: "wenjian wj fujian fj",
};
const blockSyntax: Record<string, string> = {
  bulletList: "- ␣",
  orderedList: "1. ␣",
  task: "[ ] ␣",
  blockquote: "> ␣",
  codeBlock: "```",
  horizontalRule: "---",
};
type InsertKind = NoteBlockType | "image" | "file";

type SuggestionQuery = {
  from: number;
  to: number;
  text: string;
} & (
  | { kind: "mention" }
  | { kind: "slash"; allowed: InsertKind[]; manual?: boolean }
);

export type NoteSelection = { revision?: object; pos: number | undefined };

function noteSelection(editor: Editor): NoteSelection {
  const {
    selection: { $from },
  } = editor.state;
  return {
    revision: noteTaskIndex.getState(editor.state)?.revision,
    pos:
      $from.parent.type.name === "paragraph" &&
      (!$from.parent.content.size ||
        $from.parent.attrs.taskId ||
        $from.node(-1).type.name === "listItem")
        ? $from.before()
        : undefined,
  };
}

function mentionAtCaret(editor: Editor): SuggestionQuery | undefined {
  const { $from, empty } = editor.state.selection;
  if (
    !empty ||
    !["paragraph", "heading"].includes($from.parent.type.name) ||
    editor.isActive("code")
  )
    return;
  const before = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
  const match = /(?:^|[^\w@.+\uFFFC-])@([^@\n\ufffc]{0,100})$/.exec(before);
  if (match)
    return {
      kind: "mention",
      from: $from.pos - match[1].length - 1,
      to: $from.pos,
      text: match[1],
    };
}

function slashAtCaret(editor: Editor): SuggestionQuery | undefined {
  const { $from, empty } = editor.state.selection;
  if (
    !empty ||
    $from.parent.type.name !== "paragraph" ||
    $from.parent.attrs.taskId ||
    editor.isActive("code")
  )
    return;
  const before = $from.parent.textBetween(0, $from.parentOffset, "", "\ufffc");
  const match = /(?:^|\s)[/、]([\p{L}\p{N}-]*)$/u.exec(before);
  if (!match) return;
  const from = $from.pos - match[1].length - 1;
  const to = $from.pos;
  return {
    kind: "slash",
    from,
    to,
    text: match[1],
    allowed: [
      ...noteBlockItems
        .filter(({ type }) =>
          editor.can().setNoteBlock(type, false, { from, to }),
        )
        .map(({ type }) => type),
      "image",
      "file",
    ],
  };
}

export function TaskNoteEditor({
  note,
  agents,
  library,
  onOpenNote,
  onEditor,
  onStateChange,
  onFindText,
  assetInput,
}: {
  note: TaskNote;
  agents: Agent[];
  library: TaskNoteSummary[];
  onOpenNote: (id: string) => void;
  onEditor: (editor: Editor | null) => void;
  onStateChange: (state: NoteSelection) => void;
  onFindText: (text: string, replace?: boolean) => void;
  assetInput: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [suggestion, setSuggestion] = useState<SuggestionQuery>();
  const suggestionRef = useRef<SuggestionQuery>(undefined);
  const [pickingSize, setPickingSize] = useState(false);
  function showSuggestion(next?: SuggestionQuery) {
    setPickingSize(false);
    suggestionRef.current = next;
    setSuggestion(next);
  }
  const [imagePosition, setImagePosition] = useState<number>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeEmpty, setActiveEmpty] = useState<number>();
  const assetTrigger = useRef<{
    doc: ProseMirrorNode;
    range: { from: number; to: number };
  }>(undefined);
  const dismissed = useRef<number | undefined>(undefined);
  const [hoveredBlock, setHoveredBlock] = useState<NoteBlockTarget>();
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [hoveredTable, setHoveredTable] = useState<NoteTableTarget>();
  const [selectedTable, setSelectedTable] = useState<NoteTableTarget>();
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const [, updateTableSelection] = useState(0);
  const [initialContent] = useState(() => {
    const draft = taskNoteSnapshot(note);
    return (draft.doc?.toJSON() ?? draft.note.content) as JSONContent;
  });
  const composing = useRef(false);
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const extensions = useMemo(() => taskNoteExtensions(note.id), [note.id]);
  const noteAgents = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const slash = suggestion?.kind === "slash" ? suggestion : undefined;
  const mention = suggestion?.kind === "mention" ? suggestion : undefined;
  const query = suggestion?.text.trim().toLocaleLowerCase() ?? "";
  const matches = useMemo(() => {
    if (slash) {
      const groups = query
        ? ([
            ["common", commonBlockItems],
            ["basic", basicBlockItems],
          ] as const)
        : ([
            ["basic", basicBlockItems],
            ["common", commonBlockItems],
          ] as const);
      const seen = new Set<InsertKind>();
      return groups
        .flatMap(([group, items]) =>
          items.flatMap((item) => {
            const label = t(item.label, { level: item.type });
            const alias =
              typeof item.type === "number" ? `h${item.type}` : item.type;
            if (
              !slash.allowed.includes(item.type) ||
              (query && seen.has(item.type)) ||
              !`${label} ${t(item.label, { level: item.type, lng: "en-US" })} ${alias} ${typeof item.type === "number" ? "biaoti bt" + item.type : blockKeywords[item.type]}`
                .toLocaleLowerCase()
                .includes(query)
            )
              return [];
            seen.add(item.type);
            return [
              {
                rank: [
                  label,
                  String(alias),
                  ...(blockKeywords[item.type] || "").split(" "),
                ].some((v) => v.toLowerCase().startsWith(query))
                  ? 0
                  : 1,
                hint:
                  typeof item.type === "number"
                    ? "#".repeat(item.type) + " ␣"
                    : blockSyntax[item.type] ||
                      ("key" in item ? String(item.key) : ""),
                id: group + "-" + item.type,
                label,
                icon: item.icon,
                type: item.type,
                group,
              },
            ];
          }),
        )
        .sort((a, b) => (query ? a.rank - b.rank : 0));
    }
    return mention
      ? [
          ...agents
            .filter(
              (agent) =>
                !agent.archived &&
                agent.name.toLocaleLowerCase().includes(query),
            )
            .slice(0, 30)
            .map((agent) => ({ id: agent.id, label: agent.name, agent })),
          ...library
            .filter(
              (n) =>
                n.id !== note.id &&
                n.state !== "deleted" &&
                !n.conflict &&
                n.title.toLocaleLowerCase().includes(query),
            )
            .slice(0, 20)
            .map((n) => ({
              id: n.id,
              label: n.title,
              linkedNote: n,
              icon: FileText,
            })),
        ]
      : [];
  }, [slash, mention, query, agents, library, note.id, t]);

  const selected = matches[activeIndex] ?? matches[0];

  function updateSuggestions(editor: Editor) {
    if (composing.current || editor.view.composing) return;
    const next = slashAtCaret(editor) ?? mentionAtCaret(editor);
    const current = suggestionRef.current;
    if (
      !next &&
      current?.kind === "slash" &&
      current.manual &&
      editor.state.selection.empty &&
      editor.state.selection.from === current.from &&
      !editor.state.selection.$from.parent.content.size
    )
      return;
    if (!next) dismissed.current = undefined;
    if (next && next.from === dismissed.current) return;
    if (
      current?.kind === next?.kind &&
      current?.from === next?.from &&
      current?.to === next?.to &&
      current?.text === next?.text &&
      !(current?.kind === "slash" && current.manual && next)
    )
      return;
    showSuggestion(next);
  }

  function dismiss() {
    const current = suggestionRef.current;
    dismissed.current =
      current?.kind === "slash" && current.manual ? undefined : current?.from;
    showSuggestion();
  }

  function chooseAgent(agent: Agent) {
    if (!editor || !mention || composing.current || editor.view.composing)
      return;
    const query = mentionAtCaret(editor);
    if (
      !query ||
      query.from !== mention.from ||
      query.to !== mention.to ||
      query.text !== mention.text
    )
      return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: query.from, to: query.to },
        agentMentionContent(agent),
      )
      .run();
    showSuggestion();
  }

  function chooseBlock(type: InsertKind, size?: TableSize) {
    if (!editor || !slash || composing.current || editor.view.composing) return;
    const current = slash.manual ? slash : slashAtCaret(editor);
    if (current?.from !== slash.from || current.to !== slash.to) return;
    if (type === "table" && !size) {
      setPickingSize(true);
      return;
    }
    const trigger = { from: current.from, to: current.to };
    if (type === "image" || type === "file") {
      if (!assetInput.current) return;
      assetTrigger.current = { doc: editor.state.doc, range: trigger };
      assetInput.current.accept = type === "image" ? "image/*" : "";
      assetInput.current.click();
      return;
    }
    const chain = editor.chain().focus();
    if (slash.manual) chain.setTextSelection(slash.from);
    if (
      chain
        .setNoteBlock(type, false, slash.manual ? undefined : trigger, size)
        .run()
    )
      showSuggestion();
  }

  function openBlockPicker(position: number) {
    if (!editor || editor.view.composing) return;
    editor.commands.setTextSelection(position);
    dismissed.current = undefined;
    setActiveIndex(0);
    showSuggestion({
      kind: "slash",
      from: position,
      to: position,
      text: "",
      manual: true,
      allowed: [
        ...noteBlockItems
          .filter(({ type }) => editor.can().setNoteBlock(type))
          .map(({ type }) => type),
        "image",
        "file",
      ],
    });
    editor.view.focus();
  }

  function choose(item: NonNullable<typeof selected>) {
    if ("agent" in item) chooseAgent(item.agent);
    else if (
      "linkedNote" in item &&
      editor &&
      mention &&
      !editor.view.composing
    ) {
      editor
        .chain()
        .focus()
        .insertContentAt({ from: mention.from, to: mention.to }, [
          { type: "noteLink", attrs: { id: item.id, label: item.label } },
          { type: "text", text: " " },
        ])
        .run();
      showSuggestion();
    } else if ("type" in item) chooseBlock(item.type);
  }

  function tableTarget(
    editor: Editor,
    pos: number,
  ): NoteTableTarget | undefined {
    const view = editor.view.nodeDOM(pos);
    const element =
      view instanceof HTMLElement ? view.querySelector("table") : null;
    if (element instanceof HTMLTableElement) return { element, pos };
  }

  function refreshTable(editor: Editor, position = tableAtSelection(editor)) {
    const next =
      position === undefined ? undefined : tableTarget(editor, position);
    setSelectedTable((current) =>
      current?.pos === next?.pos && current?.element === next?.element
        ? current
        : next,
    );
  }

  const hoverFrame = useRef(0);
  const lastBlock = useRef<{ element: HTMLElement; doc: ProseMirrorNode }>(
    undefined,
  );
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    cancelAnimationFrame(hoverFrame.current);
    const { target, currentTarget, clientX, pointerType } = event;
    hoverFrame.current = requestAnimationFrame(() =>
      updateHover(target as HTMLElement, currentTarget, clientX, pointerType),
    );
  }
  function updateHover(
    target: HTMLElement,
    container: HTMLDivElement,
    clientX: number,
    pointerType: string,
  ) {
    if (
      !editor ||
      editor.isDestroyed ||
      composing.current ||
      blockMenuOpen ||
      tableMenuOpen ||
      suggestion ||
      pointerType === "touch"
    )
      return;
    const view = editor.view;
    if (
      target.closest(
        ".task-note-block-trigger, .task-note-empty-trigger, .note-table-controls",
      )
    )
      return;
    const tbody = target.closest(".tableWrapper")?.querySelector("tbody");
    if (tbody && view.dom.contains(tbody)) {
      const pos = view.posAtDOM(tbody, 0) - 1;
      const next = tableTarget(editor, pos);
      setHoveredTable((current) =>
        current?.pos === next?.pos && current?.element === next?.element
          ? current
          : next,
      );
      setHoveredBlock(undefined);
      return;
    }
    setHoveredTable(undefined);
    if (target === container && clientX < view.dom.getBoundingClientRect().left)
      return;
    const node = target.closest("p, h1, h2, h3, h4, h5, h6, pre");
    if (
      !(node instanceof HTMLElement) ||
      !view.dom.contains(node) ||
      node.closest('[contenteditable="false"]') ||
      view.composing
    ) {
      setHoveredBlock(undefined);
      return;
    }
    if (
      lastBlock.current?.element === node &&
      lastBlock.current.doc === view.state.doc &&
      hoveredBlock
    )
      return;
    lastBlock.current = { element: node, doc: view.state.doc };
    const next = noteBlockTarget(editor, view.posAtDOM(node, 0), container);
    setHoveredBlock((previous) =>
      previous?.doc === next?.doc &&
      previous?.position === next?.position &&
      previous?.lineCenter === next?.lineCenter
        ? previous
        : next,
    );
  }

  function syncNote(editor: Editor) {
    const incoming = noteDraftDocument(taskNoteSnapshot(note), editor.schema);
    const change = taskDocumentChange(editor.state.doc, incoming);
    if (!change) return;
    const tr = editor.state.tr
      .setMeta("preventUpdate", true)
      .setMeta("addToHistory", false);
    if (!tr.maybeStep(change).doc?.eq(incoming)) {
      editor.view.dispatch(
        editor.state.tr
          .replaceWith(0, editor.state.doc.content.size, incoming.content)
          .setMeta("preventUpdate", true)
          .setMeta("addToHistory", false),
      );
    } else editor.view.dispatch(tr);
    showSuggestion();
    setHoveredBlock(undefined);
    setBlockMenuOpen(false);
  }

  async function insertAssets(
    editor: Editor,
    files: File[],
    at: number,
    trigger?: typeof assetTrigger.current,
  ) {
    const task = taskAtImagePosition(editor.state.doc.resolve(at));
    let position = at;
    const mapPosition = ({ transaction }: { transaction: Transaction }) => {
      position = transaction.mapping.map(position);
    };
    editor.on("transaction", mapPosition);
    try {
      let assets: ProseMirrorNode[] = [];
      for (const file of files) {
        const asset = await uploadNoteAsset(note.id, file);
        if (editor.isDestroyed) return;
        assets.push(editor.schema.nodes.noteAsset.create(asset));
      }
      if (editor.view.composing)
        throw new Error(t("tasks.assetDuringComposition"));
      const tr = editor.state.tr;
      if (
        trigger?.doc === editor.state.doc &&
        trigger.range.from < trigger.range.to
      ) {
        tr.delete(trigger.range.from, trigger.range.to);
        showSuggestion();
      }
      const images = task ? assets.filter(noteImage) : [];
      if (task && images.length) {
        if (!appendTaskBlocks(tr, task.id, images))
          throw new Error(t("tasks.sourceRemoved"));
        assets = assets.filter((asset) => !noteImage(asset));
      }
      if (assets.length) {
        const resolved = tr.doc.resolve(tr.mapping.map(position));
        const after = resolved.depth ? resolved.after(1) : resolved.pos;
        if (after === tr.doc.content.size)
          assets.push(editor.schema.nodes.paragraph.create());
        const content = Fragment.fromArray(assets);
        tr.insert(after, content);
        if (!images.length)
          tr.setSelection(
            Selection.near(tr.doc.resolve(after + content.size), -1),
          );
      }
      isolateNoteEdit(tr);
      editor.view.focus();
      editor.view.dispatch(tr.scrollIntoView());
    } catch (error) {
      toast.error(String(error));
    } finally {
      editor.off("transaction", mapPosition);
    }
  }

  const handlers = {
    handleKeyDown: (view, event) => {
      if (view.composing || event.isComposing || event.keyCode === 229)
        return false;
      const mod = event.metaKey || event.ctrlKey;
      if (
        mod &&
        !event.altKey &&
        ((event.key.toLowerCase() === "f" && !event.shiftKey) ||
          (event.key.toLowerCase() === "h" && event.shiftKey))
      ) {
        const { from, to } = view.state.selection;
        const selected = view.state.doc.textBetween(from, to, "\n");
        onFindText(selected.includes("\n") ? "" : selected, event.shiftKey);
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      setHoveredBlock(undefined);
      if (
        !suggestion &&
        event.shiftKey &&
        event.key === "F10" &&
        editor &&
        root.current
      ) {
        const table = tableAtSelection(editor);
        if (table !== undefined) {
          refreshTable(editor, table);
          setHoveredTable(undefined);
          setTableMenuOpen(true);
          return true;
        }
        const block = noteBlockTarget(
          editor,
          view.state.selection.$head.pos,
          root.current,
        );
        if (!block) return false;
        if (block.empty) {
          openBlockPicker(block.position);
          return true;
        }
        setHoveredBlock(block);
        setBlockMenuOpen(true);
        return true;
      }
      if (!suggestion) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return true;
      }
      const horizontal =
        event.key === "ArrowLeft" || event.key === "ArrowRight";
      const vertical = event.key === "ArrowDown" || event.key === "ArrowUp";
      if (matches.length && (vertical || (horizontal && slash && !query))) {
        event.preventDefault();
        const index = Math.max(
          0,
          matches.findIndex((item) => item.id === selected?.id),
        );
        const grid =
          slash &&
          !query &&
          selected &&
          "group" in selected &&
          selected.group === "basic";
        const basicCount = matches.filter(
          (item) => "group" in item && item.group === "basic",
        ).length;
        const direction =
          event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        const next =
          grid && vertical && direction > 0
            ? Math.min(
                index + 6,
                basicCount < matches.length ? basicCount : matches.length - 1,
              )
            : grid && vertical && index >= 6
              ? index - 6
              : (index + matches.length + direction) % matches.length;
        setActiveIndex(next);
        return true;
      }
      if (
        selected &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "Enter" || (mention && event.key === "Tab"))
      ) {
        event.preventDefault();
        choose(selected);
        return true;
      }
      return false;
    },
    handleDOMEvents: {
      dragstart: (view, event) => {
        const target =
          event.target instanceof HTMLElement &&
          event.target.closest("figure[data-note-image]");
        if (
          target &&
          view.dom.contains(target) &&
          view.editable &&
          !view.composing
        ) {
          const { doc, selection } = view.state;
          const pos = view.posAtDOM(target, 0, -1);
          if (
            noteImage(doc.nodeAt(pos)) &&
            (selection.empty || pos < selection.from || pos >= selection.to)
          )
            view.dispatch(
              view.state.tr.setSelection(NodeSelection.create(doc, pos)),
            );
        }
        return false;
      },
      dragover: (view, event) => {
        const image =
          imageSlice(view.dragging?.slice) ||
          Array.from(event.dataTransfer?.items ?? []).some(
            (item) => item.kind === "file" && item.type.startsWith("image/"),
          );
        const target =
          image && view.editable && !view.composing
            ? imageDropPosition(view, event)?.task
            : undefined;
        showTaskImageDrop(view, target?.pos ?? null);
        return false;
      },
      dragleave: (view, event) => {
        if (
          !(event.relatedTarget instanceof globalThis.Node) ||
          !view.dom.contains(event.relatedTarget)
        )
          showTaskImageDrop(view, null);
        return false;
      },
      dragend: (view) => {
        showTaskImageDrop(view, null);
        return false;
      },
      compositionstart: () => {
        clearTimeout(compositionTimer.current);
        composing.current = true;
        showSuggestion();
        setHoveredBlock(undefined);
        return false;
      },
      compositionend: () => {
        clearTimeout(compositionTimer.current);
        // ProseMirror reads the final DOM change after this event handler.
        compositionTimer.current = setTimeout(() => {
          if (!editor || editor.isDestroyed || editor.view.composing) return;
          composing.current = false;
          finishTaskNoteComposition(note, editor.state.doc);
          syncNote(editor);
          onStateChange(noteSelection(editor));
          updateSuggestions(editor);
        });
        return false;
      },
    },
    clipboardTextParser: (text, $context, plain, view) => {
      const literal =
        plain || $context.marks().some((mark) => mark.type.spec.code);
      const content = Fragment.fromJSON(
        view.state.schema,
        (literal ? textPrompt(text) : parseTaskMarkdown(text)).content,
      );
      return Slice.maxOpen(content);
    },
    handleDrop: (view, event, slice, moved) => {
      showTaskImageDrop(view, null);
      if (!editor || view.composing) return false;
      const files = Array.from(event.dataTransfer?.files ?? []);
      const target = imageDropPosition(view, event);
      if (!moved && files.length) {
        void insertAssets(
          editor,
          files,
          target?.task
            ? target.task.pos + 1
            : (target?.pos ?? view.state.selection.to),
        );
        return true;
      }
      const images = imageSlice(slice);
      if (!target?.task || !images) return false;
      const { doc, selection } = view.state;
      const tr = view.state.tr;
      if (moved) {
        if (
          !(selection instanceof NodeSelection) ||
          images.length !== 1 ||
          !selection.node.eq(images[0])
        )
          return false;
        tr.delete(selection.from, selection.to);
      }
      if (!appendTaskBlocks(tr, target.task.id, images)) return false;
      if (!tr.doc.eq(doc)) {
        isolateNoteEdit(tr);
        view.focus();
        view.dispatch(tr.setMeta("uiEvent", "drop").scrollIntoView());
      }
      return true;
    },
    handlePaste: (view, event, slice) => {
      const data = event.clipboardData;
      const files = Array.from(data?.files ?? []);
      if (files.length && editor && !view.composing) {
        void insertAssets(editor, files, view.state.selection.to);
        return true;
      }
      if (
        !slice.size ||
        view.state.selection.$from.parent.type.spec.code ||
        data?.types.includes("vscode-editor-data")
      )
        return false;
      // The clipboard parser already chose Markdown or literal text. Do
      // not run Tiptap's Markdown paste rules over the parsed slice again.
      const tr = view.state.tr;
      const images = imageSlice(slice);
      const task = images && taskAtImagePosition(view.state.selection.$from);
      if (!images || !task || !appendTaskBlocks(tr, task.id, images))
        tr.replaceSelection(slice);
      tr.scrollIntoView().setMeta("paste", true);
      isolateNoteEdit(tr);
      view.dispatch(tr);
      return true;
    },
  } satisfies EditorProps;
  const latestHandlers = useRef(handlers);
  latestHandlers.current = handlers;
  const hasSuggestion = !!suggestion;
  const optionId = selected?.id;
  // Updating editorProps redraws the ProseMirror view. Keep the handlers
  // current without replacing its props on ordinary keystrokes.
  const editorProps = useMemo<EditorProps>(
    () => ({
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("tasks.note"),
        "aria-autocomplete": "list",
        ...(hasSuggestion && {
          "aria-controls": id,
          ...(optionId && { "aria-activedescendant": id + "-" + optionId }),
        }),
        "data-placeholder": t("tasks.placeholder"),
        class: "task-note-prose",
      },
      handleKeyDown: (...args) => latestHandlers.current.handleKeyDown(...args),
      handleDOMEvents: {
        dragstart: (...args) =>
          latestHandlers.current.handleDOMEvents.dragstart(...args),
        dragover: (...args) =>
          latestHandlers.current.handleDOMEvents.dragover(...args),
        dragleave: (...args) =>
          latestHandlers.current.handleDOMEvents.dragleave(...args),
        dragend: (view) => latestHandlers.current.handleDOMEvents.dragend(view),
        compositionstart: () =>
          latestHandlers.current.handleDOMEvents.compositionstart(),
        compositionend: () =>
          latestHandlers.current.handleDOMEvents.compositionend(),
      },
      clipboardTextParser: (...args) =>
        latestHandlers.current.clipboardTextParser(...args),
      handleDrop: (...args) => latestHandlers.current.handleDrop(...args),
      handlePaste: (...args) => latestHandlers.current.handlePaste(...args),
    }),
    [hasSuggestion, id, optionId, t],
  );
  const editor: Editor | null = useEditor({
    immediatelyRender: false,
    extensions,
    content: initialContent,
    editorProps,
    onUpdate: ({ editor, transaction }) => {
      if (composing.current || editor.view.composing)
        markTaskNoteComposing(note.id, transaction.before);
      else changeTaskNoteDocument(note, transaction.before, editor.state.doc);
    },
    onTransaction: ({ editor, transaction, appendedTransactions }) => {
      if (composing.current || editor.view.composing) return;
      if (transaction.docChanged || transaction.selectionSet) {
        refreshTable(editor);
        const { $head, empty } = editor.state.selection;
        setActiveEmpty(
          empty &&
            $head.parent.type.name === "paragraph" &&
            !$head.parent.content.size &&
            !$head.parent.attrs.taskId
            ? $head.pos
            : undefined,
        );
      }
      if (
        transaction.selectionSet &&
        !transaction.docChanged &&
        tableAtSelection(editor) !== undefined
      )
        updateTableSelection((value) => value + 1);
      if (transaction.docChanged) setHoveredTable(undefined);
      if (
        transaction.docChanged ||
        appendedTransactions.some((tr) => tr.docChanged)
      ) {
        onStateChange(noteSelection(editor));
        updateSuggestions(editor);
      }
    },
    onSelectionUpdate: ({ editor, transaction }) => {
      if (composing.current || editor.view.composing || transaction.docChanged)
        return;
      onStateChange(noteSelection(editor));
      updateSuggestions(editor);
    },
  });

  useEffect(() => {
    onEditor(editor);
    if (editor) onStateChange(noteSelection(editor));
    return () => {
      clearTimeout(compositionTimer.current);
      if (editor && !editor.isDestroyed && !editor.view.composing)
        finishTaskNoteComposition(note, editor.state.doc);
      else finishTaskNoteComposition(note);
      void saveTaskNote(note.id).catch(() => {});
      onEditor(null);
    };
  }, [editor, onEditor, onStateChange]);

  useLayoutEffect(() => {
    if (!editor || composing.current || editor.view.composing) return;
    syncNote(editor);
  }, [editor, note]);

  useEffect(() => {
    const input = assetInput.current;
    function reset() {
      assetTrigger.current = undefined;
      if (input) input.accept = "";
    }
    input?.addEventListener("cancel", reset);
    return () => input?.removeEventListener("cancel", reset);
  }, [assetInput]);

  useEffect(() => setActiveIndex(0), [suggestion?.from, suggestion?.text]);
  useEffect(() => {
    menu.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);

  const table = hoveredTable ?? selectedTable;
  const caret =
    editor &&
    root.current &&
    (activeEmpty !== undefined || editor.state.doc.childCount === 1) &&
    noteBlockTarget(
      editor,
      activeEmpty ?? editor.state.selection.$head.pos,
      root.current,
    );
  const emptyBlock =
    !table &&
    (hoveredBlock?.empty
      ? hoveredBlock
      : caret && caret.empty
        ? caret
        : undefined);
  const rect =
    suggestion && root.current && editor?.view.coordsAtPos(suggestion.to);
  const bounds = rect && root.current?.getBoundingClientRect();
  return (
    <Popover open={!!rect} onOpenChange={(open) => !open && dismiss()}>
      <div
        ref={root}
        className="task-note-editor"
        onDoubleClick={(e) => {
          const image = (e.target as Element).closest(
            "figure[data-note-image] img",
          );
          const figure = image?.parentElement;
          if (editor && figure && editor.view.dom.contains(figure)) {
            const pos = editor.view.posAtDOM(
              figure.parentNode!,
              Array.prototype.indexOf.call(
                figure.parentNode!.childNodes,
                figure,
              ),
            );
            if (noteImage(editor.state.doc.nodeAt(pos))) setImagePosition(pos);
          }
        }}
        onClick={(e) => {
          const link = (e.target as Element).closest<HTMLButtonElement>(
            "[data-note-link]",
          );
          if (link?.dataset.noteLink) onOpenNote(link.dataset.noteLink);
        }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          cancelAnimationFrame(hoverFrame.current);
          lastBlock.current = undefined;
          if (!blockMenuOpen) setHoveredBlock(undefined);
          if (!tableMenuOpen) setHoveredTable(undefined);
        }}
      >
        <input
          ref={assetInput}
          type="file"
          hidden
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            const trigger = assetTrigger.current;
            assetTrigger.current = undefined;
            event.currentTarget.accept = "";
            if (editor && files.length && !editor.view.composing)
              void insertAssets(
                editor,
                files,
                editor.state.selection.to,
                trigger,
              );
          }}
        />
        <NoteAgentsContext value={noteAgents}>
          <EditorContent editor={editor} />
        </NoteAgentsContext>
        {emptyBlock && (!suggestion || slash?.manual) && (
          <Button
            variant="outline"
            size="icon-xs"
            className="task-note-empty-trigger"
            aria-label={t("tasks.addBlock")}
            style={{ top: emptyBlock.lineCenter }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!slash?.manual) openBlockPicker(emptyBlock.position);
            }}
          >
            <Plus />
          </Button>
        )}
        {editor &&
          !suggestion &&
          hoveredBlock &&
          !hoveredBlock.empty &&
          (blockMenuOpen || hoveredBlock.doc === editor.state.doc) && (
            <NoteBlockMenu
              key={hoveredBlock.position}
              editor={editor}
              target={hoveredBlock}
              open={blockMenuOpen}
              onOpenChange={(open) => {
                setBlockMenuOpen(open);
                if (!open) setHoveredBlock(undefined);
              }}
            />
          )}
        {editor && root.current && table && !suggestion && (
          <NoteTableControls
            key={table.pos}
            editor={editor}
            target={table}
            root={root.current}
            open={tableMenuOpen}
            onOpenChange={setTableMenuOpen}
          />
        )}
        {editor && (
          <NoteInlineToolbar
            editor={editor}
            onPreviewImage={setImagePosition}
            scrollTarget={
              root.current?.closest<HTMLElement>(".task-note-scroll") ??
              undefined
            }
            onFindText={onFindText}
          />
        )}
        {editor && imagePosition !== undefined && (
          <NoteImageGallery
            editor={editor}
            position={imagePosition}
            onClose={() => setImagePosition(undefined)}
          />
        )}
        {rect && bounds && (
          <PopoverAnchor asChild>
            <span
              className="task-mention-anchor"
              aria-hidden="true"
              style={{
                left: rect.left - bounds.left,
                top: rect.bottom - bounds.top,
              }}
            />
          </PopoverAnchor>
        )}
      </div>
      <PopoverContent
        ref={menu}
        align="start"
        sideOffset={4}
        className={
          slash ? "task-mention-menu task-insert-menu" : "task-mention-menu"
        }
        role="listbox"
        id={id}
        aria-label={t(slash ? "tasks.addBlock" : "tasks.selectAgent")}
        onInteractOutside={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            (target.closest(".task-note-empty-trigger") ||
              (event.detail.originalEvent.type === "focusin" &&
                editor?.view.dom.contains(target)))
          )
            event.preventDefault();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {pickingSize && slash ? (
          <NoteTableSize onChoose={(size) => chooseBlock("table", size)} />
        ) : matches.length ? (
          (slash && !query
            ? (["basic", "common"] as const)
            : (["flat"] as const)
          ).map((group) => {
            const items =
              group === "flat"
                ? matches
                : matches.filter(
                    (item) => "group" in item && item.group === group,
                  );
            return (
              items.length > 0 && (
                <div
                  key={group}
                  role={group === "flat" ? undefined : "group"}
                  aria-label={
                    group === "flat"
                      ? undefined
                      : t("tasks.insertGroup." + group)
                  }
                  className={group === "basic" ? "task-insert-grid" : undefined}
                >
                  {group !== "flat" && (
                    <div className="task-insert-group-label">
                      {t("tasks.insertGroup." + group)}
                    </div>
                  )}
                  {items.map((item) => (
                    <Button
                      key={item.id}
                      id={id + "-" + item.id}
                      type="button"
                      variant="ghost"
                      role="option"
                      tabIndex={-1}
                      aria-label={item.label}
                      aria-selected={selected?.id === item.id}
                      title={
                        item.label +
                        ("hint" in item && item.hint ? " · " + item.hint : "")
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() =>
                        setActiveIndex(
                          matches.findIndex((entry) => entry.id === item.id),
                        )
                      }
                      onClick={() => choose(item)}
                    >
                      {"agent" in item ? (
                        <AgentAvatar agent={item.agent} size="sm" />
                      ) : (
                        <item.icon aria-hidden="true" />
                      )}
                      {group !== "basic" && (
                        <span className="truncate">{item.label}</span>
                      )}
                    </Button>
                  ))}
                </div>
              )
            );
          })
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t(slash ? "tasks.noBlocks" : "tasks.noAgents")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
