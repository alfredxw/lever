import { PreviewUnavailable } from "./PreviewUnavailable";
import { lazy, Suspense, useState } from "react";
import { Loading } from "@/components/common";
import type { FileKind, OfficeKind } from "./fileKind";
const ImagePreview = lazy(() => import("./ImageFilePreview"));
const PdfPreview = lazy(() => import("./PdfPreview"));
const FontPreview = lazy(() => import("./FontPreview"));
const OfficePreview = lazy(() => import("./OfficePreview"));
const BinaryPreview = lazy(() => import("./BinaryPreview"));

export default function AssetPreview({
  kind,
  src,
  name,
}: {
  kind: FileKind;
  src: string;
  name: string;
}) {
  const [error, setError] = useState(false);
  if (error) return <PreviewUnavailable />;
  return (
    <Suspense fallback={<Loading />}>
      {kind === "image" ? (
        <ImagePreview src={src} name={name} />
      ) : kind === "pdf" ? (
        <PdfPreview src={src} name={name} />
      ) : kind === "font" ? (
        <FontPreview src={src} name={name} />
      ) : kind === "archive" || kind === "sqlite" ? (
        <BinaryPreview src={src} name={name} kind={kind} />
      ) : kind === "audio" || kind === "video" ? (
        <div className="file-media-preview">
          {kind === "audio" ? (
            <audio
              src={src}
              controls
              preload="metadata"
              onError={() => setError(true)}
              aria-label={name}
            />
          ) : (
            <video
              src={src}
              controls
              playsInline
              preload="metadata"
              onError={() => setError(true)}
              aria-label={name}
            />
          )}
        </div>
      ) : (
        <OfficePreview src={src} name={name} kind={kind as OfficeKind} />
      )}
    </Suspense>
  );
}
