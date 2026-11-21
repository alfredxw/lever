import { useEffect, type RefObject } from "react";

export function useFocusComposer(
  panel: RefObject<HTMLElement | null>,
  focus: boolean,
  onFocused: () => void,
) {
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const composer =
        panel.current?.querySelector<HTMLElement>(".prompt-editor");
      if (composer) {
        composer.focus({ preventScroll: true });
        onFocused();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [panel, focus, onFocused]);
}
