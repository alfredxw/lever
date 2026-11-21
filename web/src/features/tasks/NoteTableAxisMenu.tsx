import type { CSSProperties } from "react";
import type { ChainedCommands, Editor } from "@tiptap/core";
import type { CellSelection } from "@tiptap/pm/tables";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  PaintBucket,
  Plus,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { formatNoteSelection, noteAlignments } from "./noteFormatting";
import { NoteCellFillChoices } from "./NoteTableMenu";

export type NoteTableAxis = "row" | "column";
export type NoteTableBand = {
  axis: NoteTableAxis;
  index: number;
  selection: CellSelection;
};

const alignmentIcons = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
};

export function NoteTableAxisMenu({
  editor,
  band,
  anchor,
  boundary,
  canDelete,
  onStructure,
  onClose,
}: {
  editor: Editor;
  band: NoteTableBand;
  anchor: CSSProperties;
  boundary?: Element | null;
  canDelete: boolean;
  onStructure: (action: "before" | "after" | "delete") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { axis, index, selection } = band;
  const split = editor.can().splitCell();
  const mergeLabel = t(split ? "tasks.table.split" : "tasks.table.merge");
  const insertLabel = t(`tasks.table.insert.${axis}`);
  const deleteLabel = t(
    axis === "row" ? "tasks.table.deleteRow" : "tasks.table.deleteColumn",
  );
  const keepFocus = (event: Event) => event.preventDefault();

  function apply(change: (chain: ChainedCommands) => ChainedCommands) {
    if (
      editor.isDestroyed ||
      editor.state.doc !== selection.$anchorCell.doc ||
      !selection.eq(editor.state.selection)
    )
      return;
    if (formatNoteSelection(editor, change)) onClose();
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <span
          className="note-table-axis-anchor"
          aria-hidden="true"
          style={anchor}
        />
      </PopoverAnchor>
      <PopoverContent
        className="note-table-axis-toolbar"
        aria-label={t(`tasks.table.axisActions.${axis}`, { index: index + 1 })}
        side="top"
        sideOffset={7}
        collisionBoundary={boundary}
        hideWhenDetached
        onCloseAutoFocus={keepFocus}
        onEscapeKeyDown={() =>
          editor.commands.focus(null, { scrollIntoView: false })
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={mergeLabel}
          title={mergeLabel}
          disabled={!split && !editor.can().mergeCells()}
          onClick={() =>
            apply((chain) => (split ? chain.splitCell() : chain.mergeCells()))
          }
        >
          {split ? (
            <TableCellsSplit aria-hidden="true" />
          ) : (
            <TableCellsMerge aria-hidden="true" />
          )}
        </Button>
        <span className="note-format-separator" aria-hidden="true" />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("tasks.table.fill")}
              title={t("tasks.table.fill")}
            >
              <PaintBucket aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="note-format-menu w-36">
            <NoteCellFillChoices
              onFill={(fill) =>
                apply((chain) => chain.setCellAttribute("fill", fill))
              }
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="note-format-trigger"
              aria-label={t("tasks.format.alignment")}
              title={t("tasks.format.alignment")}
              disabled={!editor.can().setNoteAlignment("left")}
            >
              <AlignLeft aria-hidden="true" />
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="note-format-menu w-40">
            {noteAlignments.map((alignment) => {
              const Icon = alignmentIcons[alignment];
              return (
                <DropdownMenuItem
                  key={alignment}
                  onSelect={() =>
                    apply((chain) => chain.setNoteAlignment(alignment))
                  }
                >
                  <Icon aria-hidden="true" />
                  {t(`tasks.format.align.${alignment}`)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="note-format-separator" aria-hidden="true" />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="note-format-trigger"
              aria-label={insertLabel}
              title={insertLabel}
            >
              <Plus aria-hidden="true" />
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="note-format-menu w-52">
            {(["before", "after"] as const).map((action) => (
              <DropdownMenuItem
                key={action}
                onSelect={() => onStructure(action)}
              >
                {t(`tasks.table.${action}.${axis}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="note-table-axis-delete"
          aria-label={deleteLabel}
          title={deleteLabel}
          disabled={!canDelete}
          onClick={() => onStructure("delete")}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </PopoverContent>
    </Popover>
  );
}
