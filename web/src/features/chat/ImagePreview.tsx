import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ImageViewer } from "@/components/ImageViewer";

export type PreviewImage = { id: string; name: string; src: string };

const ImagePreviewContext = createContext<{
  file: PreviewImage | null;
  open: (file: PreviewImage) => void;
  close: (options?: { restoreFocus?: boolean }) => void;
} | null>(null);

// Each conversation owns its preview. The composer stays mounted and editable
// while the viewer covers only the message history above it.
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [file, setFile] = useState<PreviewImage | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const preview = useMemo(() => {
    function focusComposer() {
      const scope = root.current;
      if (!scope) return;
      Array.from(
        scope.querySelectorAll<HTMLElement>('.composer [role="textbox"]'),
      )
        .find((editor) => editor.closest(".image-preview-scope") === scope)
        ?.focus({ preventScroll: true });
    }
    return {
      file,
      open(next: PreviewImage) {
        setFile(next);
        focusComposer();
      },
      close({ restoreFocus = true } = {}) {
        setFile(null);
        if (restoreFocus) focusComposer();
      },
    };
  }, [file]);
  return (
    <ImagePreviewContext.Provider value={preview}>
      <div
        ref={root}
        className="image-preview-scope"
        onKeyDown={(event) => {
          if (
            file &&
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.stopPropagation();
            preview.close();
          }
        }}
      >
        {children}
      </div>
    </ImagePreviewContext.Provider>
  );
}

export function useImagePreview() {
  const context = useContext(ImagePreviewContext);
  if (!context) throw new Error("ImagePreviewProvider is required");
  return context;
}

export function ImagePreview() {
  const { file, close } = useImagePreview();
  return (
    file && (
      <ImageViewer
        key={file.id}
        src={file.src}
        name={file.name}
        onClose={close}
      />
    )
  );
}
