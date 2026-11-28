import { useCallback, type PointerEvent } from "react";
import {
  infiniteQueryOptions,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type {
  ChatDelegations,
  ChatTopicsPage,
  ChatView,
  ComparisonResult,
  Overview,
  SessionRuns,
  SessionView,
} from "@/api/types.gen";
import type { WorkspaceTab } from "@/components/workbench/useWorkspaces";

const initialHistoryPageSize = 12;
const historyPageSize = 40;

export function useChatActivity(chatId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview?scope=local"),
    enabled,
    subscribed: enabled,
    select: useCallback(
      (overview: Overview) => ({
        agents: overview.agents,
        runs: overview.runs.filter((run) => run.chatId === chatId),
        // Comparison Topics can belong to other Chats. Each reply selects its own run's requests.
        requests: overview.requests,
      }),
      [chatId],
    ),
  });
}

export function chatDelegationsQuery(chatId: string) {
  return queryOptions({
    queryKey: ["delegations", chatId],
    queryFn: ({ signal }) =>
      api<ChatDelegations>(
        `/chats/${chatId}/delegations`,
        undefined,
        "GET",
        signal,
      ),
  });
}

export function comparisonQuery(id: string) {
  return queryOptions({
    queryKey: ["comparison", id],
    queryFn: ({ signal }) =>
      api<ComparisonResult[]>(
        `/comparisons/${id}?toolOutput=lazy`,
        undefined,
        "GET",
        signal,
      ),
  });
}

export function chatQuery(chatId: string) {
  return infiniteQueryOptions({
    queryKey: ["chat", chatId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<ChatView>(
        `/chats/${chatId}?before=${pageParam}&limit=${pageParam ? historyPageSize : initialHistoryPageSize}&toolOutput=lazy`,
        undefined,
        "GET",
        signal,
      ),
    getNextPageParam: (page) =>
      page.hasMore ? page.entries[0]?.sequence : undefined,
  });
}

export function chatTopicPagesQuery(chatId: string) {
  return infiniteQueryOptions({
    queryKey: ["chat", chatId, "topics", "pages"],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<ChatTopicsPage>(
        `/chats/${chatId}/topics/page?limit=12&before=${pageParam}`,
        undefined,
        "GET",
        signal,
      ),
    getNextPageParam: (page) => page.nextBefore,
  });
}

export function sessionQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId, "info"],
    queryFn: ({ signal }) =>
      api<SessionView>(
        `/sessions/${sessionId}?toolOutput=lazy`,
        undefined,
        "GET",
        signal,
      ),
  });
}

export function sessionRunsQuery(
  sessionId: string,
  firstPageSize = historyPageSize,
) {
  return infiniteQueryOptions({
    queryKey: ["session", sessionId, "runs", firstPageSize],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<SessionRuns>(
        `/sessions/${sessionId}/runs?before=${pageParam}&limit=${pageParam ? historyPageSize : firstPageSize}&toolOutput=lazy`,
        undefined,
        "GET",
        signal,
      ),
    getNextPageParam: (page) => page.nextBefore,
  });
}

export const topicHistoryQuery = (id: string) =>
  sessionRunsQuery(id, initialHistoryPageSize);

export function topicPreviewQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId, "preview"],
    queryFn: ({ signal }) =>
      api<SessionRuns>(
        `/sessions/${sessionId}/runs?before=0&limit=3&toolOutput=lazy`,
        undefined,
        "GET",
        signal,
      ),
  });
}

export function prefetchConversation(tab: WorkspaceTab) {
  if (tab.kind === "chat") {
    prefetchChat(tab.id);
    if (tab.expandedTopicId) prefetchTopic(tab.expandedTopicId);
  } else if (tab.kind === "topic") {
    prefetchTopic(tab.topic.sessionId);
  }
}

function prefetchChat(chatId: string) {
  const query = chatQuery(chatId);
  if (!queryClient.getQueryData(query.queryKey))
    void queryClient.prefetchInfiniteQuery(query);
}

export function prefetchTopic(sessionId: string) {
  const info = sessionQuery(sessionId);
  if (!queryClient.getQueryData(info.queryKey))
    void queryClient.prefetchQuery(info);
  const query = topicHistoryQuery(sessionId);
  if (!queryClient.getQueryData(query.queryKey))
    void queryClient.prefetchInfiniteQuery(query);
}

export function conversationIntent(chatId: string, topicId?: string) {
  const prefetch = () =>
    topicId ? prefetchTopic(topicId) : prefetchChat(chatId);
  return {
    onFocus: prefetch,
    onPointerEnter(event: PointerEvent<HTMLElement>) {
      if (event.pointerType === "touch") return;
      const row = event.currentTarget;
      // Skimming many rows should only warm the one the pointer settles on.
      window.setTimeout(() => {
        if (row.matches(":hover")) prefetch();
      }, 100);
    },
  };
}
