import type { SharedConversation } from "@/api/types.gen";

export type SharedConversationRef = Pick<
  SharedConversation,
  "id" | "provider" | "runtime"
>;

export const sharedConversationsPath = "/shared-conversations";

export function sharedConversationPath(ref: SharedConversationRef) {
  return `${sharedConversationsPath}/${encodeURIComponent(ref.provider)}/${encodeURIComponent(ref.id)}`;
}

export function sharedConversationKey(ref: SharedConversationRef) {
  return `shared:${ref.provider}:${ref.id}`;
}

export function sharedRuntimeName(runtime: string) {
  return runtime === "codex" ? "Codex App" : "Claude Code";
}
