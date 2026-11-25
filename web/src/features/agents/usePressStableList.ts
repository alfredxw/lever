import { useLayoutEffect, useState, type PointerEvent as ReactPointerEvent } from "react";

export function usePressStableList<T>(latest: T) {
  const [press, setPress] = useState<{ items: T; pointerId: number }>();
  const items = press?.items ?? latest;

  useLayoutEffect(() => {
    if (!press) return;
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    let frame = 0;
    const release = () => setPress(undefined);
    const afterPointer = (event: PointerEvent) => {
      if (event.pointerId === press.pointerId)
        frame = requestAnimationFrame(release);
    };
    window.addEventListener("pointerup", afterPointer, options);
    window.addEventListener("pointercancel", afterPointer, options);
    window.addEventListener("blur", release, { signal: controller.signal });
    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
    };
  }, [press]);

  function onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
    if (event.button === 0 && event.isPrimary && event.target instanceof Element &&
        event.target.closest("button[data-session-id]"))
      setPress({ items, pointerId: event.pointerId });
  }

  return [items, onPointerDownCapture] as const;
}
