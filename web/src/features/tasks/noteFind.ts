import { Extension, getChangedRanges } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { SearchQuery } from "prosemirror-search";
import { isolateNoteEdit } from "./taskEditing";

const key = new PluginKey<{ query: SearchQuery; hits: DecorationSet }>(
  "note-find",
);
function highlights(
  state: EditorState,
  query: SearchQuery,
  from: number,
  to: number,
) {
  const found: Decoration[] = [];
  for (
    let match;
    from < to && (match = query.findNext(state, from, to));
    from = match.to
  )
    found.push(
      Decoration.inline(match.from, match.to, { class: "task-search-match" }),
    );
  return found;
}
export const NoteFind = Extension.create({
  name: "noteFind",
  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: () => ({
          query: new SearchQuery({ search: "" }),
          hits: DecorationSet.empty,
        }),
        apply(tr, previous, _before, state) {
          const text = tr.getMeta(key) as string | undefined;
          if (text !== undefined && text !== previous.query.search) {
            const query = new SearchQuery({ search: text, literal: true });
            return {
              query,
              hits: query.valid
                ? DecorationSet.create(
                    tr.doc,
                    highlights(state, query, 0, tr.doc.content.size),
                  )
                : DecorationSet.empty,
            };
          }
          if (!tr.docChanged || !previous.query.valid) return previous;
          let hits = previous.hits.map(tr.mapping, tr.doc);
          const ranges = new Map<number, number>();
          for (const { newRange } of getChangedRanges(tr)) {
            tr.doc.nodesBetween(
              Math.max(0, newRange.from - 1),
              Math.min(tr.doc.content.size, newRange.to + 1),
              (node, pos) => {
                if (!node.isTextblock) return;
                ranges.set(pos + 1, pos + node.nodeSize - 1);
                return false;
              },
            );
          }
          for (const [from, to] of ranges) {
            hits = hits
              .remove(hits.find(from, to))
              .add(tr.doc, highlights(state, previous.query, from, to));
          }
          return { query: previous.query, hits };
        },
      },
      props: {
        decorations(state) {
          const hits = key.getState(state)?.hits;
          const { from, to } = state.selection;
          if (
            !hits ||
            from === to ||
            !hits
              .find(from, to)
              .some((hit) => hit.from === from && hit.to === to)
          )
            return hits;
          return hits.add(state.doc, [
            Decoration.inline(from, to, { class: "note-current-match" }),
          ]);
        },
      },
    }),
  ],
});

export function setNoteQuery(state: EditorState, query: string) {
  return key.getState(state)?.query.search === query
    ? null
    : state.tr.setMeta(key, query).setMeta("addToHistory", false);
}
export function noteHits(state: EditorState) {
  return (
    key
      .getState(state)
      ?.hits.find()
      .sort((a, b) => a.from - b.from) ?? []
  );
}

export function selectHit(state: EditorState, direction: number) {
  const hits = noteHits(state);
  const { from, to } = state.selection;
  const hit =
    direction > 0
      ? (hits.find((hit) => hit.from >= to) ?? hits[0])
      : (hits
          .slice()
          .reverse()
          .find((hit) => hit.to <= from) ?? hits.at(-1));
  if (hit)
    return state.tr
      .setSelection(TextSelection.create(state.doc, hit.from, hit.to))
      .scrollIntoView();
}

export function replaceHits(state: EditorState, value: string, all: boolean) {
  const hits = noteHits(state);
  const { from, to } = state.selection;
  const hit =
    hits.find((hit) => hit.from === from && hit.to === to) ??
    hits.find((hit) => hit.from >= from) ??
    hits[0];
  const tr = state.tr;
  for (const match of all ? hits.reverse() : hit ? [hit] : [])
    tr.insertText(value, match.from, match.to);
  if (!tr.docChanged) return;
  if (!all && hit)
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(hit.to)));
  isolateNoteEdit(tr);
  return tr;
}
