import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { isolateNoteEdit } from "./taskEditing";

// The leading paragraph and its task attachments move with their list item.
export function movableBlock(doc: PMNode, inside: number) {
  const $at = doc.resolve(inside);
  if (!$at.depth) return;
  let depth = $at.depth;
  if (
    depth > 1 &&
    $at.node(depth - 1).type.name === "listItem" &&
    $at.index(depth - 1) === 0
  )
    depth--;
  return { pos: $at.before(depth), node: $at.node(depth) };
}

export function moveBlock(view: EditorView, from: number, target: number) {
  if (view.composing || !view.editable) return false;
  const node = view.state.doc.nodeAt(from);
  if (!node || (from <= target && target <= from + node.nodeSize)) return false;
  const tr = view.state.tr.delete(from, from + node.nodeSize);
  const at = tr.mapping.map(target);
  const $at = tr.doc.resolve(at),
    index = $at.index();
  if ($at.textOffset || !$at.parent.canReplaceWith(index, index, node.type))
    return false;
  tr.insert(at, node).setSelection(Selection.near(tr.doc.resolve(at + 1)));
  isolateNoteEdit(tr);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function stepBlock(view: EditorView, inside: number, direction: -1 | 1) {
  const block = movableBlock(view.state.doc, inside);
  if (!block) return false;
  const edge = direction < 0 ? block.pos : block.pos + block.node.nodeSize;
  const $edge = view.state.doc.resolve(edge);
  const sibling = direction < 0 ? $edge.nodeBefore : $edge.nodeAfter;
  return (
    !!sibling && moveBlock(view, block.pos, edge + direction * sibling.nodeSize)
  );
}

export async function copyBlock(
  view: EditorView,
  inside: number,
  cut: boolean,
) {
  const doc = view.state.doc,
    block = movableBlock(doc, inside);
  if (!block) return;
  const { dom, text } = view.serializeForClipboard(
    new Slice(Fragment.from(block.node), 0, 0),
  );
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
  } else await navigator.clipboard.writeText(text);
  if (cut && !view.isDestroyed && view.state.doc === doc && !view.composing) {
    const tr = view.state.tr.deleteRange(
      block.pos,
      block.pos + block.node.nodeSize,
    );
    isolateNoteEdit(tr);
    view.dispatch(tr);
  }
}
