import { Browser, type BrowserViewport } from "@/api/desktop.gen";

const hidden: BrowserViewport = { x: 0, y: 0, width: 0, height: 0 };
const overlay =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-slot="dialog-overlay"],[data-slot="sheet-overlay"],[data-sonner-toast],.browser-float';
const placements = new Map<string, { next: BrowserViewport }>();

function place(id: string, box: BrowserViewport) {
  const current = placements.get(id);
  if (current) {
    current.next = box;
    return;
  }
  const entry = { next: box };
  placements.set(id, entry);
  void (async () => {
    try {
      for (;;) {
        const next = entry.next;
        await Browser.place(id, next);
        if (next === entry.next) break;
      }
    } catch (error) {
      console.error("Browser placement failed", error);
    } finally {
      placements.delete(id);
    }
  })();
}

export function trackBrowserSurface(
  id: string,
  slot: HTMLElement,
  size?: number[],
) {
  let frame = 0;
  let previous = "";
  const measure = () => {
    frame = 0;
    const rect = slot.getBoundingClientRect();
    const covered = [...document.querySelectorAll(overlay)].some((element) => {
      if (
        element.contains(slot) ||
        element.matches('[data-state="closed"],[data-removed="true"]')
      )
        return false;
      const other = element.getBoundingClientRect();
      return (
        other.width > 0 &&
        other.height > 0 &&
        rect.left < other.right &&
        rect.right > other.left &&
        rect.top < other.bottom &&
        rect.bottom > other.top
      );
    });
    const scale = size
      ? Math.min(1, rect.width / size[0], rect.height / size[1])
      : 1;
    const width = size ? size[0] * scale : rect.width;
    const height = size ? size[1] * scale : rect.height;
    const box =
      !covered && rect.width && rect.height
        ? {
            x: Math.round(rect.left + (rect.width - width) / 2),
            y: Math.round(rect.top),
            width: Math.round(width),
            height: Math.round(height),
            scale,
          }
        : hidden;
    const key = JSON.stringify(box);
    if (key !== previous) {
      previous = key;
      place(id, box);
    }
  };
  const schedule = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      measure();
    } else if (!frame) frame = requestAnimationFrame(measure);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(slot);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "hidden", "data-state", "class", "inert"],
  });
  document.addEventListener("visibilitychange", schedule);
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  measure();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    document.removeEventListener("visibilitychange", schedule);
    window.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    place(id, hidden);
  };
}
