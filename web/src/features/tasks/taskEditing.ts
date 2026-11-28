import {
  Extension,
  InputRule,
  type CommandProps,
  type Range,
} from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type {
  Node as ProseMirrorNode,
  NodeType,
  ResolvedPos,
} from "@tiptap/pm/model";
import { wrapRangeInList } from "@tiptap/pm/schema-list";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { TableSize } from "./NoteTableSize";
import { stepBlock } from "./noteBlockMove";
import { isMac } from "@/features/settings/shortcuts";

export const noteHeadingLevels = [1, 2, 3, 4, 5, 6] as const;
export type NoteBlockType =
  | (typeof noteHeadingLevels)[number]
  | "paragraph"
  | "bulletList"
  | "orderedList"
  | "task"
  | "callout"
  | "table"
  | "noteWhiteboard"
  | "columns"
  | "blockquote"
  | "codeBlock"
  | "horizontalRule";

export const emptyTaskAttrs = {
  taskId: null,
  taskCheckbox: undefined,
  done: false,
  issue: null,
};

export function hasTaskCheckbox(node: ProseMirrorNode) {
  return !!node.attrs.taskId && node.attrs.taskCheckbox !== false;
}

export function noteBlockType($pos: ResolvedPos): NoteBlockType {
  const { parent } = $pos;
  if (parent.type.name === "heading") return parent.attrs.level;
  if (hasTaskCheckbox(parent)) return "task";
  for (let depth = $pos.depth; depth > 0; depth--) {
    const type = $pos.node(depth).type.name;
    if (
      type === "orderedList" ||
      type === "bulletList" ||
      type === "codeBlock" ||
      type === "blockquote" ||
      type === "callout"
    )
      return type;
  }
  return "paragraph";
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    taskNoteEditing: {
      setNoteBlock: (
        type: NoteBlockType,
        toggle?: boolean,
        trigger?: Range,
        tableSize?: TableSize,
      ) => ReturnType;
    };
  }
}

const noteEdit = new PluginKey<number | null>("note-edit");
const imageDrop = "note-image-drop";

export function isolateNoteEdit(tr: Transaction) {
  closeHistory(tr).setMeta(noteEdit, true);
}

export function showTaskImageDrop(view: EditorView, pos: number | null) {
  if (noteEdit.getState(view.state) !== pos)
    view.dispatch(view.state.tr.setMeta(imageDrop, pos));
}

export function noteTableDepth($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "table") return depth;
  }
}

function textAfterBlock(tr: Transaction, end: number) {
  const $end = tr.doc.resolve(end);
  if (!$end.nodeAfter?.isTextblock) {
    const { paragraph } = tr.doc.type.schema.nodes;
    if (!$end.parent.canReplaceWith($end.index(), $end.index(), paragraph))
      return;
    tr.insert(end, paragraph.create());
  }
  return end + 1;
}

function moveAfterBlock(view: EditorView, end: number) {
  const tr = view.state.tr;
  const pos = textAfterBlock(tr, end);
  if (pos === undefined) return false;
  if (tr.docChanged) isolateNoteEdit(tr);
  view.dispatch(
    tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView(),
  );
  return true;
}

function blockEndBelow(view: EditorView, $head: ResolvedPos) {
  const table = noteTableDepth($head);
  const depth = table ?? 1;
  if (
    $head.depth < depth ||
    $head.node(depth).type.name === "paragraph" ||
    $head.indexAfter(depth - 1) !== $head.node(depth - 1).childCount
  )
    return;

  const cellDepth = table === undefined ? undefined : table + 2;
  if (cellDepth !== undefined && $head.depth <= cellDepth) return;
  // Leave existing siblings and rows to the browser and table keymaps.
  for (let d = cellDepth ?? depth; d < $head.depth; d++) {
    if ($head.indexAfter(d) === $head.node(d).childCount) continue;
    if ($head.node(d).type.name !== "columns") return;
    // A side-by-side column is not below the caret. A stacked column is.
    const column = view.nodeDOM($head.before(d + 1));
    const next = view.nodeDOM($head.after(d + 1));
    if (
      !(column instanceof HTMLElement) ||
      !(next instanceof HTMLElement) ||
      next.getBoundingClientRect().top > column.getBoundingClientRect().top
    )
      return;
  }
  if (cellDepth !== undefined) {
    const map = TableMap.get($head.node(depth));
    const cell = $head.before(cellDepth) - $head.start(depth);
    if (map.findCell(cell).bottom !== map.height) return;
  }
  return $head.after(depth);
}

function selectNoteScope(view: EditorView) {
  const { doc, selection } = view.state;
  const { $from, $to } = selection;
  let next: Selection = new AllSelection(doc);
  if (
    selection instanceof TextSelection &&
    $from.parent.isTextblock &&
    $from.sameParent($to)
  ) {
    const start = $from.start();
    const end = $from.end();
    if (start === end) next = NodeSelection.create(doc, $from.before());
    else if ($from.pos !== start || $to.pos !== end)
      next = TextSelection.create(doc, start, end);
  } else if (selection.empty) {
    const after = $from.nodeAfter;
    const adjacent = after?.isBlock ? after : $from.nodeBefore;
    if (adjacent?.isBlock && NodeSelection.isSelectable(adjacent))
      next = NodeSelection.create(
        doc,
        adjacent === after ? $from.pos : $from.pos - adjacent.nodeSize,
      );
  }
  if (!next.eq(selection)) view.dispatch(view.state.tr.setSelection(next));
}

function canChangeTextblock(node: ProseMirrorNode, type: string) {
  if (type === "paragraph") return true;
  if (node.attrs.taskId) return false;
  if (type === "codeBlock") {
    // Code blocks can represent text and line breaks, but not Agent references.
    return !node.content.content.some(
      (child) =>
        child.isInline && !child.isText && child.type.name !== "hardBreak",
    );
  }
  return true;
}

// Keep StarterKit's input rules, including their undo behavior, on ordinary text.
export const protectBlockInput = {
  addInputRules(this: { name: string; parent?: () => InputRule[] }) {
    return (this.parent?.() ?? []).map(
      (rule) =>
        new InputRule({
          find: rule.find,
          undoable: rule.undoable,
          handler: (props) => {
            const node = props.state.doc.resolve(props.range.from).parent;
            if (!canChangeTextblock(node, this.name)) return null;
            return rule.handler(props);
          },
        }),
    );
  },
};

function setNoteBlock(
  kind: NoteBlockType,
  toggle: boolean,
  { tr, commands, dispatch }: CommandProps,
  tableSize: TableSize = { rows: 3, cols: 3 },
) {
  const { doc, selection } = tr;
  const { from, to, $from, $to } = selection;
  const { paragraph, listItem } = doc.type.schema.nodes;
  const type =
    doc.type.schema.nodes[typeof kind === "number" ? "heading" : kind];
  const blocks: { node: ProseMirrorNode; pos: number; fits: boolean }[] = [];
  const attrs = typeof kind === "number" ? { level: kind } : undefined;

  doc.nodesBetween(from, to, (node, pos, parent, index) => {
    if (!node.isTextblock) return;
    if (from !== to && to === pos + 1) return false;
    blocks.push({
      node,
      pos,
      fits:
        !type?.isTextblock || !!parent?.canReplaceWith(index, index + 1, type),
    });
    return false;
  });

  if (!blocks.length) return false;
  const range = $from.blockRange(
    $to,
    (node) => node.firstChild?.type === listItem,
  );
  const inList = range?.parent.type.name;
  const liftList =
    kind === "paragraph" &&
    range &&
    blocks.every(({ node, pos }) => {
      const $pos = doc.resolve(pos);
      return (
        node.type === paragraph &&
        $pos.parent.type === listItem &&
        $pos.index() === 0
      );
    });

  if (kind === "task") {
    if (blocks.some(({ node }) => node.type !== paragraph)) return false;
    if (dispatch) {
      for (const { node, pos } of blocks) {
        if (!hasTaskCheckbox(node))
          tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            taskId: node.attrs.taskId ?? crypto.randomUUID(),
            taskCheckbox: undefined,
          });
      }
    }
  } else if (kind === "bulletList" || kind === "orderedList") {
    if (inList === kind && !toggle) return true;
    if (inList) {
      if (!commands.toggleList(kind, listItem, true)) return false;
    } else {
      // List items start with a paragraph. Convert only the selected text
      // blocks before wrapping, keeping existing paragraph attributes.
      if (blocks.some(({ node }) => node.type !== paragraph)) {
        // Test the complete conversion before adding steps to the shared
        // transaction, which Tiptap may dispatch even on a false result.
        const trial = EditorState.create({ doc, selection }).tr;
        setTextblocks(trial, blocks, paragraph);
        const range = trial.selection.$from.blockRange(trial.selection.$to);
        if (!range || !wrapRangeInList(trial, range, type)) return false;
        if (dispatch) trial.steps.forEach((step) => tr.step(step));
      } else if (!commands.wrapInList(type)) return false;
    }
  } else if (kind === "callout") {
    if (!commands.toggleWrap("callout")) return false;
  } else if (kind === "noteWhiteboard") {
    if (
      !$from.sameParent($to) ||
      $from.parent.type !== paragraph ||
      $from.parent.attrs.taskId
    )
      return false;
    if (dispatch) {
      const empty =
        !$from.parent.content.size &&
        $from
          .node(-1)
          .canReplaceWith($from.index(-1), $from.index(-1) + 1, type);
      const at = empty ? $from.before() : $from.after();
      tr.replaceWith(at, empty ? $from.after() : at, type.create());
      tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView();
    }
  } else if (kind === "columns") {
    if (
      !$from.sameParent($to) ||
      $from.parent.type !== paragraph ||
      $from.parent.attrs.taskId ||
      $from.parent.content.size ||
      $from.depth !== 1
    )
      return false;
    if (dispatch) {
      const column = doc.type.schema.nodes.noteColumn;
      const at = $from.before();
      tr.replaceWith(
        at,
        $from.after(),
        type.create(null, [column.createAndFill()!, column.createAndFill()!]),
      );
      tr.setSelection(
        TextSelection.near(tr.doc.resolve(at + 2)),
      ).scrollIntoView();
    }
  } else if (kind === "table") {
    if (
      !$from.sameParent($to) ||
      $from.parent.type !== paragraph ||
      $from.parent.attrs.taskId ||
      $from.parent.content.size ||
      noteTableDepth($from) !== undefined
    )
      return false;
    if (!commands.insertTable({ ...tableSize, withHeaderRow: true }))
      return false;
    if (dispatch) {
      const { $from: firstCell } = tr.selection;
      const depth = noteTableDepth(firstCell);
      if (depth !== undefined) textAfterBlock(tr, firstCell.after(depth));
    }
  } else if (kind === "blockquote") {
    if (!commands.toggleBlockquote()) return false;
  } else if (kind === "horizontalRule") {
    if (
      !$from.sameParent($to) ||
      $from.parent.type !== paragraph ||
      $from.parent.attrs.taskId
    )
      return false;
    if (!commands.setHorizontalRule()) return false;
  } else {
    const target =
      toggle &&
      blocks.every(
        ({ node }) =>
          node.type === type && (!attrs || node.attrs.level === attrs.level),
      )
        ? paragraph
        : type;
    if (
      target !== paragraph &&
      blocks.some(
        ({ node, fits }) => !fits || !canChangeTextblock(node, target.name),
      )
    )
      return false;
    if (dispatch)
      setTextblocks(
        tr,
        blocks,
        target,
        target === paragraph ? undefined : attrs,
      );
    if (liftList && !commands.liftListItem(listItem)) return false;
  }
  if (dispatch && tr.docChanged) isolateNoteEdit(tr);
  return true;
}

function setTextblocks(
  tr: Transaction,
  blocks: { node: ProseMirrorNode; pos: number }[],
  type: NodeType,
  attrs?: { level: number },
) {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const { node, pos } = blocks[index];
    if (node.type === type && (!attrs || node.attrs.level === attrs.level))
      continue;
    tr.setBlockType(pos + 1, pos + 1, type, {
      ...attrs,
      textAlign: node.attrs.textAlign,
    });
  }
}

function enterTask({ tr, commands }: CommandProps) {
  const { selection } = tr;
  const { $from, $to } = selection;
  const task = $from.parent;
  if (
    !(selection instanceof TextSelection) ||
    !$from.sameParent($to) ||
    !hasTaskCheckbox(task)
  )
    return false;

  const parent = $from.node(-1);
  const item =
    parent.type.name === "listItem" && $from.index(-1) === 0
      ? parent
      : undefined;
  const empty =
    $from.parentOffset === 0 && $to.parentOffset === task.content.size;
  if (empty && !task.attrs.issue && (!item || item.childCount === 1)) {
    if (item && !commands.liftListItem(item.type)) return false;
    tr.deleteSelection();
    const { $from: cursor } = tr.selection;
    if (!item || cursor.node(-1).type !== item.type)
      tr.setNodeMarkup(cursor.before(), undefined, {
        ...cursor.parent.attrs,
        ...emptyTaskAttrs,
      });
    return true;
  }

  // At the start, insert above and keep the caret with the original title.
  const atStart = !empty && $from.parentOffset === 0;
  const depth = item ? $from.depth - 1 : $from.depth;
  const boundary = atStart ? $from.before(depth) : $from.after(depth);
  const next = task.type.create(
    { ...task.attrs, ...emptyTaskAttrs, taskId: crypto.randomUUID() },
    atStart ? undefined : task.content.cut($to.parentOffset),
  );
  // Move only the inline text so the body stays with the original task.
  tr.delete($from.pos, atStart ? $to.pos : $from.end());
  const pos = tr.mapping.map(boundary);
  tr.insert(pos, item ? item.type.create(null, next) : next);
  if (!atStart)
    tr.setSelection(TextSelection.create(tr.doc, pos + (item ? 2 : 1)));
  tr.scrollIntoView();
  return true;
}

export const TaskNoteEditing = Extension.create({
  name: "taskNoteEditing",
  // Override the stock Paragraph keymap, which has priority 1000.
  priority: 1001,
  addCommands() {
    return {
      setNoteBlock:
        (kind, toggle = false, trigger, tableSize) =>
        (props) => {
          if (!trigger) return setNoteBlock(kind, toggle, props, tableSize);
          const { tr, can, chain, dispatch } = props;
          const { $from } = tr.selection;
          const empty = $from.parent.content.size === trigger.to - trigger.from;
          const inTable = noteTableDepth($from) !== undefined;
          if (inTable && (kind === "table" || kind === "columns")) return false;
          if (empty) {
            if (kind === "table" && $from.parent.attrs.taskId) return false;
            if (
              kind === "columns" &&
              ($from.parent.attrs.taskId || $from.depth !== 1)
            )
              return false;
            if (
              kind !== "table" &&
              kind !== "columns" &&
              !can().setNoteBlock(kind, toggle)
            )
              return false;
          }
          if (!dispatch) return true;
          tr.delete(trigger.from, trigger.to);
          if (!empty) {
            const pos = tr.selection.$from.after(inTable ? $from.depth : 1);
            tr.insert(pos, tr.doc.type.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, pos + 1));
          }
          return chain().setNoteBlock(kind, toggle, undefined, tableSize).run();
        },
    };
  },
  addKeyboardShortcuts() {
    const { editor } = this;
    const convert =
      (type: NoteBlockType, toggle = false) =>
      () => {
        if (editor.view.composing) return false;
        editor.commands.setNoteBlock(type, toggle);
        return true;
      };
    return {
      "Ctrl-Shift-ArrowUp": () =>
        stepBlock(editor.view, editor.state.selection.from, -1),
      "Ctrl-Shift-ArrowDown": () =>
        stepBlock(editor.view, editor.state.selection.from, 1),
      "Mod-Alt-0": convert("paragraph"),
      ...Object.fromEntries(
        noteHeadingLevels.map((level) => [
          `Mod-Alt-${level}`,
          convert(level, true),
        ]),
      ),
      "Mod-Alt-c": convert("codeBlock", true),
      "Mod-Shift-7": convert("orderedList", true),
      "Mod-Shift-8": convert("bulletList", true),
      "Mod-Alt-t": convert("task"),
      ArrowDown: () => {
        const {
          view,
          state: { selection },
        } = editor;
        if (view.composing) return false;
        if (
          selection instanceof NodeSelection &&
          selection.node.isBlock &&
          selection.node.type.name !== "paragraph" &&
          (selection.node.type.name === "table" || !selection.$to.nodeAfter)
        )
          return moveAfterBlock(view, selection.to);
        if (!(selection instanceof TextSelection) || !selection.empty)
          return false;
        const end = blockEndBelow(view, selection.$head);
        return (
          end !== undefined &&
          view.endOfTextblock("down") &&
          moveAfterBlock(view, end)
        );
      },
      Backspace: () => {
        const { empty, $from } = editor.state.selection;
        return (
          empty &&
          $from.parentOffset === 0 &&
          $from.parent.type.name === "heading" &&
          editor.commands.setNoteBlock("paragraph")
        );
      },
      Enter: () => !editor.view.composing && editor.commands.command(enterTask),
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: noteEdit,
        state: {
          init: () => null,
          apply(tr, pos) {
            const target = tr.getMeta(imageDrop);
            if (target !== undefined) return target as number | null;
            return tr.docChanged ? null : pos;
          },
        },
        props: {
          decorations(state) {
            const pos = noteEdit.getState(state);
            const title = pos == null ? null : state.doc.nodeAt(pos);
            return pos != null && title
              ? DecorationSet.create(state.doc, [
                  Decoration.node(pos, pos + title.nodeSize, {
                    class: "task-image-drop-target",
                  }),
                ])
              : null;
          },
          handleKeyDown(view, event) {
            if (
              event.key.toLowerCase() !== "a" ||
              !(isMac
                ? event.metaKey && !event.ctrlKey
                : event.ctrlKey && !event.metaKey) ||
              event.altKey ||
              event.shiftKey ||
              event.isComposing ||
              view.composing
            )
              return false;
            if (!event.repeat) selectNoteScope(view);
            return true;
          },
          handleDOMEvents: {
            mousedown(view, event) {
              const { doc } = view.state;
              if (
                event.button === 0 &&
                !event.shiftKey &&
                event.target === view.dom &&
                view.editable &&
                !view.composing
              ) {
                let previous: HTMLElement | undefined;
                for (const child of view.dom.children) {
                  if (
                    !(child instanceof HTMLElement) ||
                    !child.getClientRects().length
                  )
                    continue;
                  if (
                    previous &&
                    event.clientY < child.getBoundingClientRect().top &&
                    event.clientY > previous.getBoundingClientRect().bottom
                  ) {
                    const pos = view.posAtDOM(
                      view.dom,
                      Array.prototype.indexOf.call(view.dom.childNodes, child),
                    );
                    const $pos = doc.resolve(pos);
                    if (
                      $pos.nodeBefore &&
                      $pos.nodeAfter &&
                      (!$pos.nodeBefore.isTextblock ||
                        $pos.nodeBefore.type.name === "codeBlock") &&
                      (!$pos.nodeAfter.isTextblock ||
                        $pos.nodeAfter.type.name === "codeBlock")
                    ) {
                      event.preventDefault();
                      moveAfterBlock(view, pos);
                      view.focus();
                      return true;
                    }
                  }
                  previous = child;
                }
              }
              const last = doc.lastChild;
              if (
                event.button !== 0 ||
                event.shiftKey ||
                event.target !== view.dom ||
                view.composing ||
                !view.editable ||
                !last ||
                last.type.name === "paragraph"
              )
                return false;
              const end = doc.content.size;
              const element = view.nodeDOM(end - last.nodeSize);
              if (
                !(element instanceof HTMLElement) ||
                event.clientY < element.getBoundingClientRect().bottom ||
                !moveAfterBlock(view, end)
              )
                return false;
              event.preventDefault();
              view.focus();
              return true;
            },
          },
        },
        appendTransaction: (transactions, _, state) =>
          transactions.some((tr) => tr.docChanged && tr.getMeta(noteEdit))
            ? closeHistory(state.tr)
            : null,
      }),
    ];
  },
});
