import {
  Fragment,
  type Node,
  type ResolvedPos,
  type Slice,
} from "@tiptap/pm/model";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { noteImage } from "./noteAsset";
import { taskBlocks } from "./taskDocument";
import { hasTaskCheckbox } from "./taskEditing";

export function taskAtImagePosition($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    const title = node.type.name === "listItem" ? node.firstChild : node;
    if (title?.type.name !== "paragraph" || !title.attrs.taskId) continue;
    if (hasTaskCheckbox(title))
      return {
        id: title.attrs.taskId as string,
        pos: node === title ? $pos.before(depth) : $pos.start(depth),
      };
    return;
  }
}

export function imageDropPosition(view: EditorView, event: DragEvent) {
  const position = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  if (!position) return;
  const { doc } = view.state;
  const task = taskAtImagePosition(doc.resolve(position.pos));
  if (task || position.inside < 0) return { pos: position.pos, task };
  const inside = doc.nodeAt(position.inside);
  return {
    pos: position.pos,
    task:
      inside?.type.name === "paragraph"
        ? taskAtImagePosition(doc.resolve(position.inside + 1))
        : undefined,
  };
}

export function imageSlice(slice: Slice | undefined) {
  if (!slice || slice.openStart || slice.openEnd || !slice.content.size) return;
  const images = slice.content.content;
  if (images.every(noteImage)) return images;
}

export function appendTaskImages(
  tr: Transaction,
  id: string,
  images: readonly Node[],
) {
  const task = taskBlocks(tr.doc).find((block) => block.id === id);
  if (!task?.checkbox) return false;
  const content = Fragment.fromArray(images);
  let position: number;
  if (task.listItem) {
    // The title starts immediately inside the item's opening token.
    position = task.pos + task.listItem.nodeSize - 2;
    tr.insert(position, content);
  } else {
    const { bulletList, listItem } = tr.doc.type.schema.nodes;
    const $title = tr.doc.resolve(task.pos);
    const index = $title.index();
    if (!$title.parent.canReplaceWith(index, index + 1, bulletList))
      return false;
    const end = task.pos + task.paragraph.nodeSize;
    tr.replaceWith(
      task.pos,
      end,
      bulletList.create(
        null,
        listItem.create(null, [task.paragraph, ...images]),
      ),
    );
    position = end + 2;
  }
  tr.setSelection(
    NodeSelection.create(
      tr.doc,
      position + content.size - images.at(-1)!.nodeSize,
    ),
  );
  return true;
}
