import * as React from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MessagePositions = Map<
  string,
  { item: VirtualItem; offset: number }
>;

type ScrollControls = {
  scrollToEnd: () => void;
  scrollToMessage: (id: string) => boolean;
};

const estimatedHeight = 260;
const rowGap = 24;
const paddingStart = 32;

type History = {
  active?: boolean;
  historyId?: string;
  positions?: MessagePositions;
};
const HistoryContext = React.createContext<
  | (History & {
      controls: React.RefObject<ScrollControls | null>;
    })
  | null
>(null);

export function MessageScrollerProvider({
  active = true,
  historyId,
  positions,
  children,
}: React.PropsWithChildren<History>) {
  const controls = React.useRef<ScrollControls>(null);
  const value = React.useMemo(
    () => ({ active, historyId, positions, controls }),
    [active, historyId, positions],
  );
  return (
    <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>
  );
}

export function useMessageScroller() {
  return React.useContext(HistoryContext)!.controls;
}

const RowContext = React.createContext<{
  id: string;
  index: number;
  measure: (node: HTMLDivElement | null) => void;
} | null>(null);

export function MessageScrollerItem({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { id, index, measure } = React.useContext(RowContext)!;
  return (
    <div
      {...props}
      ref={measure}
      data-index={index}
      data-message-id={id}
      className={cn("min-w-0", className)}
    />
  );
}

export function MessageTimeline<Item>({
  items,
  itemKey,
  children,
  onLoadEarlier,
  empty,
  notice,
  overlay,
  busy,
  inert,
  className,
}: {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  children: (item: Item, index: number) => React.ReactNode;
  onLoadEarlier?: () => void;
  empty?: React.ReactNode;
  notice?: React.ReactNode;
  overlay?: React.ReactNode;
  busy?: boolean;
  inert?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { active, historyId, positions, controls } =
    React.useContext(HistoryContext)!;
  const viewport = React.useRef<HTMLDivElement>(null);
  const [initial] = React.useState(() =>
    historyId ? positions?.get(historyId) : undefined,
  );
  const [atEnd, setAtEnd] = React.useState(!initial);
  const requestedAtStart = React.useRef(false);
  const getItemKey = React.useCallback(
    (index: number) => itemKey(items[index]),
    [items, itemKey],
  );
  const list = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getItemKey,
    getScrollElement: () => (active ? viewport.current : null),
    estimateSize: () => estimatedHeight,
    paddingStart,
    paddingEnd: 24,
    gap: rowGap,
    overscan: 2,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 2,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    initialOffset: () =>
      initial
        ? Math.max(
            0,
            paddingStart +
              initial.item.index * (estimatedHeight + rowGap) +
              initial.offset,
          )
        : Math.max(
            0,
            items.length * (estimatedHeight + rowGap) -
              (viewport.current?.clientHeight ?? 0),
          ),
    initialMeasurementsCache: initial && [initial.item],
    onChange: (instance) => {
      if (active && instance.scrollElement?.clientHeight)
        setAtEnd(instance.isAtEnd());
    },
  });
  const itemIndex = (id: string) =>
    items.findIndex((item) => itemKey(item) === id);
  React.useImperativeHandle(controls, () => ({
    scrollToEnd: list.scrollToEnd,
    scrollToMessage: (id) => {
      const index = itemIndex(id);
      if (index < 0) return false;
      list.scrollToIndex(index, { align: "center", behavior: "instant" });
      return true;
    },
  }));

  React.useLayoutEffect(() => {
    if (!active) return;
    const saved = historyId ? positions?.get(historyId) : undefined;
    const anchor =
      saved &&
      list.measurementsCache.find((item) => item.key === saved.item.key);
    if (saved && anchor) list.scrollToOffset(anchor.start + saved.offset);
    else list.scrollToEnd();
  }, [active, historyId, positions, list]);

  const totalSize = list.getTotalSize();
  const rows = list.getVirtualItems();
  const nearStart = rows[0]?.index === 0;
  React.useEffect(() => {
    const node = viewport.current;
    if (!active || inert || !node?.clientHeight || !items.length) return;
    if (!nearStart) requestedAtStart.current = false;
    else if (
      onLoadEarlier &&
      (totalSize <= node.clientHeight || (!atEnd && !requestedAtStart.current))
    ) {
      requestedAtStart.current = true;
      onLoadEarlier();
    }
  }, [active, inert, nearStart, atEnd, totalSize, items.length, onLoadEarlier]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        ref={viewport}
        className="chat-scroll scroll-fade-b scrollbar-thin scrollbar-gutter-stable overscroll-contain"
        role="region"
        aria-label={t("chat.conversation")}
        tabIndex={0}
        inert={inert}
        onScroll={({ currentTarget: element }) => {
          if (!active || !element.clientHeight) return;
          const top = element.scrollTop;
          const end = element.scrollHeight - element.clientHeight - top <= 2;
          setAtEnd(end);
          if (!historyId || !positions) return;
          const item = list.getVirtualItemForOffset(top);
          if (end) positions.delete(historyId);
          else if (item)
            positions.set(historyId, { item, offset: top - item.start });
        }}
      >
        <div
          ref={list.containerRef}
          role="log"
          aria-relevant="additions text"
          aria-busy={busy}
          className={cn(
            "conversation relative flex min-h-full flex-col",
            !items.length && "px-[var(--conversation-gutter)] py-8",
            className,
          )}
        >
          {rows.map((row) => (
            <RowContext.Provider
              key={row.key}
              value={{
                id: String(row.key),
                index: row.index,
                measure: list.measureElement,
              }}
            >
              {children(items[row.index], row.index)}
            </RowContext.Provider>
          ))}
          {!items.length && empty}
        </div>
      </div>
      {notice && !inert && (
        <div className="absolute inset-x-0 top-0 z-10 mx-auto w-fit max-w-full bg-background">
          {notice}
        </div>
      )}
      {!atEnd && !inert && (
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background"
          aria-label={t("chat.latest")}
          title={t("chat.latest")}
          onClick={() => list.scrollToEnd({ behavior: "instant" })}
        >
          <ArrowDown />
        </Button>
      )}
      {overlay}
    </div>
  );
}
