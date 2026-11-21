import { Node, type NodeViewRendererProps } from "@tiptap/core";
import {
  DOMSerializer,
  type DOMOutputSpec,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { NodeSelection, type Selection } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import { api } from "@/api/client";
import type { NoteAlignment } from "./noteFormatting";
import { isolateNoteEdit } from "./taskEditing";

export type NoteAsset = { path: string; name: string; image: boolean };
type NoteImageLayout = { width: number | null; align: NoteAlignment };

export function noteAssetURL(path: string, name: string) {
  const id = /^\.assets\/([a-f0-9]{64})$/.exec(path)?.[1];
  return id
    ? "/api/tasks/note-assets/" + id + "?name=" + encodeURIComponent(name)
    : undefined;
}

export function noteImage(node: ProseMirrorNode | null | undefined) {
  if (node?.type.name === "noteAsset" && node.attrs.image === true)
    return node.attrs as NoteAsset;
}

function imageWidth(width: unknown) {
  return typeof width === "number" && Number.isSafeInteger(width) && width > 0
    ? width
    : null;
}

export function noteImageAlignment(align: unknown): NoteAlignment {
  return align === "center" || align === "right" ? align : "left";
}

export function selectedNoteImage(selection: Selection) {
  if (selection instanceof NodeSelection && noteImage(selection.node))
    return selection;
}

export function setNoteImageAttribute<K extends keyof NoteImageLayout>(
  view: EditorView,
  pos: number,
  attribute: K,
  value: NoteImageLayout[K],
) {
  if (!view.editable || view.composing) return;
  const node = view.state.doc.nodeAt(pos);
  if (
    node?.type.name !== "noteAsset" ||
    node.attrs.image !== true ||
    node.attrs[attribute] === value
  )
    return;
  const tr = view.state.tr.setNodeAttribute(pos, attribute, value);
  isolateNoteEdit(tr);
  view.dispatch(tr);
}

function renderAsset({
  path,
  name,
  image,
  align,
  width,
}: NoteAsset & NoteImageLayout): DOMOutputSpec {
  const url = noteAssetURL(path, name);
  return [
    "figure",
    {
      "data-note-asset": path,
      "data-note-asset-name": name,
      ...(image && { "data-note-image": noteImageAlignment(align) }),
    },
    !url
      ? ["span", {}, name]
      : image
        ? [
            "img",
            {
              src: url,
              alt: name,
              loading: "lazy",
              draggable: "false",
              width: imageWidth(width),
            },
          ]
        : ["a", { href: url, download: name }, name],
  ];
}

function noteAssetView({
  node,
  view,
  getPos,
}: NodeViewRendererProps): NodeView {
  const document = view.dom.ownerDocument;
  const { dom } = DOMSerializer.renderSpec(
    document,
    renderAsset(node.attrs as NoteAsset & NoteImageLayout),
  );
  const figure = dom as HTMLElement;
  const img = figure.querySelector("img");
  if (!img) return { dom };

  let width = imageWidth(node.attrs.width);
  let align = noteImageAlignment(node.attrs.align);
  let drag:
    | {
        handle: HTMLElement;
        pointerId: number;
        startX: number;
        startWidth: number;
        multiplier: number;
      }
    | undefined;

  const displayWidth = (width: number | null) => {
    if (width === null) img.removeAttribute("width");
    else img.width = width;
  };

  const trackLoad = () => {
    figure.toggleAttribute("data-note-image-ready", img.naturalWidth > 0);
  };
  img.addEventListener("load", trackLoad);
  img.addEventListener("error", trackLoad);
  trackLoad();

  const previewResize = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    const { startX, startWidth, multiplier } = drag;
    const next = Math.round(startWidth + (event.clientX - startX) * multiplier);
    displayWidth(Math.max(Math.min(32, startWidth), next));
  };

  const finishResize = (event?: PointerEvent) => {
    if (!drag) return;
    const { handle, pointerId, startWidth } = drag;
    if (event) previewResize(event);
    const finalWidth = event
      ? Math.round(img.getBoundingClientRect().width)
      : startWidth;
    drag = undefined;
    figure.removeAttribute("data-note-image-resizing");
    view.dom.removeEventListener("keydown", cancelOnEscape, true);
    if (handle.hasPointerCapture(pointerId))
      handle.releasePointerCapture(pointerId);
    displayWidth(width);
    if (finalWidth <= 0 || finalWidth === startWidth) return;
    const pos = getPos();
    if (pos !== undefined)
      setNoteImageAttribute(view, pos, "width", finalWidth);
  };

  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finishResize();
  };

  for (const corner of [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ]) {
    const handle = document.createElement("span");
    handle.dataset.noteImageHandle = corner;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      if (
        drag ||
        !event.isPrimary ||
        event.button !== 0 ||
        !view.editable ||
        view.composing ||
        !img.naturalWidth
      )
        return;
      const pos = getPos();
      const startWidth = Math.round(img.getBoundingClientRect().width);
      if (pos === undefined || startWidth < 1) return;
      event.preventDefault();
      event.stopPropagation();
      const selection = selectedNoteImage(view.state.selection);
      if (selection?.from !== pos)
        view.dispatch(
          view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)),
        );
      view.focus();
      drag = {
        handle,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        multiplier:
          (corner.endsWith("left") ? -1 : 1) * (align === "center" ? 2 : 1),
      };
      handle.setPointerCapture(event.pointerId);
      figure.setAttribute("data-note-image-resizing", "");
      view.dom.addEventListener("keydown", cancelOnEscape, true);
    });
    handle.addEventListener("pointermove", previewResize);
    handle.addEventListener("pointerup", (event) => {
      if (drag?.pointerId === event.pointerId) finishResize(event);
    });
    const cancel = (event: PointerEvent) => {
      if (drag?.pointerId === event.pointerId) finishResize();
    };
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    figure.append(handle);
  }

  return {
    dom,
    update(next) {
      if (
        next.attrs.path !== node.attrs.path ||
        next.attrs.name !== node.attrs.name ||
        next.attrs.image !== node.attrs.image
      )
        return false;
      const nextWidth = imageWidth(next.attrs.width);
      const nextAlign = noteImageAlignment(next.attrs.align);
      if (nextWidth !== width || nextAlign !== align) {
        finishResize();
        width = nextWidth;
        align = nextAlign;
        figure.dataset.noteImage = align;
        displayWidth(width);
      }
      return true;
    },
    ignoreMutation: (mutation) => mutation.type !== "selection",
    destroy: () => finishResize(),
  };
}

export const NoteAssetBlock = Node.create({
  name: "noteAsset",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      path: { default: "", rendered: false },
      name: { default: "", rendered: false },
      image: { default: false, rendered: false },
      width: { default: null, rendered: false },
      align: { default: "left", rendered: false },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure[data-note-asset]",
        getAttrs: (element) => {
          const path = element.dataset.noteAsset ?? "";
          const name = element.dataset.noteAssetName ?? "";
          const image = element.hasAttribute("data-note-image");
          return noteAssetURL(path, name)
            ? {
                path,
                name,
                image,
                ...(image && {
                  width: imageWidth(
                    Number(element.querySelector("img")?.getAttribute("width")),
                  ),
                  align: noteImageAlignment(element.dataset.noteImage),
                }),
              }
            : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return renderAsset(node.attrs as NoteAsset & NoteImageLayout);
  },
  addNodeView() {
    return noteAssetView;
  },
  renderMarkdown(node) {
    const { path, name, image } = node.attrs as NoteAsset;
    const url = noteAssetURL(path, name);
    return url
      ? (image ? "!" : "") +
          "[" +
          name.replace(/[\\[\]]/g, "\\$&") +
          "](" +
          path +
          ")"
      : name;
  },
});

export function uploadNoteAsset(noteId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  return api<NoteAsset>("/tasks/notes/" + noteId + "/assets", form);
}
