import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HtmlPreview } from "./chatFileLinks";
import { HtmlPreviewPanel } from "./HtmlPreview";

const InlinePreviewContext = createContext<{
  id: string;
  src?: string;
  toggle: (preview: HtmlPreview, trigger: HTMLElement) => void;
} | null>(null);

export function useInlineHtmlPreview() {
  return useContext(InlinePreviewContext);
}

export function InlineHtmlPreview({
  children,
  after,
  defaultPreview,
}: {
  children: ReactNode;
  after?: ReactNode;
  defaultPreview?: HtmlPreview;
}) {
  const id = useId();
  const [selection, setSelection] = useState<HtmlPreview | null>();
  const active = selection === undefined ? defaultPreview : selection;
  const src = active?.src;
  const lastTrigger = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const shouldReveal = useRef(false);
  const toggle = useCallback(
    (preview: HtmlPreview, trigger: HTMLElement) => {
      lastTrigger.current = trigger;
      const opening = preview.src !== src;
      shouldReveal.current = opening;
      setSelection(opening ? preview : null);
    },
    [src],
  );
  useLayoutEffect(() => {
    if (!shouldReveal.current || !src) return;
    shouldReveal.current = false;
    panel.current?.scrollIntoView({ block: "nearest" });
  }, [src]);
  const value = useMemo(() => ({ id, src, toggle }), [id, src, toggle]);
  return (
    <>
      <InlinePreviewContext.Provider value={value}>
        {children}
        {active && (
          <div
            ref={panel}
            id={id}
            className="chat-inline-html-preview my-2 h-[min(26rem,55dvh)] w-full min-w-0 overflow-hidden rounded-md border bg-background font-normal not-italic text-foreground"
          >
            <HtmlPreviewPanel
              preview={active}
              onCollapse={() => {
                const trigger =
                  lastTrigger.current ??
                  document.querySelector<HTMLElement>(`[aria-controls="${id}"]`);
                setSelection(null);
                trigger?.focus({ preventScroll: true });
              }}
            />
          </div>
        )}
      </InlinePreviewContext.Provider>
      {after}
    </>
  );
}
