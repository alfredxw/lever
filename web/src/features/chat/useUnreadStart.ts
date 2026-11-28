import { useLayoutEffect, useRef } from "react";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import type { Run } from "@/api/types.gen";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { pickFirstUnreadRun } from "./unreadStart";

const maxUnreadPages = 5;

type PendingUnread = {
  readCursor: number;
  unreadSequence: number;
  pagesFetched: number;
  scrolledId?: string;
};

export function useUnreadStart({
  active,
  ready,
  suppressed,
  readCursor,
  unreadSequence,
  latestCursor,
  oldestPagedRunId,
  runs,
  view,
}: {
  active: boolean;
  ready: boolean;
  suppressed: boolean;
  readCursor: number;
  unreadSequence: number;
  latestCursor: number | undefined;
  oldestPagedRunId?: string;
  runs: readonly Run[];
  view: UseInfiniteQueryResult;
}) {
  const scroller = useMessageScroller();
  const wasActive = useRef(false);
  const pendingRef = useRef<PendingUnread | null>(null);
  const {
    data,
    error,
    isFetching,
    isStale,
    hasNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = view;

  useLayoutEffect(() => {
    if (!active) {
      wasActive.current = false;
      pendingRef.current = null;
      return;
    }
    if (!wasActive.current) {
      wasActive.current = true;
      pendingRef.current =
        !suppressed && unreadSequence > readCursor
          ? { readCursor, unreadSequence, pagesFetched: 0 }
          : null;
    }
    if (suppressed) {
      pendingRef.current = null;
      return;
    }
    const pending = pendingRef.current;
    if (!pending || !ready || !data || latestCursor === undefined) return;

    const { run: target, matched } = pickFirstUnreadRun(
      runs,
      pending.readCursor,
    );
    const stale =
      latestCursor < pending.unreadSequence &&
      (isFetching || isStale) &&
      !error;
    if (stale) {
      // Pre-align when SSE already updated the run in cache so retained tabs do
      // not flash the bottom while the page cursor refreshes.
      if (
        matched &&
        target &&
        pending.scrolledId !== target.id &&
        scroller.current?.scrollToMessage(target.id, "start")
      ) {
        pending.scrolledId = target.id;
      }
      return;
    }

    const needsEarlierPage =
      pending.readCursor > 0 &&
      hasNextPage &&
      pending.pagesFetched < maxUnreadPages &&
      !isFetchNextPageError &&
      ((matched && target?.id === (oldestPagedRunId ?? runs[0]?.id)) ||
        runs.length === 0);
    if (needsEarlierPage) {
      if (!isFetching) {
        pending.pagesFetched += 1;
        void fetchNextPage({ cancelRefetch: false });
      }
      return;
    }

    if (!target) {
      pendingRef.current = null;
      return;
    }
    if (!scroller.current) return;
    if (
      pending.scrolledId === target.id ||
      scroller.current.scrollToMessage(target.id, "start")
    ) {
      pendingRef.current = null;
    }
  }, [
    active,
    ready,
    suppressed,
    readCursor,
    unreadSequence,
    latestCursor,
    oldestPagedRunId,
    runs,
    data,
    error,
    isFetching,
    isStale,
    hasNextPage,
    isFetchNextPageError,
    fetchNextPage,
    scroller,
  ]);
}
