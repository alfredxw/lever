import { useEffect, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type Selection } from "@tiptap/pm/state";
import {
  Braces,
  ChevronDown,
  Columns2,
  GripVertical,
  Presentation,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Info,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Table2,
  Type,
} from "lucide-react";
import { toast } from "sonner";
import { movableBlock, moveBlock, copyBlock } from "./noteBlockMove";
import { noteTones } from "./noteFormatting";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ariaShortcut,
  formatShortcut,
  isMac,
} from "@/features/settings/shortcuts";
import {
  isolateNoteEdit,
  noteBlockType,
  noteHeadingLevels,
  type NoteBlockType,
} from "./taskEditing";

const headingIcons = [
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
];

export const noteBlockItems = [
  {
    type: "paragraph",
    label: "tasks.block.paragraph",
    icon: Type,
    key: "alt+0",
  },
  ...noteHeadingLevels.map((level) => ({
    type: level,
    label: "tasks.block.heading" as const,
    icon: headingIcons[level - 1],
    key: `alt+${level}`,
  })),
  {
    type: "bulletList",
    label: "tasks.block.bulletList",
    icon: List,
    key: "shift+8",
  },
  {
    type: "orderedList",
    label: "tasks.block.orderedList",
    icon: ListOrdered,
    key: "shift+7",
  },
  { type: "task", label: "tasks.block.task", icon: ListTodo, key: "alt+t" },
  { type: "blockquote", label: "tasks.block.blockquote", icon: Quote },
  {
    type: "codeBlock",
    label: "tasks.block.codeBlock",
    icon: Braces,
    key: "alt+c",
  },
  { type: "columns", label: "tasks.block.columns", icon: Columns2 },
  {
    type: "noteWhiteboard",
    label: "tasks.block.whiteboard",
    icon: Presentation,
  },
  { type: "table", label: "tasks.block.table", icon: Table2 },
  { type: "callout", label: "tasks.block.callout", icon: Info },
  { type: "horizontalRule", label: "tasks.block.horizontalRule", icon: Minus },
] as const;

const blockItemsByType = new Map(
  noteBlockItems.map((item) => [item.type, item]),
);
const gridColumns = 6;
const quickTypes: NoteBlockType[] = [
  "paragraph",
  1,
  2,
  3,
  "orderedList",
  "bulletList",
  "task",
  "codeBlock",
  "blockquote",
  "callout",
  "horizontalRule",
];
const moreHeadings = noteHeadingLevels.slice(3);

export type NoteBlockTarget = {
  doc: ProseMirrorNode;
  position: number;
  lineCenter: number;
  type: NoteBlockType;
  empty: boolean;
};

export function noteBlockTarget(
  editor: Editor,
  pos: number,
  root: HTMLElement,
): NoteBlockTarget | undefined {
  const { doc } = editor.state;
  const { view } = editor;
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return;
  const position = $pos.start();
  const element = view.nodeDOM(position - 1);
  if (!(element instanceof HTMLElement)) return;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  return {
    doc,
    position,
    lineCenter:
      rect.top -
      root.getBoundingClientRect().top +
      (Number.isFinite(lineHeight)
        ? Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.paddingTop) +
          lineHeight / 2
        : rect.height / 2),
    type: noteBlockType($pos),
    empty:
      $pos.parent.type.name === "paragraph" &&
      !$pos.parent.content.size &&
      !$pos.parent.attrs.taskId,
  };
}

export function NoteBlockMenu({
  editor,
  target,
  open,
  onOpenChange,
}: {
  editor: Editor;
  target: NoteBlockTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const original = useRef<{
    doc: typeof editor.state.doc;
    selection: Selection;
  }>(undefined);
  const preserveSelection = useRef(false);
  const moreTrigger = useRef<HTMLDivElement>(null);
  const { doc, selection } = editor.state;
  const { position, lineCenter, type: currentType } = target;
  const BlockIcon = blockItemsByType.get(currentType)!.icon;

  const drag = useRef<{
    startY: number;
    startX: number;
    doc: ProseMirrorNode;
    pos: number;
    el: HTMLElement;
    target?: number;
    marker?: HTMLElement;
    moved: boolean;
  }>(undefined);
  const suppressClick = useRef(false);
  function clearDrag() {
    const d = drag.current;
    if (!d) return;
    d.el.style.removeProperty("transform");
    d.el.classList.remove("note-moving-block");
    d.marker?.removeAttribute("data-note-drop");
    drag.current = undefined;
  }
  useEffect(() => clearDrag, []);
  function action(name: string) {
    const block = movableBlock(editor.state.doc, position);
    if (!block || editor.view.composing) return;
    preserveSelection.current = true;
    original.current = undefined;
    if (name === "copy" || name === "cut") {
      void copyBlock(editor.view, position, name === "cut").catch((e) =>
        toast.error(String(e)),
      );
      return;
    }
    if (name === "indent" || name === "outdent") {
      editor
        .chain()
        .focus()
        [name === "indent" ? "sinkListItem" : "liftListItem"]("listItem")
        .run();
      return;
    }
    const tr = editor.state.tr;
    if (name === "delete")
      tr.deleteRange(block.pos, block.pos + block.node.nodeSize);
    else {
      const $pos = tr.doc.resolve(position),
        at = $pos.after();
      tr.insert(at, tr.doc.type.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
    }
    isolateNoteEdit(tr);
    editor.view.dispatch(tr);
    editor.commands.focus();
  }

  function changeOpen(next: boolean) {
    if (next) {
      const target = doc.resolve(position);
      const useSelection =
        !selection.empty &&
        selection.from < target.end() &&
        selection.to > target.start();
      original.current = { doc, selection };
      if (
        !useSelection &&
        !(selection.empty && selection.$from.sameParent(target))
      )
        editor.commands.setTextSelection(position);
    }
    onOpenChange(next);
  }

  function choose(type: NoteBlockType) {
    original.current = undefined;
    preserveSelection.current = true;
    editor.chain().focus().setNoteBlock(type).run();
  }

  function restoreOnClose() {
    preserveSelection.current = true;
  }

  function moveGridFocus(event: KeyboardEvent<HTMLDivElement>) {
    const { key, currentTarget } = event;
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)
    )
      return;
    const items = Array.from(
      currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    const index = items.findIndex((item) => item === event.target);
    if (index === -1) return;
    const row = Math.floor(index / gridColumns);
    const column = index % gridColumns;
    const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
    const horizontal = key === "ArrowLeft" || key === "ArrowRight";
    const nextRow = row + direction;
    event.preventDefault();
    if (horizontal) {
      for (
        let next = index + direction;
        next >= row * gridColumns && next < (row + 1) * gridColumns;
        next += direction
      ) {
        if (items[next] && !items[next].hasAttribute("data-disabled")) {
          items[next].focus();
          return;
        }
      }
    } else if (nextRow * gridColumns >= items.length) {
      moreTrigger.current?.focus();
    } else if (nextRow >= 0) {
      const rowStart = nextRow * gridColumns;
      items
        .slice(rowStart, rowStart + gridColumns)
        .map((item, index) => ({ item, distance: Math.abs(index - column) }))
        .sort((a, b) => a.distance - b.distance)
        .find(({ item }) => !item.hasAttribute("data-disabled"))
        ?.item.focus();
    }
  }

  function blockChoice(type: NoteBlockType, iconOnly = false) {
    const item = blockItemsByType.get(type)!;
    const label = t(item.label, { level: type });
    const shortcut =
      "key" in item ? `${isMac ? "meta" : "ctrl"}+${item.key}` : undefined;
    return (
      <DropdownMenuItem
        key={type}
        aria-current={type === currentType || undefined}
        aria-label={iconOnly ? label : undefined}
        aria-keyshortcuts={shortcut && ariaShortcut(shortcut)}
        textValue={label}
        title={
          iconOnly
            ? shortcut
              ? `${label} (${formatShortcut(shortcut)})`
              : label
            : undefined
        }
        disabled={!editor.can().setNoteBlock(type)}
        onSelect={() => choose(type)}
      >
        <item.icon aria-hidden="true" />
        {!iconOnly && label}
        {!iconOnly && shortcut && (
          <DropdownMenuShortcut aria-hidden="true">
            {formatShortcut(shortcut)}
          </DropdownMenuShortcut>
        )}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="task-note-block-trigger"
          aria-label={t("tasks.changeBlock")}
          style={{ top: lineCenter }}
          onPointerDown={(event) => {
            if (event.button !== 0 || editor.view.composing) return;
            event.preventDefault();
            const block = movableBlock(editor.state.doc, position);
            const el = block && editor.view.nodeDOM(block.pos);
            if (!block || !(el instanceof HTMLElement)) return;
            drag.current = {
              startY: event.clientY,
              startX: event.clientX,
              doc: editor.state.doc,
              pos: block.pos,
              el,
              moved: false,
            };
            suppressClick.current = false;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d || d.doc !== editor.state.doc) return;
            const dy = event.clientY - d.startY;
            if (!d.moved && Math.hypot(event.clientX - d.startX, dy) < 5)
              return;
            d.moved = true;
            d.el.classList.add("note-moving-block");
            d.el.style.transform = "translateY(" + dy + "px)";
            const scroll = editor.view.dom.closest(".task-note-scroll");
            if (scroll) {
              const r = scroll.getBoundingClientRect();
              if (event.clientY < r.top + 32) scroll.scrollTop -= 16;
              else if (event.clientY > r.bottom - 32) scroll.scrollTop += 16;
            }
            d.marker?.removeAttribute("data-note-drop");
            d.target = undefined;
            const hit = editor.view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            if (!hit) return;
            const block = movableBlock(d.doc, hit.pos);
            if (!block || block.pos === d.pos) return;
            const el = editor.view.nodeDOM(block.pos);
            if (!(el instanceof HTMLElement)) return;
            const r = el.getBoundingClientRect(),
              after = event.clientY > r.top + r.height / 2;
            d.marker = el;
            d.target = block.pos + (after ? block.node.nodeSize : 0);
            el.dataset.noteDrop = after ? "after" : "before";
          }}
          onPointerUp={(event) => {
            const d = drag.current;
            if (!d) return;
            if (d.moved) {
              suppressClick.current = true;
              if (d.target !== undefined && d.doc === editor.state.doc)
                moveBlock(editor.view, d.pos, d.target);
            }
            clearDrag();
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            suppressClick.current = true;
            clearDrag();
          }}
          onLostPointerCapture={clearDrag}
          onClick={() => {
            if (!suppressClick.current) changeOpen(true);
          }}
          tabIndex={-1}
        >
          <BlockIcon className="size-3.5" aria-hidden="true" />
          <GripVertical className="size-3" aria-hidden="true" />
          <ChevronDown className="size-2.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="task-note-block-menu"
        collisionPadding={8}
        hideWhenDetached
        onEscapeKeyDown={restoreOnClose}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (preserveSelection.current) {
            const previous = original.current;
            if (previous?.doc === editor.state.doc)
              editor.view.dispatch(
                editor.state.tr.setSelection(previous.selection),
              );
            editor.commands.focus(null, { scrollIntoView: false });
          }
          original.current = undefined;
          preserveSelection.current = false;
        }}
      >
        <DropdownMenuGroup
          className="task-note-block-grid"
          style={{
            gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
          }}
          onKeyDownCapture={moveGridFocus}
        >
          {quickTypes.map((type) => blockChoice(type, true))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger ref={moreTrigger}>
            <Heading4 aria-hidden="true" />
            {t("tasks.block.moreHeadings")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="task-note-block-submenu"
            onEscapeKeyDown={restoreOnClose}
          >
            {moreHeadings.map((type) => blockChoice(type))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {["addBelow", "copy", "cut", "indent", "outdent", "delete"].map(
          (key) => (
            <DropdownMenuItem
              key={key}
              disabled={
                key === "indent"
                  ? !editor.can().sinkListItem("listItem")
                  : key === "outdent"
                    ? !editor.can().liftListItem("listItem")
                    : false
              }
              onSelect={() => action(key)}
            >
              {t("tasks.blockAction." + key)}
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("tasks.format.alignment")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {(["left", "center", "right"] as const).map((align) => (
              <DropdownMenuItem
                key={align}
                onSelect={() =>
                  editor.chain().focus().setNoteAlignment(align).run()
                }
              >
                {t("tasks.format.align." + align)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("tasks.block.fill")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {["none", ...noteTones].map((tone) => (
              <DropdownMenuItem
                key={tone}
                onSelect={() => {
                  const $at = editor.state.doc.resolve(position);
                  editor.view.dispatch(
                    editor.state.tr.setNodeAttribute(
                      $at.before(),
                      "tone",
                      tone === "none" ? undefined : tone,
                    ),
                  );
                }}
              >
                {t("tasks.tone." + tone)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}