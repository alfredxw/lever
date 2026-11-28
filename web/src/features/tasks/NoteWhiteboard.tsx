import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Pencil, Presentation } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorNotice, Loading } from "@/components/common";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { noteAssetURL } from "./noteAsset";
import { isolateNoteEdit } from "./taskEditing";

export type BoardAssets = {
  title: string;
  scenePath: string;
  previewPath: string;
};
const Canvas = lazy(() => import("./NoteBoardCanvas"));

class CanvasBoundary extends Component<
  { children: ReactNode; close: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <div className="p-4">
        <ErrorNotice error={this.state.error} />
        {this.props.close}
      </div>
    ) : (
      this.props.children
    );
  }
}

export function NoteBoardDialog({
  title,
  scenePath,
  mermaid,
  noteId,
  onSave,
  onClose,
}: {
  title: string;
  scenePath?: string;
  mermaid?: string;
  noteId: string;
  onSave: (assets: BoardAssets) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="note-board-dialog"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">
          {t("tasks.block.whiteboard")}
        </DialogTitle>
        <CanvasBoundary
          close={
            <Button variant="ghost" onClick={onClose}>
              {t("common.close")}
            </Button>
          }
        >
          <Suspense
            fallback={
              <div className="p-4">
                <Loading />
                <Button variant="ghost" onClick={onClose}>
                  {t("common.cancel")}
                </Button>
              </div>
            }
          >
            <Canvas
              {...{ title, scenePath, mermaid, noteId, onSave, onClose }}
            />
          </Suspense>
        </CanvasBoundary>
      </DialogContent>
    </Dialog>
  );
}

function BoardCard({ node, editor, getPos, extension }: NodeViewProps) {
  const { t } = useTranslation();
  const [editing, edit] = useState<BoardAssets>();
  const attrs = node.attrs as BoardAssets;
  const title = attrs.title || t("tasks.block.whiteboard");
  const src = noteAssetURL(attrs.previewPath, title + ".png");
  return (
    <NodeViewWrapper
      className="note-board-card"
      contentEditable={false}
      onDoubleClick={() => edit(attrs)}
    >
      {src && <img src={src} alt={title} loading="lazy" draggable={false} />}
      <div className="note-board-caption">
        <Presentation size={16} />
        <span>{title}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("tasks.board.edit")}
          onClick={() => edit(attrs)}
        >
          <Pencil />
        </Button>
      </div>
      {editing && (
        <NoteBoardDialog
          noteId={extension.options.noteId}
          scenePath={editing.scenePath}
          title={editing.title}
          onClose={() => edit(undefined)}
          onSave={(assets) => {
            const pos = getPos();
            const current =
              pos === undefined ? null : editor.state.doc.nodeAt(pos);
            if (
              pos === undefined ||
              current?.type.name !== "noteWhiteboard" ||
              current.attrs.scenePath !== editing.scenePath ||
              current.attrs.title !== editing.title
            )
              throw new Error(t("tasks.sourceRemoved"));
            const tr = editor.state.tr.setNodeMarkup(pos, undefined, assets);
            isolateNoteEdit(tr);
            editor.view.dispatch(tr);
            edit(undefined);
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

export const NoteWhiteboard = Node.create<{ noteId: string }>({
  name: "noteWhiteboard",
  group: "block",
  atom: true,
  draggable: true,
  addOptions: () => ({ noteId: "" }),
  addAttributes: () => ({
    engine: { default: "drawnix", rendered: false },
    scenePath: { default: "", rendered: false },
    previewPath: { default: "", rendered: false },
    title: { default: "", rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "figure[data-note-board]",
      getAttrs: (el) => ({
        scenePath: el.dataset.noteBoard,
        previewPath: el.dataset.preview || "",
        title: el.querySelector("figcaption")?.textContent || "",
      }),
    },
  ],
  renderHTML({ node }) {
    const { scenePath, previewPath, title } = node.attrs as BoardAssets;
    const src = noteAssetURL(previewPath, title + ".png");
    return [
      "figure",
      { "data-note-board": scenePath, "data-preview": previewPath },
      ...(src ? [["img", { src, alt: title }]] : []),
      ["figcaption", {}, title],
    ];
  },
  renderMarkdown(node) {
    const attrs = node.attrs as BoardAssets;
    const title = attrs.title.replace(/[\\[\]]/g, "\\$&") || "Drawnix";
    if (!attrs.scenePath) return title;
    return attrs.previewPath
      ? `[![${title}](${attrs.previewPath})](${attrs.scenePath})`
      : `[${title}.drawnix](${attrs.scenePath})`;
  },
  addNodeView: () => ReactNodeViewRenderer(BoardCard),
});
