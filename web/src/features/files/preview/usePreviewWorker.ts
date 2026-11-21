import { useEffect, useRef, useState } from "react";
import { readPreviewBytes } from "./fileKind";

export function usePreviewWorker<T>(
  src: string,
  create: () => Worker,
  input: object,
) {
  const [result, setResult] = useState<T>();
  const [error, setError] = useState<unknown>();
  const worker = useRef<Worker>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fail = useRef<(error: unknown) => void>(() => {});
  const send = (message: object) => {
    if (!worker.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => fail.current(new Error("Preview took too long to load.")),
      30_000,
    );
    worker.current.postMessage(message);
  };
  useEffect(() => {
    const controller = new AbortController();
    const current = create();
    worker.current = current;
    const failPreview = (cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause);
      clearTimeout(timer.current);
      controller.abort();
      current.terminate();
      worker.current = null;
    };
    fail.current = failPreview;
    timer.current = setTimeout(
      () => failPreview(new Error("Preview took too long to load.")),
      30_000,
    );
    current.onmessage = ({
      data,
    }: MessageEvent<
      T & { type?: string; message?: string; error?: string }
    >) => {
      if (controller.signal.aborted) return;
      clearTimeout(timer.current);
      if (data.type === "error" || data.error)
        failPreview(new Error(data.message ?? data.error));
      else setResult(data);
    };
    current.onerror = () =>
      failPreview(new Error("Could not load the preview renderer."));
    current.onmessageerror = () =>
      failPreview(new Error("Could not read the preview result."));
    void readPreviewBytes(src, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted)
          current.postMessage({ ...input, bytes }, [bytes]);
      })
      .catch(failPreview);
    return () => {
      controller.abort();
      clearTimeout(timer.current);
      current.terminate();
      worker.current = null;
    };
    // Every viewer is keyed by its file/revision; the initial input owns this worker.
  }, [src]);
  return { result, error, send };
}
