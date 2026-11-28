import { useRef } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection, type Selection } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  columnIsHeader,
  rowIsHeader,
  toggleHeader,
} from "@tiptap/pm/tables";
import {
  Columns2,
  Copy,
  GripVertical,
  PaintBucket,
  PlusSquare,
  Rows2,
  Ruler,
  Scissors,
  Table2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { noteCellFills } from "./taskDocument";
import { noteTableDepth } from "./taskEditing";

export type NoteTableTarget = { element: HTMLTableElement; pos: number };

export function NoteCellFillChoices({
  onFill,
}: {
  onFill: (fill: string | null) => void;
}) {
  const { t } = useTranslation();
  return ["none", ...noteCellFills].map((fill) => (
    <DropdownMenuItem
      key={fill}
      onSelect={() => onFill(fill === "none" ? null : fill)}
    >
      <span
        className="note-table-swatch"
        data-note-cell-fill={fill}
        aria-hidden="true"
      />
      {t("tasks.table.fill." + fill)}
    </DropdownMenuItem>
  ));
}

export function NoteTableMenu({
  editor,
  target,
  open,
  onOpenChange,
}: {
  editor: Editor;
  target: NoteTableTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const cellSelection = useRef<Selection | null>(null);
  const returnToEditor = useRef(false);

  const node = editor.state.doc.nodeAt(target.pos);
  if (node?.type.name !== "table") return null;
  const end = target.pos + node.nodeSize;
  const firstText = target.pos + 4;
  const map = open ? TableMap.get(node) : undefined;
  const headerRow = !!map && rowIsHeader(map, node, 0);
  const headerColumn = !!map && columnIsHeader(map, node, 0);

  function changeOpen(next: boolean) {
    if (next) {
      if (editor.view.composing) return;
      const selection = editor.state.selection;
      cellSelection.current =
        tableAtSelection(editor, selection) === target.pos ? selection : null;
    }
    onOpenChange(next);
  }

  function run(action: (chain: ReturnType<Editor["chain"]>) => boolean) {
    if (editor.view.composing) return;
    const chain = editor.chain().setTextSelection(firstText).focus();
    returnToEditor.current = action(chain);
  }

  const originalSelection =
    cellSelection.current ??
    (tableAtSelection(editor) === target.pos &&
    !(editor.state.selection instanceof NodeSelection)
      ? editor.state.selection
      : null);

  function cellAction(action: (chain: ReturnType<Editor["chain"]>) => boolean) {
    const selection = originalSelection;
    if (!selection || editor.view.composing) return;
    const current = selection.getBookmark().resolve(editor.state.doc);
    if (tableAtSelection(editor, current) !== target.pos) return;
    const chain = editor
      .chain()
      .command(({ tr }) => {
        tr.setSelection(current);
        return true;
      })
      .focus();
    returnToEditor.current = action(chain);
  }

  function copy(cut: boolean) {
    const selection = NodeSelection.create(editor.state.doc, target.pos);
    const data = editor.view.serializeForClipboard(selection.content());
    returnToEditor.current = true;
    void (async () => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([data.dom.innerHTML], { type: "text/html" }),
            "text/plain": new Blob([data.text], { type: "text/plain" }),
          }),
        ]);
        if (
          cut &&
          !editor.isDestroyed &&
          editor.state.doc.nodeAt(target.pos) === node
        )
          editor.commands.deleteRange({
            from: target.pos,
            to: end,
          });
      } catch (error) {
        toast.error(String(error));
      }
    })();
  }

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={changeOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="note-table-block-trigger"
          aria-label={t("tasks.table.actions")}
        >
          <Table2 />
          <GripVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="note-table-menu"
        onCloseAutoFocus={(event) => {
          if (editor.isDestroyed || open) return;
          if (returnToEditor.current) {
            event.preventDefault();
            editor.view.focus();
          }
          returnToEditor.current = false;
        }}
      >
        <DropdownMenuItem onSelect={() => copy(true)}>
          <Scissors />
          {t("tasks.table.cut")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copy(false)}>
          <Copy />
          {t("tasks.table.copy")}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => run((chain) => chain.deleteTable().run())}
        >
          <Trash2 />
          {t("tasks.table.delete")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {(
          [
            ["row", headerRow, Rows2, "headerRow"],
            ["column", headerColumn, Columns2, "headerColumn"],
          ] as const
        ).map(([axis, checked, Icon, label]) => (
          <DropdownMenuCheckboxItem
            key={axis}
            className="note-table-toggle"
            checked={checked}
            onSelect={(event) => {
              event.preventDefault();
              if (editor.view.composing) return;
              editor
                .chain()
                .setTextSelection(firstText)
                .command(({ state, dispatch }) =>
                  toggleHeader(axis)(state, dispatch),
                )
                .run();
            }}
          >
            <Icon />
            {t("tasks.table." + label)}
            <span className="note-table-switch" aria-hidden="true" />
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuItem
          onSelect={() =>
            run((chain) =>
              chain
                .command(({ tr }) => {
                  for (const offset of new Set(TableMap.get(node).map)) {
                    tr.setNodeAttribute(
                      target.pos + 1 + offset,
                      "colwidth",
                      null,
                    );
                  }
                  return true;
                })
                .run(),
            )
          }
        >
          <Ruler />
          {t("tasks.table.distribute")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {originalSelection && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Table2 />
              {t("tasks.table.cells")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(
                [
                  ["deleteRow", "deleteRow"],
                  ["deleteColumn", "deleteColumn"],
                  ["merge", "mergeCells"],
                  ["split", "splitCell"],
                ] as const
              ).map(([label, command]) => (
                <DropdownMenuItem
                  key={command}
                  onSelect={() => cellAction((chain) => chain[command]().run())}
                >
                  {t("tasks.table." + label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {originalSelection && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("tasks.table.verticalAlign")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {["top", "middle", "bottom"].map((align) => (
                <DropdownMenuItem
                  key={align}
                  onSelect={() =>
                    cellAction((chain) =>
                      chain
                        .setCellAttribute(
                          "verticalAlign",
                          align === "top" ? undefined : align,
                        )
                        .run(),
                    )
                  }
                >
                  {t("tasks.table." + align)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {originalSelection && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <PaintBucket />
              {t("tasks.table.fill")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <NoteCellFillChoices
                onFill={(fill) =>
                  cellAction((chain) =>
                    chain.setCellAttribute("fill", fill).run(),
                  )
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <PlusSquare />
            {t("tasks.table.addBelow")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() =>
                run((chain) =>
                  chain
                    .insertContentAt(end, {
                      type: "paragraph",
                    })
                    .setTextSelection(end + 1)
                    .run(),
                )
              }
            >
              {t("tasks.block.paragraph")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                run((chain) =>
                  chain
                    .insertContentAt(end, {
                      type: "paragraph",
                    })
                    .setTextSelection(end + 1)
                    .setNoteBlock("table")
                    .run(),
                )
              }
            >
              {t("tasks.block.table")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function tableAtSelection(
  editor: Editor,
  selection = editor.state.selection,
) {
  const $pos =
    selection instanceof CellSelection
      ? selection.$anchorCell
      : selection.$from;
  if (
    selection instanceof NodeSelection &&
    selection.node.type.name === "table"
  ) {
    return selection.from;
  }
  const depth = noteTableDepth($pos);
  if (depth !== undefined) return $pos.before(depth);
}
