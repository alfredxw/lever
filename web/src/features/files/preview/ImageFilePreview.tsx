import { PreviewFailure, PreviewUnavailable } from "./PreviewUnavailable";
import { useEffect, useState } from "react";
import { Loading } from "@/components/common";
import { ImageViewer } from "@/components/ImageViewer";
import { usePreviewWorker } from "./usePreviewWorker";

export default function ImageFilePreview({
  src,
  name,
}: {
  src: string;
  name: string;
}) {
  return /\.(heic|heif|tiff?)$/i.test(name) ? (
    <DecodedImage src={src} name={name} />
  ) : (
    <LoadedImage src={src} name={name} />
  );
}
function DecodedImage({ src, name }: { src: string; name: string }) {
  const { result, error } = usePreviewWorker<{ blob: Blob }>(
    src,
    () =>
      new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
        type: "module",
      }),
    { heif: /\.(heic|heif)$/i.test(name) },
  );
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);
  if (error) return <PreviewFailure error={error} />;
  return url ? <LoadedImage src={url} name={name} /> : <Loading />;
}
function LoadedImage({ src, name }: { src: string; name: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const image = new Image();
    image.onload = () => setState("ready");
    image.onerror = () => setState("error");
    image.src = src;
    return () => {
      image.onload = null;
      image.onerror = null;
      image.src = "";
    };
  }, [src]);
  if (state === "error") return <PreviewUnavailable />;
  return state === "ready" ? (
    <div className="file-image-viewer">
      <ImageViewer src={src} name={name} />
    </div>
  ) : (
    <Loading />
  );
}
