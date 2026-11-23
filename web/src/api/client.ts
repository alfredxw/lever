import {
  focusManager,
  QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  Automation,
  AutomationRun,
  ChatView,
  ComparisonResult,
  Event,
  Overview,
  Run,
  SessionRuns,
  TaskExecution,
} from "./types.gen";

// Native windows can regain focus without changing document visibility.
// Queries still opt into refresh through refetchOnWindowFocus.
focusManager.setEventListener((onFocus) => {
  if (typeof window === "undefined") return;
  const refresh = () => onFocus();
  window.addEventListener("focus", refresh);
  window.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    window.removeEventListener("visibilitychange", refresh);
  };
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

export function resetTaskNotes() {
  void queryClient.resetQueries({ queryKey: ["task-notes"] });
  void queryClient.resetQueries({ queryKey: ["task-note"] });
  void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
}

export class APIError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { credentials: "same-origin", signal }
      : {
          method,
          signal,
          credentials: "same-origin",
          headers:
            body instanceof FormData
              ? undefined
              : { "Content-Type": "application/json" },
          body: body instanceof FormData ? body : JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    let code: string | undefined;
    try {
      const failure = JSON.parse(text);
      message = failure.error ?? text;
      if (typeof failure.code === "string") code = failure.code;
    } catch {
      /* Plain HTTP errors are already readable. */
    }
    throw new APIError(message, response.status, code);
  }
  return response.json();
}

export async function pair() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    await api("/pair", { token });
    history.replaceState(null, "", location.pathname + location.search);
  }
}

export const active = (status: string) =>
  ["starting", "running", "waiting_user", "cancelling", "unknown"].includes(
    status,
  );

function updateHistoryRun<Page extends { runs: Run[] }>(
  history: InfiniteData<Page> | undefined,
  run: Run,
): InfiniteData<Page> | undefined {
  if (!history) return;
  let changed = false;
  const pages = history.pages.map((page) => {
    const index = page.runs.findIndex((item) => item.id === run.id);
    if (index < 0) return page;
    changed = true;
    const runs = page.runs.slice();
    runs[index] = run;
    return { ...page, runs };
  });
  // An event outside the loaded pages must not mark invalidated history fresh.
  return changed ? { ...history, pages } : undefined;
}

export function connectEvents(after: number, onEvent?: (event: Event) => void) {
  const stream = new EventSource(`/api/events?after=${after}`);
  stream.addEventListener("reset", () => {
    void queryClient.invalidateQueries();
  });
  stream.onmessage = ({ data }) => {
    const event = JSON.parse(data) as Event;
    onEvent?.(event);
    if (
      ["work-items", "external-tasks", "automation-runs"].includes(event.type)
    )
      void queryClient.invalidateQueries({ queryKey: ["board-references"] });
    if (
      event.type === "conversation-title" ||
      event.type === "session-runtime"
    ) {
      if (event.type === "conversation-title") {
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
        void queryClient.invalidateQueries({ queryKey: ["working-copies"] });
      }
      void queryClient.invalidateQueries({ queryKey: ["chat", event.chatId] });
      if (event.sessionId)
        void queryClient.invalidateQueries({
          queryKey: ["session", event.sessionId],
        });
      return;
    }
    if (event.type === "comparison" || event.type === "topic-created") {
      void queryClient.invalidateQueries({ queryKey: ["chat", event.chatId] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      return;
    }
    if (event.type === "channel-delivery") {
      void queryClient.invalidateQueries({ queryKey: ["chat", event.chatId] });
      if (event.sessionId)
        void queryClient.invalidateQueries({
          queryKey: ["session", event.sessionId],
        });
      return;
    }
    if (event.type === "delegations") {
      const queryKey = ["delegations", event.chatId];
      void queryClient.cancelQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey });
      return;
    }
    if (event.type === "task-views") {
      void queryClient.invalidateQueries({ queryKey: ["task-views"] });
      return;
    }
    if (event.type === "task-workflow") {
      void queryClient.invalidateQueries({ queryKey: ["task-workflows"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      return;
    }
    if (event.type === "task-deadlines" || event.type === "task-reminder") {
      void queryClient.invalidateQueries({ queryKey: ["task-deadlines"] });
      return;
    }
    if (event.type === "task-reminder-settings") {
      void queryClient.invalidateQueries({
        queryKey: ["task-reminder-settings"],
      });
      return;
    }
    if (event.type === "task-dispatch-settings") {
      void queryClient.invalidateQueries({
        queryKey: ["task-dispatch-settings"],
      });
      return;
    }
    if (event.type === "task-sources") {
      void queryClient.invalidateQueries({ queryKey: ["task-sources"] });
      return;
    }
    if (event.type === "automations" || event.type === "automation-runs") {
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      if (event.type === "automation-runs") {
        void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
        void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      }
      return;
    }
    if (event.type === "external-tasks") {
      void queryClient.invalidateQueries({ queryKey: ["external-tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      return;
    }
    if (event.type === "note-handover") {
      void queryClient.invalidateQueries({
        queryKey: ["note-handover", event.taskNoteId],
      });
      return;
    }
    if (event.type === "task-note") {
      void queryClient.invalidateQueries({
        queryKey: ["task-note", event.taskNoteId],
      });
      void queryClient.invalidateQueries({ queryKey: ["task-notes"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      return;
    }
    if (event.type === "task-notes-directory") {
      resetTaskNotes();
      void queryClient.invalidateQueries({
        queryKey: ["task-notes-directory"],
      });
      return;
    }
    if (event.type === "work-items") {
      void queryClient.invalidateQueries({ queryKey: ["work-items"] });
      void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      return;
    }
    if (event.type === "run" && event.run) {
      const run = event.run;
      if (run.automationId) {
        const runKey = ["run", run.id];
        if (queryClient.getQueryState(runKey)) {
          void queryClient.cancelQueries({ queryKey: runKey });
          queryClient.setQueryData(runKey, run);
        }
        const historyKey = ["automation-runs", run.automationId];
        const occurrence = queryClient
          .getQueryData<AutomationRun[]>(historyKey)
          ?.find(({ execution }) => execution?.runId === run.id);
        if (
          queryClient.getQueryState(historyKey) &&
          (occurrence?.status !== run.status || !!occurrence?.canPause !== !!run.canPause || !active(run.status))
        ) {
          void queryClient.invalidateQueries({ queryKey: historyKey });
        }
        const feedKey = ["automation-runs"];
        const feedItem = queryClient
          .getQueryData<AutomationRun[]>(feedKey)
          ?.find(({ execution }) => execution?.runId === run.id);
        if (
          queryClient.getQueryState(feedKey) &&
          (!feedItem || feedItem.status !== run.status || !!feedItem.canPause !== !!run.canPause || !active(run.status))
        ) {
          void queryClient.invalidateQueries({ queryKey: feedKey });
        }
        const summary = queryClient
          .getQueryData<Automation[]>(["automations"])
          ?.find(({ id }) => id === run.automationId)
          ?.recentRuns?.find(({ runId }) => runId === run.id);
        if (summary && summary.status !== run.status) {
          void queryClient.invalidateQueries({ queryKey: ["automations"] });
        }
      }
      if (run.comparisonId) {
        const queryKey = ["comparison", run.comparisonId];
        const results = queryClient.getQueryData<ComparisonResult[]>(queryKey);
        if (!results) {
          // A snapshot requested before the first event can still be in flight.
          void queryClient.cancelQueries({ queryKey });
          void queryClient.invalidateQueries({ queryKey });
        } else {
          void queryClient.cancelQueries({ queryKey });
          queryClient.setQueryData<ComparisonResult[]>(queryKey, (old) =>
            old?.map((item) =>
              item.session.id === run.sessionId &&
              run.sequence >= item.run.sequence
                ? { ...item, run }
                : item,
            ),
          );
        }
      }
      if (run.superseded) {
        void queryClient.invalidateQueries({ queryKey: ["message-search"] });
        for (const queryKey of [
          ["chat", run.chatId],
          ["session", run.sessionId],
        ]) {
          void queryClient.cancelQueries({ queryKey });
          void queryClient.invalidateQueries({ queryKey });
        }
        return;
      }
      const taskChanged = queryClient
        .getQueryData<TaskExecution[]>(["task-executions"])
        ?.some((item) =>
          item.automationId
            ? item.runId === run.id && item.status !== run.status
            : !run.automationId &&
              item.sessionId === run.sessionId &&
              (item.runId !== run.id || item.status !== run.status),
        );
      if (taskChanged && !["steering", "steered"].includes(run.status)) {
        void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      }
      // An older snapshot must not hide a pending request or a final outcome.
      const needsRefresh = !active(run.status) || run.status === "waiting_user";
      if (needsRefresh) {
        for (const queryKey of [
          ["overview"],
          ["chat", run.chatId],
          ["session", run.sessionId],
        ]) {
          void queryClient.cancelQueries({ queryKey });
        }
      }
      queryClient.setQueryData<Overview>(["overview"], (old) => {
        if (!old) return;
        const index = old.runs.findIndex((item) => item.id === run.id);
        if (!active(run.status) && !["queued", "paused"].includes(run.status)) {
          if (index < 0) return;
          return {
            ...old,
            runs: old.runs.filter((item) => item.id !== run.id),
          };
        }
        const runs = old.runs.slice();
        runs[index < 0 ? runs.length : index] = run;
        return { ...old, runs };
      });
      queryClient.setQueriesData<InfiniteData<ChatView>>(
        { queryKey: ["chat", run.chatId], exact: true },
        (old) => updateHistoryRun(old, run),
      );
      queryClient.setQueriesData<InfiniteData<SessionRuns>>(
        { queryKey: ["session", run.sessionId], exact: true },
        (old) => updateHistoryRun(old, run),
      );
      if (needsRefresh) {
        void queryClient.invalidateQueries({ queryKey: ["diff", run.agentId] });
        void queryClient.invalidateQueries({
          queryKey: ["changes", run.agentId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["git-summary", run.agentId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["commits", run.agentId],
        });
      }
      if (run.status === "starting" || needsRefresh) {
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
        void queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] });
        void queryClient.invalidateQueries({
          queryKey: ["session", run.sessionId],
        });
      }
    } else if (event.type === "request" && event.request) {
      const request = event.request;
      void queryClient.cancelQueries({ queryKey: ["overview"] });
      queryClient.setQueryData<Overview>(
        ["overview"],
        (old) =>
          old && {
            ...old,
            requests: [
              ...old.requests.filter((r) => r.id !== request.id),
              ...(request.status === "pending" ? [request] : []),
            ],
          },
      );
    } else {
      if (
        event.type === "agents" ||
        event.type === "providers" ||
        event.type === "skills"
      ) {
        void queryClient.invalidateQueries({ queryKey: ["skills"] });
        void queryClient.invalidateQueries({
          queryKey: ["skill-subscriptions"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["skill-update-settings"],
        });
      }
      if (event.type === "providers" || event.type === "plugins") {
        void queryClient.invalidateQueries({ queryKey: ["plugins"] });
        void queryClient.invalidateQueries({
          queryKey: ["plugin-update-settings"],
        });
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
        void queryClient.invalidateQueries({ queryKey: ["models"] });
      }
      if (event.type === "plugins") {
        void queryClient.invalidateQueries({ queryKey: ["task-sources"] });
        void queryClient.invalidateQueries({ queryKey: ["automations"] });
        void queryClient.invalidateQueries({ queryKey: ["channel"] });
      }
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      if (event.type === "chats" || event.type === "queue")
        void queryClient.invalidateQueries({ queryKey: ["task-executions"] });
      if (event.type === "chats" && event.chatId)
        void queryClient.invalidateQueries({ queryKey: ["chat", event.chatId] });
      if (event.type === "queue")
        void queryClient.invalidateQueries({ queryKey: ["chat"] });
    }
    // Cancellation above can restore a pre-event snapshot. Apply the sidebar
    // projection afterwards so a failed refetch cannot erase a new result.
    if (event.conversation) {
      const conversation = event.conversation;
      queryClient.setQueryData<Overview>(
        ["overview"],
        (old) =>
          old && {
            ...old,
            // Streaming updates replace in place so sidebar rows do not move.
            conversations: old.conversations.some(
              (item) => item.id === conversation.id,
            )
              ? old.conversations.map((item) =>
                  item.id === conversation.id ? conversation : item,
                )
              : [...old.conversations, conversation],
          },
      );
    }
  };
  return () => stream.close();
}
