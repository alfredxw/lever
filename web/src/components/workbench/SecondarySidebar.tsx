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
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/features/settings/Preferences";

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

function readSidebarSize(element: HTMLElement): SidebarSize {
  const style = getComputedStyle(element);
  return {
    width: element.offsetWidth,
    min: Math.round(Number.parseFloat(style.minWidth)),
    max: Math.round(Number.parseFloat(style.maxWidth)),
  };
}

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
      const next = readSidebarSize(element);
      if (!next.width) {
        finishResize();
        return;
      }
      setSize((previous) =>
        previous?.width === next.width &&
        previous.min === next.min &&
        previous.max === next.max
          ? previous
          : next,
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

  const widthAtPointer = (
    event: PointerEvent<HTMLDivElement>,
    bounds = size,
  ) => {
    const drag = gesture.current;
    if (drag?.pointerId !== event.pointerId || !bounds) return;
    return clampWidth(drag.startWidth + event.clientX - drag.startX, bounds);
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
      <aside
        id={id}
        className="secondary-sidebar"
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
              if (!content.current) return;
              const next = widthAtPointer(
                event,
                readSidebarSize(content.current),
              );
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
              if (!content.current || gesture.current) return;
              const bounds = readSidebarSize(content.current);
              const { width } = bounds;
              let next = width;
              if (event.key === "ArrowLeft") next -= 8;
              else if (event.key === "ArrowRight") next += 8;
              else if (event.key === "Home") next = bounds.min;
              else if (event.key === "End") next = bounds.max;
              else return;
              event.preventDefault();
              next = clampWidth(next, bounds);
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
      </aside>
    </>
  );
}
