import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import {
  addColumn,
  addRow,
  CellSelection,
  moveTableColumn,
  moveTableRow,
  removeColumn,
  removeRow,
  TableMap,
} from "@tiptap/pm/tables";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  NoteTableAxisMenu,
  type NoteTableAxis,
  type NoteTableBand,
} from "./NoteTableAxisMenu";
import { NoteTableMenu, type NoteTableTarget } from "./NoteTableMenu";
import { isolateNoteEdit } from "./taskEditing";

type Edge = { axis: NoteTableAxis; index: number };
type Geometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  rows: number[];
  columns: number[];
  scrolled: boolean;
};

function isVisibleBoundary(offset: number, length: number) {
  // The scroll limit can round to a CSS pixel before the table edge.
  return offset > -1 && offset < length + 1;
}

export function NoteTableControls({
  editor,
  target,
  root,
  open,
  onOpenChange,
}: {
  editor: Editor;
  target: NoteTableTarget;
  root: HTMLDivElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { element, pos } = target;
  const [geometry, setGeometry] = useState<Geometry>();
  const [edge, setEdge] = useState<Edge>();
  const [band, setBand] = useState<NoteTableBand>();

  const dragged = useRef<{
    axis: NoteTableAxis;
    from: number;
    doc: typeof editor.state.doc;
    start: number;
    to: number;
  }>(undefined);
  const skipClick = useRef(false);
  const node = editor.state.doc.nodeAt(pos);
  const selection = editor.state.selection;
  const cellSelection =
    selection instanceof CellSelection &&
    selection.$anchorCell.start(-1) === pos + 1
      ? selection
      : undefined;
  const map =
    cellSelection && node?.type.name === "table"
      ? TableMap.get(node)
      : undefined;
  const cells =
    cellSelection && map
      ? map.rectBetween(
          cellSelection.$anchorCell.pos - pos - 1,
          cellSelection.$headCell.pos - pos - 1,
        )
      : undefined;
  const actionBand =
    !open &&
    band?.selection.$anchorCell.doc === editor.state.doc &&
    cellSelection?.eq(band.selection)
      ? band
      : undefined;

  useEffect(() => {
    if (band && !actionBand) setBand(undefined);
  }, [band, actionBand]);

  useLayoutEffect(() => {
    const wrapper = element.closest(".tableWrapper");
    const colgroup = element.querySelector(":scope > colgroup");
    const body = element.tBodies[0];
    if (!wrapper || !colgroup || !body) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!element.isConnected) return;
      const rootRect = root.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      // Keep the overlay within the visible table, with room for the pins to
      // straddle its edges. Offsets may fall outside it in a scrolled table.
      const left = Math.max(wrapperRect.left, rect.left);
      const width = Math.min(wrapperRect.right, rect.right) - left;
      const scrolled = left > rect.left;
      const columns = [
        ...Array.from(colgroup.querySelectorAll("col"), (col) => {
          const bounds = col.getBoundingClientRect();
          // WebKit reports an empty client rect for <col>.
          const columnLeft = bounds.width
            ? bounds.left
            : rect.left + col.offsetLeft;
          return columnLeft - left;
        }),
        rect.right - left,
      ];
      const rows = [
        ...Array.from(
          element.rows,
          (row) => row.getBoundingClientRect().top - rect.top,
        ),
        rect.height,
      ];
      setGeometry({
        x: left - rootRect.left,
        y: rect.top - rootRect.top,
        width,
        height: rect.height,
        rows,
        columns,
        scrolled,
      });
      setEdge((current) => {
        if (!current) return current;
        const row = current.axis === "row";
        const offset = (row ? rows : columns)[current.index];
        const visible =
          (!row || !scrolled) &&
          isVisibleBoundary(offset, row ? rect.height : width);
        return visible ? current : undefined;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Typing changes the table node, but the rails only follow its layout.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    observer.observe(root);
    observer.observe(wrapper);
    let observedRows = new Set<HTMLTableRowElement>();
    const observeRows = () => {
      const next = new Set(element.rows);
      for (const row of observedRows)
        if (!next.has(row)) observer.unobserve(row);
      for (const row of next) if (!observedRows.has(row)) observer.observe(row);
      observedRows = next;
    };
    observeRows();
    const structure = new MutationObserver(() => {
      observeRows();
      schedule();
    });
    structure.observe(body, { childList: true });
    structure.observe(colgroup, {
      childList: true,
      subtree: true,
      attributeFilter: ["style"],
    });
    wrapper.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      structure.disconnect();
      wrapper.removeEventListener("scroll", schedule);
    };
  }, [element, root]);

  if (!geometry || node?.type.name !== "table") return null;

  function editBand(axis: NoteTableAxis, index: number, remove = false) {
    if (
      editor.isDestroyed ||
      editor.view.composing ||
      !element.isConnected ||
      editor.view.nodeDOM(pos) !== element.closest(".tableWrapper")
    )
      return;
    const { state, view } = editor;
    const table = state.doc.nodeAt(pos);
    if (table?.type.name !== "table") return;
    const map = TableMap.get(table);
    const count = axis === "row" ? map.height : map.width;
    if (
      index < 0 ||
      index > count ||
      (remove && (count === 1 || index === count))
    )
      return;
    const tableStart = pos + 1;
    const rect = {
      table,
      map,
      tableStart,
      left: 0,
      right: map.width,
      top: 0,
      bottom: map.height,
    };
    const tr = state.tr;
    // A spanning cell can widen a CellSelection. Structural actions use the rail index.
    if (axis === "row") {
      if (remove) removeRow(tr, rect, index);
      else addRow(tr, rect, index);
    } else if (remove) removeColumn(tr, rect, index);
    else addColumn(tr, rect, index);
    const next = tr.doc.nodeAt(pos)!;
    const nextMap = TableMap.get(next);
    const cell =
      nextMap.map[
        axis === "column"
          ? Math.min(index, nextMap.width - 1)
          : Math.min(index, nextMap.height - 1) * nextMap.width
      ];
    isolateNoteEdit(tr);
    tr.setSelection(
      TextSelection.near(tr.doc.resolve(tableStart + cell + 1)),
    ).scrollIntoView();
    view.dispatch(tr);
    view.focus();
    setBand(undefined);
    setEdge(undefined);
  }

  function select(axis: NoteTableAxis, index: number) {
    if (editor.view.composing || !node) return;
    const { state, view } = editor;
    const map = TableMap.get(node);
    if (index < 0 || index >= (axis === "row" ? map.height : map.width)) return;
    const begin = axis === "row" ? index * map.width : index;
    const end =
      axis === "row"
        ? begin + map.width - 1
        : begin + map.width * (map.height - 1);
    const selection = CellSelection.create(
      state.doc,
      pos + 1 + map.map[begin],
      pos + 1 + map.map[end],
    );
    view.dispatch(state.tr.setSelection(selection));
    view.focus();
    onOpenChange(false);
    setEdge(undefined);
    setBand({ axis, index, selection });
  }

  const { x, y, width, height, rows, columns, scrolled } = geometry;
  const boundary = root.closest(".task-note-scroll");

  function rail(axis: NoteTableAxis, offsets: number[]) {
    const row = axis === "row";
    const end = row ? height : width;
    return (
      <div className={"note-table-rail note-table-rail-" + axis}>
        {offsets.slice(0, -1).map((offset, index) => {
          const from = Math.max(0, offset);
          const size = Math.min(offsets[index + 1], end) - from;
          if (size <= 0) return null;
          return (
            <button
              key={index}
              type="button"
              className="note-table-segment"
              data-selected={
                (actionBand
                  ? actionBand.axis === axis && actionBand.index === index
                  : cells &&
                    map &&
                    (row
                      ? cells.left === 0 &&
                        cells.right === map.width &&
                        index >= cells.top &&
                        index < cells.bottom
                      : cells.top === 0 &&
                        cells.bottom === map.height &&
                        index >= cells.left &&
                        index < cells.right)) || undefined
              }
              style={
                row ? { top: from, height: size } : { left: from, width: size }
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!skipClick.current) select(axis, index);
                skipClick.current = false;
              }}
              data-note-band={axis}
              data-band-index={index}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                skipClick.current = false;
                dragged.current = {
                  axis,
                  from: index,
                  to: index,
                  doc: editor.state.doc,
                  start: row ? e.clientY : e.clientX,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = dragged.current;
                if (
                  !d ||
                  d.axis !== axis ||
                  d.from !== index ||
                  Math.abs((row ? e.clientY : e.clientX) - d.start) < 4
                )
                  return;
                skipClick.current = true;
                const rect = element.getBoundingClientRect();
                const coordinate = row
                  ? e.clientY - rect.top
                  : e.clientX - root.getBoundingClientRect().left - x;
                const bands = row ? rows : columns;
                const found = bands.findIndex(
                  (v, i) =>
                    i < bands.length - 1 &&
                    coordinate >= v &&
                    coordinate < bands[i + 1],
                );
                if (found >= 0) d.to = found;
                root
                  .querySelector("[data-band-drop]")
                  ?.removeAttribute("data-band-drop");
                root
                  .querySelector(
                    `[data-note-band="${axis}"][data-band-index="${d.to}"]`,
                  )
                  ?.setAttribute("data-band-drop", "");
              }}
              onPointerUp={() => {
                const d = dragged.current;
                dragged.current = undefined;
                root
                  .querySelector("[data-band-drop]")
                  ?.removeAttribute("data-band-drop");
                if (!d || d.from === d.to || d.doc !== editor.state.doc) return;
                const move = row ? moveTableRow : moveTableColumn;
                move({ from: d.from, to: d.to, pos: pos + 1 })(
                  editor.state,
                  (tr) => {
                    isolateNoteEdit(tr);
                    editor.view.dispatch(tr);
                  },
                );
              }}
              onPointerCancel={() => {
                dragged.current = undefined;
                root
                  .querySelector("[data-band-drop]")
                  ?.removeAttribute("data-band-drop");
              }}
              aria-label={t("tasks.table.select." + axis, { index: index + 1 })}
              aria-haspopup="dialog"
              aria-expanded={
                actionBand?.axis === axis && actionBand.index === index
              }
            />
          );
        })}
        {offsets.map((offset, index) => {
          if (!isVisibleBoundary(offset, end)) return null;
          const active = edge?.axis === axis && edge.index === index;
          return (
            <Tooltip
              key={index}
              open={active}
              onOpenChange={(open) => {
                if (open) setEdge({ axis, index });
                else
                  setEdge((current) =>
                    current?.axis === axis && current.index === index
                      ? undefined
                      : current,
                  );
              }}
            >
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  type="button"
                  className="note-table-edge"
                  data-active={active || undefined}
                  style={row ? { top: offset } : { left: offset }}
                  aria-label={t("tasks.table.insertAt." + axis, {
                    index: index + 1,
                  })}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => editBand(axis, index)}
                >
                  <span className="note-table-pin">
                    <Plus aria-hidden="true" />
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent
                className="pointer-events-none"
                sideOffset={4}
                collisionBoundary={boundary}
                collisionPadding={4}
                hideWhenDetached
              >
                {t("tasks.table.insert." + axis)}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    );
  }

  const bandAnchor =
    actionBand &&
    (actionBand.axis === "row"
      ? {
          left: 0,
          width,
          top: rows[actionBand.index],
          height: rows[actionBand.index + 1] - rows[actionBand.index],
        }
      : {
          left: Math.max(0, columns[actionBand.index]),
          width: Math.max(
            0,
            Math.min(width, columns[actionBand.index + 1]) -
              Math.max(0, columns[actionBand.index]),
          ),
          top: 0,
          height: rows[1],
        });
  return (
    <div
      className="note-table-controls"
      data-scrolled={scrolled || undefined}
      style={{ left: x, top: y, width, height }}
      contentEditable={false}
    >
      {(open ||
        (selection instanceof NodeSelection && selection.from === pos)) && (
        <div className="note-table-selection" />
      )}
      <TooltipProvider disableHoverableContent>
        {!scrolled && rail("row", rows)}
        {rail("column", columns)}
      </TooltipProvider>
      {edge && (
        <div
          className={"note-table-insert-line note-table-insert-" + edge.axis}
          style={
            edge.axis === "row"
              ? { top: rows[edge.index] }
              : { left: columns[edge.index] }
          }
        />
      )}
      <NoteTableMenu
        editor={editor}
        target={target}
        open={open}
        onOpenChange={onOpenChange}
      />
      {actionBand && bandAnchor && map && (
        <NoteTableAxisMenu
          editor={editor}
          band={actionBand}
          anchor={bandAnchor}
          boundary={boundary}
          canDelete={(actionBand.axis === "row" ? map.height : map.width) > 1}
          onStructure={(action) => {
            if (
              editor.state.doc !== actionBand.selection.$anchorCell.doc ||
              !actionBand.selection.eq(editor.state.selection)
            )
              return;
            editBand(
              actionBand.axis,
              actionBand.index + (action === "after" ? 1 : 0),
              action === "delete",
            );
          }}
          onClose={() => setBand(undefined)}
        />
      )}
    </div>
  );
}
