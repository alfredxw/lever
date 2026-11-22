import { isMyGo, runtime } from "mygo-runtime";
import type { NotificationTarget } from "@/api/desktop.gen";
import type { Event } from "@/api/types.gen";

const platform = isMyGo() ? runtime().platform : undefined;
export const hasDesktopNotifications =
  platform === "darwin" || platform === "win32";

export type AgentNotice = {
  id: string;
  kind: "completed" | "failed" | "unknown" | "approval" | "input";
  agentId: string;
  target: NotificationTarget;
};

export function observeAgentNotifications(
  deliver: (notice: AgentNotice) => void,
) {
  const seen = new Set<string>();
  return (event: Event) => {
    const { conversation, request, run } = event;
    if (!conversation) return;

    let id: string;
    let runId: string;
    let kind: AgentNotice["kind"];
    if (event.type === "request" && request?.status === "pending") {
      id = request.id;
      runId = request.runId;
      kind = request.kind === "approval" ? "approval" : "input";
    } else if (
      event.type === "run" &&
      run &&
      !run.superseded &&
      ((!run.quiet && run.status === "completed") ||
        run.status === "failed" ||
        (run.quiet && run.status === "unknown"))
    ) {
      id = run.status === "unknown" ? run.id + ":unknown" : run.id;
      runId = run.id;
      kind = run.status;
    } else {
      return;
    }

    // SSE events hydrate the latest snapshot, so several events can show the
    // same outcome or request. Remember it even if alerts are disabled now.
    if (seen.has(id)) return;
    seen.add(id);
    deliver({
      id,
      kind,
      agentId: conversation.agentId,
      target: {
        kind: "chat",
        chatId: conversation.chatId,
        topicId: conversation.kind === "topic" ? conversation.id : undefined,
        runId,
      },
    });
  };
}
