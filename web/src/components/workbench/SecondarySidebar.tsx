import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motion } from "motion/react";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/features/settings/Preferences";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

const narrow = window.matchMedia("(max-width: 760px)");
const subscribe = (notify: () => void) => {
  narrow.addEventListener("change", notify);
  return () => narrow.removeEventListener("change", notify);
};

export function useSecondarySidebarState() {
  const compact = useSyncExternalStore(subscribe, () => narrow.matches);
  const [sidebar, setSidebar] = useState(() => !compact);
  return { compact, sidebar, setSidebar };
}

type SidebarSize = { width: number; min: number; max: number };
type ResizeGesture = {
  handle: HTMLDivElement;
  pointerId: number;
  startX: number;
  startWidth: number;
};

function clampWidth(width: number, { min, max }: SidebarSize) {
  return Math.max(min, Math.min(max, Math.round(width)));
}

export function SecondarySidebar({
  id,
  open,
  onOpenChange,
  label,
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { updatePreferences } = usePreferences();
  const reduceMotion = usePrefersReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const gesture = useRef<ResizeGesture>(null);
  const [size, setSize] = useState<SidebarSize>();
  const [previewWidth, setPreviewWidth] = useState<number>();
  const resizing = previewWidth !== undefined;

  const finishResize = useCallback(() => {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = null;
    if (drag.handle.hasPointerCapture(drag.pointerId))
      drag.handle.releasePointerCapture(drag.pointerId);
    setPreviewWidth(undefined);
  }, []);

  useLayoutEffect(() => {
    const element = content.current;
    if (!open || !element) {
      finishResize();
      return;
    }
    const measure = () => {
      const width = element.offsetWidth;
      if (width === 0) {
        finishResize();
        return;
      }
      const style = getComputedStyle(element);
      const min = Math.round(Number.parseFloat(style.minWidth));
      const max = Math.round(Number.parseFloat(style.maxWidth));
      setSize((previous) =>
        previous?.width === width &&
        previous.min === min &&
        previous.max === max
          ? previous
          : { width, min, max },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const frame = element.closest(".workspace-frame");
    if (frame) observer.observe(frame);
    return () => observer.disconnect();
  }, [open, finishResize]);

  useEffect(() => {
    if (!resizing) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gesture.current) return;
      event.preventDefault();
      finishResize();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", finishResize);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", finishResize);
    };
  }, [resizing, finishResize]);

  const saveWidth = (width: number | null) =>
    updatePreferences({ secondarySidebarWidth: width });

  const widthAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    if (drag?.pointerId !== event.pointerId || !size) return;
    return clampWidth(drag.startWidth + event.clientX - drag.startX, size);
  };

  return (
    <>
      <Button
        className="sidebar-toggle"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
      >
        <PanelLeft />
      </Button>
      <motion.aside
        id={id}
        className="secondary-sidebar"
        initial={false}
        animate={{ width: open ? "auto" : 0 }}
        transition={{
          duration: reduceMotion ? 0 : 0.24,
          ease: [0.22, 1, 0.36, 1],
        }}
        inert={!open}
        aria-hidden={!open}
      >
        {open && (
          <div
            className="secondary-sidebar-resize"
            role="separator"
            tabIndex={0}
            aria-label={t("nav.resizeSidebar")}
            aria-controls={id}
            aria-orientation="vertical"
            aria-valuemin={size?.min}
            aria-valuemax={size?.max}
            aria-valuenow={size?.width}
            data-resizing={resizing ? "" : undefined}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                !event.isPrimary ||
                gesture.current ||
                !size
              )
                return;
              event.preventDefault();
              const { currentTarget: handle, pointerId, clientX } = event;
              const startWidth = content.current?.offsetWidth ?? size.width;
              handle.setPointerCapture(pointerId);
              gesture.current = {
                handle,
                pointerId,
                startX: clientX,
                startWidth,
              };
              setPreviewWidth(startWidth);
            }}
            onPointerMove={(event) => {
              const next = widthAtPointer(event);
              if (next !== undefined) setPreviewWidth(next);
            }}
            onPointerUp={(event) => {
              const next = widthAtPointer(event);
              if (next === undefined) return;
              const start = gesture.current?.startWidth;
              finishResize();
              if (next !== start) saveWidth(next);
            }}
            onPointerCancel={(event) => {
              if (gesture.current?.pointerId === event.pointerId)
                finishResize();
            }}
            onLostPointerCapture={(event) => {
              if (gesture.current?.pointerId === event.pointerId)
                finishResize();
            }}
            onDoubleClick={() => saveWidth(null)}
            onKeyDown={(event) => {
              if (!size || gesture.current) return;
              const width = content.current?.offsetWidth ?? size.width;
              let next = width;
              if (event.key === "ArrowLeft") next -= 8;
              else if (event.key === "ArrowRight") next += 8;
              else if (event.key === "Home") next = size.min;
              else if (event.key === "End") next = size.max;
              else return;
              event.preventDefault();
              next = clampWidth(next, size);
              if (next !== width) saveWidth(next);
            }}
          />
        )}
        <div className="secondary-sidebar-clip">
          <div
            ref={content}
            className="secondary-sidebar-content"
            style={{ width: previewWidth }}
          >
            {children}
          </div>
        </div>
      </motion.aside>
    </>
  );
}
