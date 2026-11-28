import { useRef, useState, type CSSProperties } from "react";
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from "@tiptap/react";
import { Fragment } from "@tiptap/pm/model";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { isolateNoteEdit } from "./taskEditing";

import { noteTones } from "./noteFormatting";

export function CalloutView({ node, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation();
  return (
    <NodeViewWrapper
      as="aside"
      data-note-callout=""
      data-note-tone={node.attrs.tone || undefined}
    >
      <div contentEditable={false} className="note-callout-control">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("tasks.calloutStyle")}
            >
              {node.attrs.emoji || <Palette />}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto space-y-2 p-2">
            <Input
              aria-label={t("tasks.calloutIcon")}
              placeholder={t("tasks.calloutIcon")}
              value={node.attrs.emoji || ""}
              maxLength={12}
              onChange={(e) => updateAttributes({ emoji: e.target.value })}
            />
            <ToggleGroup
              type="single"
              value={node.attrs.tone || "gray"}
              onValueChange={(tone) => tone && updateAttributes({ tone })}
            >
              {noteTones.map((tone) => (
                <ToggleGroupItem
                  key={tone}
                  value={tone}
                  aria-label={t("tasks.tone." + tone)}
                  title={t("tasks.tone." + tone)}
                >
                  <span data-note-tone={tone} className="note-tone-chip" />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </PopoverContent>
        </Popover>
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

function template(ratios: number[]) {
  return ratios.map((r) => "minmax(0," + r + "fr)").join(" ");
}
export function ColumnsView({ editor, getPos, node }: NodeViewProps) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number[]>();
  const drag = useRef<{
    x: number;
    span: number;
    ratios: number[];
    index: number;
  }>(undefined);
  const configured = node.attrs.ratios;
  const ratios: number[] =
    Array.isArray(configured) &&
    configured.length === node.childCount &&
    configured.every((x) => Number.isFinite(x) && x > 0)
      ? configured
      : Array(node.childCount).fill(1);
  const live = preview ?? ratios;
  function resize(count: number) {
    const pos = getPos();
    if (
      pos === undefined ||
      editor.state.doc.nodeAt(pos) !== node ||
      count === node.childCount ||
      editor.view.composing
    )
      return;
    const columns = Array.from(
      { length: count },
      (_, index) =>
        node.maybeChild(index) ??
        editor.schema.nodes.noteColumn.createAndFill()!,
    );
    if (count < node.childCount) {
      let content = columns[count - 1].content;
      for (let i = count; i < node.childCount; i++)
        content = content.append(node.child(i).content);
      columns[count - 1] = columns[count - 1].copy(content);
    }
    const tr = editor.state.tr.replaceWith(
      pos,
      pos + node.nodeSize,
      node.type.create(null, Fragment.fromArray(columns)),
    );
    isolateNoteEdit(tr);
    editor.view.dispatch(tr);
  }
  return (
    <NodeViewWrapper
      className="note-columns-block"
      ref={host}
      style={{ "--note-columns": template(live) } as CSSProperties}
    >
      <div contentEditable={false} className="note-columns-tools">
        <ToggleGroup
          type="single"
          size="sm"
          value={String(node.childCount)}
          aria-label={t("tasks.block.columns")}
          onValueChange={(v) => v && resize(Number(v))}
        >
          {[2, 3, 4, 5].map((n) => (
            <ToggleGroupItem
              key={n}
              value={String(n)}
              aria-label={t("tasks.columnCount", { count: n })}
            >
              {n}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="note-columns-body">
        <NodeViewContent className="note-columns-content" />
        <div contentEditable={false} className="note-column-dividers">
          {ratios.map((_, index) => (
            <div key={index}>
              {index < ratios.length - 1 && (
                <button
                  type="button"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("tasks.columnWidth")}
                  aria-valuenow={Math.round(
                    (100 * live[index]) / live.reduce((a, b) => a + b, 0),
                  )}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      drag.current = undefined;
                      setPreview(undefined);
                      return;
                    }
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const pos = getPos();
                    if (pos === undefined) return;
                    const next = [...ratios],
                      delta =
                        (e.key === "ArrowRight" ? 1 : -1) *
                        (next[index] + next[index + 1]) *
                        0.05;
                    if (
                      next[index] + delta <= 0.12 ||
                      next[index + 1] - delta <= 0.12
                    )
                      return;
                    next[index] += delta;
                    next[index + 1] -= delta;
                    const tr = editor.state.tr.setNodeAttribute(
                      pos,
                      "ratios",
                      next,
                    );
                    isolateNoteEdit(tr);
                    editor.view.dispatch(tr);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || !host.current) return;
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = {
                      x: e.clientX,
                      span: host.current.clientWidth - (ratios.length - 1) * 16,
                      ratios,
                      index,
                    };
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d || !d.span) return;
                    const sum = d.ratios.reduce((a, b) => a + b, 0),
                      pair = d.ratios[index] + d.ratios[index + 1];
                    let left = Math.max(
                      pair * 0.1,
                      Math.min(
                        pair * 0.9,
                        d.ratios[index] + ((e.clientX - d.x) * sum) / d.span,
                      ),
                    );
                    const snap = (Math.round((left / sum) * 10) * sum) / 10;
                    if (
                      snap > 0 &&
                      snap < pair &&
                      (Math.abs(snap - left) * d.span) / sum < 5
                    )
                      left = snap;
                    const next = [...d.ratios];
                    next[index] = left;
                    next[index + 1] = pair - left;
                    setPreview(next);
                  }}
                  onPointerUp={() => {
                    const pos = getPos();
                    if (
                      drag.current &&
                      preview &&
                      pos !== undefined &&
                      editor.state.doc.nodeAt(pos) === node
                    ) {
                      const tr = editor.state.tr.setNodeAttribute(
                        pos,
                        "ratios",
                        preview,
                      );
                      isolateNoteEdit(tr);
                      editor.view.dispatch(tr);
                    }
                    drag.current = undefined;
                    setPreview(undefined);
                  }}
                  onLostPointerCapture={() => {
                    drag.current = undefined;
                    setPreview(undefined);
                  }}
                >
                  {preview && drag.current?.index === index && (
                    <span>
                      {Math.round(
                        (100 * live[index]) / live.reduce((a, b) => a + b, 0),
                      )}
                      %
                    </span>
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </NodeViewWrapper>
  );
}
