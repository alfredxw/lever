import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ImageViewer } from "@/components/ImageViewer";
import { noteImage, noteAssetURL } from "./noteAsset";
import { isolateNoteEdit } from "./taskEditing";

export function NoteImageGallery({
  editor,
  position,
  onClose,
}: {
  editor: Editor;
  position: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const images = useMemo(() => {
    const all: {
      pos: number;
      src: string;
      name: string;
      path: string;
      caption: string;
    }[] = [];
    editor.state.doc.descendants((node, pos) => {
      const asset = noteImage(node);
      const src = asset && noteAssetURL(asset.path, asset.name);
      if (asset && src)
        all.push({
          pos,
          src,
          name: asset.name,
          path: asset.path,
          caption: node.attrs.caption || "",
        });
    });
    return all;
  }, [editor, position]);
  const [index, setIndex] = useState(
    Math.max(
      0,
      images.findIndex((img) => img.pos === position),
    ),
  );
  const current = images[index];
  if (!current) return null;
  function advance(dir: number) {
    setIndex((i) => (i + dir + images.length) % images.length);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="note-image-gallery"
        showCloseButton={false}
        onKeyDownCapture={(e) => {
          if (
            e.target instanceof HTMLInputElement ||
            images.length < 2 ||
            e.altKey ||
            e.metaKey ||
            e.ctrlKey
          )
            return;
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            advance(e.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <DialogTitle className="truncate text-sm">{current.name}</DialogTitle>
        <ImageViewer
          key={current.src}
          src={current.src}
          name={current.name}
          onClose={onClose}
        />
        <div className="flex items-center gap-2">
          {images.length > 1 && (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("tasks.previousImage")}
                onClick={() => advance(-1)}
              >
                <ArrowLeft />
              </Button>
              <span className="text-xs">
                {index + 1}/{images.length}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("tasks.nextImage")}
                onClick={() => advance(1)}
              >
                <ArrowRight />
              </Button>
            </>
          )}
          <Input
            key={current.pos}
            defaultValue={current.caption}
            aria-label={t("tasks.image.caption")}
            placeholder={t("tasks.image.caption")}
            maxLength={300}
            onBlur={(e) => {
              const caption = e.target.value;
              const node = editor.state.doc.nodeAt(current.pos);
              if (
                node?.attrs.path !== current.path ||
                editor.view.composing ||
                caption === node.attrs.caption
              )
                return;
              const tr = editor.state.tr.setNodeAttribute(
                current.pos,
                "caption",
                caption,
              );
              isolateNoteEdit(tr);
              editor.view.dispatch(tr);
              current.caption = caption;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing)
                e.currentTarget.blur();
            }}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("tasks.image.copy")}
            onClick={async () => {
              try {
                const png = async () => {
                  const res = await fetch(current.src);
                  if (!res.ok) throw new Error(res.statusText);
                  const blob = await res.blob();
                  if (blob.type === "image/png") return blob;
                  const image = await createImageBitmap(blob);
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = image.width;
                    canvas.height = image.height;
                    canvas.getContext("2d")!.drawImage(image, 0, 0);
                    return await new Promise<Blob>((resolve, reject) =>
                      canvas.toBlob(
                        (blob) =>
                          blob
                            ? resolve(blob)
                            : reject(new Error(t("chat.copyFailed"))),
                        "image/png",
                      ),
                    );
                  } finally {
                    image.close();
                  }
                };
                await navigator.clipboard.write([
                  new ClipboardItem({ "image/png": png() }),
                ]);
              } catch (e) {
                toast.error(String(e));
              }
            }}
          >
            <Copy />
          </Button>
          <Button asChild variant="ghost" size="icon-xs">
            <a
              href={current.src}
              download={current.name}
              aria-label={t("tasks.image.download")}
            >
              <Download />
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
