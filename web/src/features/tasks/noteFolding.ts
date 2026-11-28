import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Transaction } from "@tiptap/pm/state";
import i18n from "@/i18n";

export function changesNoteStructure(tr: Transaction) {
  return tr.steps.some((step, index) => {
    if (
      !(step instanceof ReplaceStep) ||
      step.slice.openStart ||
      step.slice.openEnd ||
      (step.slice.size && !step.slice.content.firstChild?.isInline)
    )
      return true;
    const doc = tr.docs[index],
      from = doc.resolve(step.from);
    return !from.parent.isTextblock || !from.sameParent(doc.resolve(step.to));
  });
}

export function changesNoteHeadings(tr: Transaction) {
  return (
    changesNoteStructure(tr) ||
    tr.steps.some(
      (step, i) =>
        step instanceof ReplaceStep &&
        tr.docs[i].resolve(step.from).parent.type.name === "heading",
    )
  );
}

type Folds = { anchors: Set<number>; decorations: DecorationSet };
const folds = new PluginKey<Folds>("note-folds");

function foldState(doc: PMNode, anchors: Set<number>, reveal?: number): Folds {
  const result: Decoration[] = [];
  function control(pos: number, offset: number) {
    const closed = anchors.has(pos);
    result.push(
      Decoration.widget(
        pos + offset,
        (view, getPos) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = offset
            ? "note-fold-toggle"
            : "note-fold-toggle note-heading-fold";
          button.textContent = closed ? "▸" : "▾";
          button.setAttribute("aria-expanded", String(!closed));
          button.setAttribute(
            "aria-label",
            i18n.t(closed ? "tasks.expandSection" : "tasks.foldSection"),
          );
          button.onmousedown = (e) => e.preventDefault();
          button.onclick = () => {
            const at = getPos();
            if (at === undefined || view.composing) return;
            view.dispatch(
              view.state.tr
                .setMeta(folds, { toggle: at - offset })
                .setMeta("addToHistory", false),
            );
          };
          return button;
        },
        {
          key: "fold-" + offset + "-" + closed,
          side: -1,
          stopEvent: () => true,
        },
      ),
    );
  }
  function visit(parent: PMNode, start: number) {
    const sections: { pos: number; level: number }[] = [];
    parent.forEach((child, offset, index) => {
      const pos = start + offset,
        end = pos + child.nodeSize;
      if (child.type.name === "heading") {
        while (sections.length && sections.at(-1)!.level >= child.attrs.level)
          sections.pop();
      }
      for (const h of sections) {
        if (reveal !== undefined && pos <= reveal && reveal < end)
          anchors.delete(h.pos);
        if (anchors.has(h.pos))
          result.push(
            Decoration.node(
              pos,
              end,
              { class: "note-fold-hidden" },
              { hidden: true },
            ),
          );
      }
      if (child.type.name === "heading") {
        const next = parent.maybeChild(index + 1);
        if (
          next &&
          !(
            next.type.name === "heading" &&
            next.attrs.level <= child.attrs.level
          )
        ) {
          control(pos, 0);
          sections.push({ pos, level: child.attrs.level });
        }
      } else if (!child.isLeaf && !child.isTextblock) {
        if (
          child.type.name === "listItem" &&
          child.firstChild?.isTextblock &&
          child.childCount > 1
        ) {
          const boundary = pos + 1 + child.firstChild.nodeSize;
          if (reveal !== undefined && reveal >= boundary && reveal < end - 1)
            anchors.delete(pos);
          control(pos, 2);
          child.forEach((sub, subOffset, subIndex) => {
            if (subIndex && anchors.has(pos))
              result.push(
                Decoration.node(
                  pos + 1 + subOffset,
                  pos + 1 + subOffset + sub.nodeSize,
                  { class: "note-fold-hidden" },
                  { hidden: true },
                ),
              );
          });
        }
        visit(child, pos + 1);
      }
    });
  }
  // Reveal may remove an ancestor after its button/siblings were visited.
  const count = anchors.size;
  visit(doc, 0);
  if (count !== anchors.size) return foldState(doc, anchors);
  return { anchors, decorations: DecorationSet.create(doc, result) };
}

export const NoteFolding = Extension.create({
  name: "noteFolding",
  addProseMirrorPlugins: () => [
    new Plugin<Folds>({
      key: folds,
      state: {
        init: (_, state) => foldState(state.doc, new Set()),
        apply(tr, previous) {
          const meta = tr.getMeta(folds);
          const mapped = previous.decorations.map(tr.mapping, tr.doc);
          const reveal =
            meta?.reveal ??
            (tr.selectionSet &&
            mapped.find(tr.selection.head, tr.selection.head, (s) => s.hidden)
              .length
              ? tr.selection.head
              : undefined);
          const anchors = tr.docChanged
            ? new Set(
                [...previous.anchors].flatMap((pos) => {
                  const next = tr.mapping.mapResult(pos, 1);
                  return next.deleted ? [] : [next.pos];
                }),
              )
            : previous.anchors;
          if (
            meta?.toggle === undefined &&
            reveal === undefined &&
            (!tr.docChanged || !changesNoteStructure(tr))
          )
            return { anchors, decorations: mapped };
          const next = new Set(anchors);
          if (meta?.toggle !== undefined) {
            if (next.has(meta.toggle)) next.delete(meta.toggle);
            else next.add(meta.toggle);
          }
          return foldState(tr.doc, next, reveal);
        },
      },
      props: { decorations: (state) => folds.getState(state)?.decorations },
      appendTransaction(trs, _, state) {
        if (!trs.some((tr) => tr.getMeta(folds)?.toggle !== undefined))
          return null;
        const hidden = folds
          .getState(state)
          ?.decorations.find(
            state.selection.head,
            state.selection.head,
            (s) => s.hidden,
          );
        if (!hidden?.length) return null;
        const pos = trs
          .find((tr) => tr.getMeta(folds)?.toggle !== undefined)!
          .getMeta(folds).toggle;
        return state.tr
          .setSelection(TextSelection.near(state.doc.resolve(pos + 1)))
          .setMeta("addToHistory", false);
      },
    }),
  ],
});
export function revealNotePosition(tr: Transaction, pos: number) {
  return tr.setMeta(folds, { reveal: pos }).setMeta("addToHistory", false);
}
