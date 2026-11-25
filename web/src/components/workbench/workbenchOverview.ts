import type { Overview } from "@/api/types.gen";
import { conversationDraftKey } from "@/features/chat/composerDraft";
import { isRunWaiting, isRunWaitingBlocked } from "@/features/chat/waitRuns";

// The shell needs activity indicators and titles. A streamed change to the
// body of a reply should only notify the conversation displaying that reply.
export function selectWorkbenchOverview({ runs, ...overview }: Overview) {
  return {
    ...overview,
    runs: runs.map((run) => ({
      id: run.id,
      agentId: run.agentId,
      chatId: run.chatId,
      sessionId: run.sessionId,
      status: run.status,
      waiting: isRunWaiting(run),
      waitingBlocked: isRunWaitingBlocked(run),
      canPause: run.canPause && !run.channel,
      nativeTurnId: run.status === "paused" ? run.nativeTurnId : undefined,
      quiet: run.quiet,
      operation: run.operation,
      createdAt: run.createdAt,
      title:
        run.operation === "topic" && run.status === "queued"
          ? run.input.trim() ||
            run.quote?.text ||
            run.attachments?.[0]?.name ||
            run.references?.[0]?.name ||
            ""
          : "",
    })),
  };
}

export type WorkbenchOverview = ReturnType<typeof selectWorkbenchOverview>;

export function selectAgentActivity(
  overview: WorkbenchOverview,
  pinned: ReadonlySet<string>,
  draftKeys?: ReadonlySet<string>,
): WorkbenchOverview {
  if (
    !overview.conversations.some((item) => item.backgroundOnly) &&
    !overview.runs.some((run) => run.quiet)
  )
    return overview;
  const conversations = overview.conversations.filter(
    (item) =>
      !item.backgroundOnly ||
      pinned.has(item.id) ||
      Boolean(draftKeys?.has(conversationDraftKey(item))),
  );
  const backgroundChats = new Set(
    overview.conversations
      .filter((item) => item.backgroundOnly)
      .map((item) => item.chatId),
  );
  for (const item of conversations) backgroundChats.delete(item.chatId);
  return {
    ...overview,
    conversations,
    // Explicitly created empty Chats are also valid navigation targets.
    chats: overview.chats.filter(
      (chat) =>
        !chat.source ||
        chat.source === "user" ||
        !backgroundChats.has(chat.id) ||
        Boolean(draftKeys?.has(chat.id)),
    ),
    runs: overview.runs.filter(
      (run) =>
        !run.quiet || run.status === "waiting_user" || run.status === "unknown",
    ),
  };
}
