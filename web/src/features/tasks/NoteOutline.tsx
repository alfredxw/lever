import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { changesNoteHeadings, revealNotePosition } from "./noteFolding";

type Heading = { pos: number; text: string; level: number };
export function NoteOutline({
  editor,
  compact,
  onClose,
}: {
  editor: Editor;
  compact: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState(-1);
  const [closed, setClosed] = useState<Set<number>>(new Set());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function scan() {
      const headings: Heading[] = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== "heading") return;
        headings.push({ pos, text: node.textContent, level: node.attrs.level });
        return false;
      });
      setHeadings(headings);
    }
    function update({ transaction: tr }: { transaction: Transaction }) {
      if (!tr.docChanged) return;
      setClosed((previous) => {
        if (!previous.size) return previous;
        const positions = new Set<number>();
        for (const pos of previous) {
          const next = tr.mapping.mapResult(pos, 1);
          if (!next.deleted) positions.add(next.pos);
        }
        return positions;
      });
      if (changesNoteHeadings(tr)) {
        clearTimeout(timer);
        timer = setTimeout(scan, 120);
      } else
        setHeadings((previous) =>
          previous.map((heading) => {
            const pos = tr.mapping.map(heading.pos, 1);
            return pos === heading.pos ? heading : { ...heading, pos };
          }),
        );
    }
    scan();
    editor.on("transaction", update);
    return () => {
      clearTimeout(timer);
      editor.off("transaction", update);
    };
  }, [editor]);
  useEffect(() => {
    const root = editor.view.dom.closest(".task-note-scroll");
    if (!root) return;
    let frame = 0;
    function update() {
      const top = root!.getBoundingClientRect().top + 32;
      let pos = headings[0]?.pos ?? -1;
      for (const h of headings) {
        const el = editor.view.nodeDOM(h.pos);
        if (!(el instanceof HTMLElement) || !el.getClientRects().length)
          continue;
        if (el.getBoundingClientRect().top > top) break;
        pos = h.pos;
      }
      setActive(pos);
    }
    function scroll() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    }
    update();
    root.addEventListener("scroll", scroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", scroll);
      cancelAnimationFrame(frame);
    };
  }, [editor, headings]);
  const levels = [...new Set(headings.map((h) => h.level))].sort();
  let hiddenLevel = 7;
  return (
    <nav
      aria-label={t("tasks.outline")}
      className={
        "task-document-outline note-outline-panel" +
        (compact ? " note-outline-overlay" : "")
      }
    >
      {!headings.length && <p>{t("tasks.emptyOutline")}</p>}
      {headings.map((h, i) => {
        if (h.level > hiddenLevel) return null;
        hiddenLevel = closed.has(h.pos) ? h.level : 7;
        const nested = (headings[i + 1]?.level ?? 0) > h.level;
        return (
          <div
            key={h.pos}
            className="note-outline-row"
            style={{ paddingInlineStart: levels.indexOf(h.level) * 10 }}
          >
            {nested && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={h.text}
                aria-expanded={!closed.has(h.pos)}
                onClick={() =>
                  setClosed((old) => {
                    const n = new Set(old);
                    if (!n.delete(h.pos)) n.add(h.pos);
                    return n;
                  })
                }
              >
                {closed.has(h.pos) ? <ChevronRight /> : <ChevronDown />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-current={active === h.pos ? "location" : undefined}
              onClick={() => {
                if (
                  editor.isDestroyed ||
                  editor.state.doc.nodeAt(h.pos)?.type.name !== "heading"
                )
                  return;
                editor.view.dispatch(
                  revealNotePosition(editor.state.tr, h.pos + 1),
                );
                const el = editor.view.nodeDOM(h.pos);
                if (el instanceof HTMLElement)
                  el.scrollIntoView({ block: "start" });
                setActive(h.pos);
                if (compact) onClose();
              }}
            >
              <span className="truncate">
                {h.text || t("tasks.block.heading", { level: h.level })}
              </span>
            </Button>
          </div>
        );
      })}
    </nav>
  );
}
