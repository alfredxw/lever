import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

function conversationButton(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLButtonElement>(
        "button[data-session-id], button[data-draft-key]",
      )
    : null;
}

export function PressStableList({ children }: { children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const lastMouseRelease = useRef<{
    pointerId: number;
    timeStamp: number;
    button: HTMLButtonElement | null;
  }>(undefined);
  const [press, setPress] = useState<{ rows: ReactNode; pointerId: number }>();
  const rows = press ? press.rows : children;

  useLayoutEffect(() => {
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    let frame = 0;
    const afterPointer = (event: PointerEvent) => {
      if (event.isPrimary && event.pointerType === "mouse") {
        const button = conversationButton(event.target);
        lastMouseRelease.current = {
          pointerId: event.pointerId,
          timeStamp: event.timeStamp,
          button:
            event.type === "pointerup" &&
            event.button === 0 &&
            !event.ctrlKey &&
            list.current?.contains(button)
              ? button
              : null,
        };
      }
      if (event.pointerId === press?.pointerId)
        frame = requestAnimationFrame(() => setPress(undefined));
    };
    window.addEventListener("pointerup", afterPointer, options);
    window.addEventListener("pointercancel", afterPointer, options);
    window.addEventListener(
      "blur",
      () => {
        lastMouseRelease.current = undefined;
        setPress(undefined);
      },
      { signal: controller.signal },
    );
    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
    };
  }, [press]);

  function onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
    const button = conversationButton(event.target);
    if (!button) return;
    if (event.pointerType === "mouse") {
      const up = lastMouseRelease.current;
      lastMouseRelease.current = undefined;
      // macOS WebKit can dispatch mouseup before the older mousedown, without
      // a click. Native timestamps still pair the two ends of that gesture.
      if (
        up?.pointerId === event.pointerId &&
        event.timeStamp <= up.timeStamp
      ) {
        if (up.button === button) button.click();
        return;
      }
    }
    setPress({ rows, pointerId: event.pointerId });
  }

  return (
    <div
      ref={list}
      onPointerDownCapture={onPointerDownCapture}
      onClick={(event) => {
        // WebKit may already have delivered the click with the early release.
        const up = lastMouseRelease.current;
        if (up && up.button === conversationButton(event.target))
          up.button = null;
        if (press) setPress(undefined);
      }}
    >
      {rows}
    </div>
  );
}
