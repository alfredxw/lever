import "./ImageViewer.css";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X, ZoomIn, ZoomOut } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { Button } from "@/components/ui/button";
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = Math.log(1.25);
export function ImageViewer({
  src,
  name,
  onClose,
  label,
  maxZoom = MAX_ZOOM,
}: {
  src: string;
  name: string;
  onClose?: () => void;
  label?: string;
  maxZoom?: number;
}) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const transform = useRef<ReactZoomPanPinchRef>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [failedSrc, setFailedSrc] = useState<string>();
  const unavailable = failedSrc === src;

  useEffect(() => {
    if (unavailable) return;
    const element = viewport.current!;
    function wheel(event: WheelEvent) {
      const view = transform.current;
      const content = view?.instance.contentComponent;
      if (!view || !content) return;
      event.preventDefault();
      event.stopPropagation();
      const { scale, positionX, positionY } = view.state;
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1);
      // Keep exponential zoom reversible and anchored to the pointer.
      const next = clamp(scale * Math.exp(-delta * 0.004), MIN_ZOOM, maxZoom);
      const rect = content.getBoundingClientRect();
      view.setTransform(
        positionX - ((event.clientX - rect.left) / scale) * (next - scale),
        positionY - ((event.clientY - rect.top) / scale) * (next - scale),
        next,
        0,
      );
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [unavailable, maxZoom]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      unavailable ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const view = transform.current;
    if (!view) return;
    const { positionX, positionY, scale } = view.state;
    const bounds = view.instance.bounds;
    switch (event.key) {
      case "+":
      case "=":
        view.zoomIn(ZOOM_STEP, 0);
        break;
      case "-":
        view.zoomOut(ZOOM_STEP, 0);
        break;
      case "0":
        view.resetTransform(0);
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        if (!bounds) return;
        view.setTransform(
          clamp(
            positionX +
              (event.key === "ArrowLeft"
                ? 80
                : event.key === "ArrowRight"
                  ? -80
                  : 0),
            bounds.minPositionX,
            bounds.maxPositionX,
          ),
          clamp(
            positionY +
              (event.key === "ArrowUp"
                ? 80
                : event.key === "ArrowDown"
                  ? -80
                  : 0),
            bounds.minPositionY,
            bounds.maxPositionY,
          ),
          scale,
          0,
        );
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <section
      className="attachment-preview"
      aria-label={label || t("attachments.preview")}
      onKeyDown={onKeyDown}
    >
      <TransformWrapper
        ref={transform}
        minScale={MIN_ZOOM}
        maxScale={maxZoom}
        centerOnInit
        centerZoomedOut
        wheel={{ disabled: true }}
        pinch={{ allowPanning: true }}
        panning={{
          allowLeftClickPan: true,
          allowMiddleClickPan: false,
          allowRightClickPan: false,
        }}
        doubleClick={{ mode: "toggle", step: Math.log(2), animationTime: 0 }}
        zoomAnimation={{ disabled: true }}
        velocityAnimation={{ disabled: !!reduceMotion }}
        onTransform={(_, state) => setZoom(Math.round(state.scale * 100) / 100)}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <div className="attachment-preview-toolbar">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={unavailable || zoom <= MIN_ZOOM}
                aria-label={t("attachments.zoomOut")}
                title={t("attachments.zoomOut")}
                onClick={() => zoomOut(ZOOM_STEP, 0)}
              >
                <ZoomOut />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="attachment-preview-zoom"
                disabled={unavailable}
                aria-label={t("attachments.resetZoom")}
                title={t("attachments.resetZoom")}
                onClick={() => resetTransform(0)}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={unavailable || zoom >= maxZoom}
                aria-label={t("attachments.zoomIn")}
                title={t("attachments.zoomIn")}
                onClick={() => zoomIn(ZOOM_STEP, 0)}
              >
                <ZoomIn />
              </Button>
              {onClose && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("common.close")}
                  title={t("common.close")}
                  onClick={onClose}
                >
                  <X />
                </Button>
              )}
            </div>
            <div
              ref={viewport}
              className="attachment-preview-viewport"
              data-unavailable={unavailable || undefined}
              tabIndex={unavailable ? undefined : 0}
              role="region"
              aria-label={t("attachments.viewerControls")}
              onPointerDownCapture={(event) =>
                event.currentTarget.focus({ preventScroll: true })
              }
            >
              {unavailable ? (
                <p
                  role="status"
                  className="rounded-md bg-popover px-3 py-2 text-sm text-popover-foreground"
                >
                  {t("chat.imageUnavailable")}
                </p>
              ) : (
                <TransformComponent
                  wrapperStyle={{ width: "100%", height: "100%" }}
                  contentStyle={{
                    width: "100%",
                    height: "100%",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <img
                    src={src}
                    alt={name}
                    draggable={false}
                    referrerPolicy="no-referrer"
                    onError={() => setFailedSrc(src)}
                  />
                </TransformComponent>
              )}
            </div>
          </>
        )}
      </TransformWrapper>
    </section>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
