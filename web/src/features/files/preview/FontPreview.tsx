import { PreviewFailure } from "./PreviewUnavailable";
import { useEffect, useState } from "react";
import { Loading } from "@/components/common";
import { readPreviewBytes } from "./fileKind";
import { DocumentFrame } from "./DocumentFrame";

export default function FontPreview({
  src,
  name,
}: {
  src: string;
  name: string;
}) {
  const [data, setData] = useState<string>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(new Error("Font preview timed out."));
      controller.abort();
    }, 30_000);
    void readPreviewBytes(src, controller.signal, 10 * 1024 * 1024)
      .then(async (bytes) => {
        await new FontFace("preview", bytes).load();
        const reader = new FileReader();
        reader.onload = () => {
          clearTimeout(timer);
          if (!controller.signal.aborted) setData(String(reader.result));
        };
        reader.onerror = () => {
          clearTimeout(timer);
          if (!controller.signal.aborted)
            setError(new Error("Could not decode this font."));
        };
        reader.readAsDataURL(new Blob([bytes]));
      })
      .catch((error) => {
        clearTimeout(timer);
        if (!controller.signal.aborted) setError(error);
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [src]);
  if (error) return <PreviewFailure error={error} />;
  if (!data) return <Loading />;
  return (
    <DocumentFrame
      title={name}
      html={`<style>@font-face{font-family:preview;src:url('${data}')}body{font-family:preview}</style>${[12, 16, 24, 40, 64].map((size) => `<p style="font-size:${size}px">The quick brown fox jumps over the lazy dog.<br>天地玄黄，宇宙洪荒。0123456789</p>`).join("")}`}
    />
  );
}
