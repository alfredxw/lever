import { type RefObject, useLayoutEffect, useState } from "react";

/** Files and Notes switch their directory and document into the same space below this width. */
export function useCompactPanel(panel: RefObject<HTMLElement | null>, maxWidth = 520) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => {
      const { width } = element.getBoundingClientRect();
      if (width > 0) setCompact(width <= maxWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [panel, maxWidth]);
  return compact;
}
