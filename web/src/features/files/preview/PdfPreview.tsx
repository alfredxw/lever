import { PreviewFailure } from "./PreviewUnavailable";
import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Loading } from "@/components/common";
import { readPreviewBytes } from "./fileKind";
import { PreviewPager } from "./TablePreview";

GlobalWorkerOptions.workerSrc = workerURL;

export default function PdfPreview({
  src,
  name,
}: {
  src: string;
  name: string;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [error, setError] = useState<unknown>();
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(600);
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let loading: ReturnType<typeof getDocument> | undefined;
    const timer = setTimeout(() => {
      setError(new Error("PDF took too long to load."));
      controller.abort();
      void loading?.destroy();
    }, 30_000);
    void readPreviewBytes(src, controller.signal)
      .then(async (data) => {
        if (controller.signal.aborted) return;
        loading = getDocument({
          data,
          useSystemFonts: true,
          cMapUrl: "/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdfjs/standard_fonts/",
          wasmUrl: "/pdfjs/wasm/",
        });
        loading.onPassword = () => {
          setError(new Error("This PDF is password protected."));
          void loading?.destroy();
        };
        const document = await loading.promise;
        if (!controller.signal.aborted) setPdf(document);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
      void loading?.destroy();
    };
  }, [src]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(Math.max(100, element.clientWidth - 48)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [pdf]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]>
      | undefined;
    let loaded: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void pdf
      .getPage(page + 1)
      .then(async (documentPage) => {
        loaded = documentPage;
        if (cancelled || !canvas.current) {
          documentPage.cleanup();
          return;
        }
        const natural = documentPage.getViewport({ scale: 1 });
        const viewport = documentPage.getViewport({
          scale: Math.min(2, width / natural.width),
        });
        const density = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        );
        canvas.current.width = Math.ceil(viewport.width * density);
        canvas.current.height = Math.ceil(viewport.height * density);
        canvas.current.style.width = `${viewport.width}px`;
        canvas.current.style.height = `${viewport.height}px`;
        render = documentPage.render({
          canvas: canvas.current,
          viewport,
          transform: [density, 0, 0, density, 0, 0],
          background: "white",
        });
        await render.promise;
      })
      .catch((error) => {
        if (!cancelled) setError(error);
      });
    return () => {
      cancelled = true;
      render?.cancel();
      void Promise.allSettled([render?.promise]).then(() => loaded?.cleanup());
    };
  }, [pdf, page, width]);
  if (error) return <PreviewFailure error={error} />;
  if (!pdf) return <Loading />;
  return (
    <>
      <PreviewPager page={page} count={pdf.numPages} onPage={setPage} />
      <div ref={host} className="file-pdf-scroll">
        <canvas ref={canvas} aria-label={`${name}: ${page + 1}`} />
      </div>
    </>
  );
}
