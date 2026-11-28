import { useCallback } from "react";
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

const initialChatPageSize = 12;

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
      api<ComparisonResult[]>(`/comparisons/${id}`, undefined, "GET", signal),
  });
}

export function chatQuery(chatId: string) {
  return infiniteQueryOptions({
    queryKey: ["chat", chatId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<ChatView>(
        `/chats/${chatId}?before=${pageParam}${pageParam === 0 ? `&limit=${initialChatPageSize}` : ""}`,
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
      api<SessionView>(`/sessions/${sessionId}`, undefined, "GET", signal),
  });
}

export function sessionRunsQuery(sessionId: string) {
  return infiniteQueryOptions({
    queryKey: ["session", sessionId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<SessionRuns>(
        `/sessions/${sessionId}/runs?before=${pageParam}`,
        undefined,
        "GET",
        signal,
      ),
    getNextPageParam: (page) =>
      page.runs.length === 40 ? page.runs.at(-1)?.sequence : undefined,
  });
}

export function topicPreviewQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId, "preview"],
    queryFn: ({ signal }) =>
      api<SessionRuns>(
        `/sessions/${sessionId}/runs?before=0&limit=3`,
        undefined,
        "GET",
        signal,
      ),
  });
}

export function prefetchConversation(tab: WorkspaceTab) {
  if (tab.kind === "chat") {
    const query = chatQuery(tab.id);
    if (!queryClient.getQueryData(query.queryKey))
      void queryClient.prefetchInfiniteQuery(query);
  } else if (tab.kind === "topic") {
    const info = sessionQuery(tab.topic.sessionId);
    if (!queryClient.getQueryData(info.queryKey))
      void queryClient.prefetchQuery(info);
    prefetchTopicHistory(tab.topic.sessionId);
  }
}

export function prefetchTopicHistory(sessionId: string) {
  const query = sessionRunsQuery(sessionId);
  if (!queryClient.getQueryData(query.queryKey))
    void queryClient.prefetchInfiniteQuery(query);
}
