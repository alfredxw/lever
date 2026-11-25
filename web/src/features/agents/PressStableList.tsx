import {
  useLayoutEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export function PressStableList({ children }: { children: ReactNode }) {
  const [press, setPress] = useState<{ rows: ReactNode; pointerId: number }>();
  const rows = press ? press.rows : children;

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
    if (
      event.button === 0 &&
      !event.ctrlKey &&
      event.isPrimary &&
      event.target instanceof Element &&
      event.target.closest("button[data-session-id]")
    )
      setPress({ rows, pointerId: event.pointerId });
  }

  return (
    <div
      onPointerDownCapture={onPointerDownCapture}
      onClick={press ? () => setPress(undefined) : undefined}
    >
      {rows}
    </div>
  );
}
