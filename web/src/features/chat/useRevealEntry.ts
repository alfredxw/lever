import { useEffect, type RefObject } from "react";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import {
  type ScrollAlign,
  useMessageScroller,
} from "@/components/ui/message-scroller";

export function useRevealEntry(
  panel: RefObject<HTMLElement | null>,
  messageId: string | undefined,
  visible: boolean,
  view: UseInfiniteQueryResult,
  onRevealed: () => void,
  focusEntry: boolean | "expand" = true,
  requestKey?: number,
  align: ScrollAlign = "center",
) {
  const scroller = useMessageScroller();
  const { data, isFetching, hasNextPage, isFetchNextPageError, fetchNextPage } =
    view;

  useEffect(() => {
    if (!visible || !data || !scroller.current) return;
    const element = panel.current;
    if (
      element &&
      messageId &&
      scroller.current.scrollToMessage(messageId, align)
    ) {
      const selector = `[data-message-id="${CSS.escape(messageId)}"]`;
      const finish = () => {
        const entry = element.querySelector<HTMLElement>(selector);
        if (!entry) return false;
        if (focusEntry) {
          (
            entry.querySelector<HTMLElement>(
              focusEntry === "expand"
                ? ".topic-expand"
                : ".topic-open, .topic-reply-button",
            ) ?? entry
          ).focus({ preventScroll: true });
        }
        onRevealed();
        return true;
      };
      if (finish()) return;
      const observer = new MutationObserver(() => {
        if (finish()) observer.disconnect();
      });
      observer.observe(element, { childList: true, subtree: true });
      return () => observer.disconnect();
    } else if (hasNextPage && !isFetching && !isFetchNextPageError) {
      void fetchNextPage({ cancelRefetch: false });
    } else if (!hasNextPage && !isFetching) {
      onRevealed();
    }
  }, [
    data,
    fetchNextPage,
    focusEntry,
    hasNextPage,
    isFetching,
    isFetchNextPageError,
    onRevealed,
    panel,
    requestKey,
    align,
    scroller,
    messageId,
    visible,
  ]);
}
