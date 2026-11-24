import type { Run } from "@/api/types.gen";

const activeStatuses = new Set([
  "starting",
  "running",
  "waiting_user",
  "cancelling",
  "unknown",
]);

export function pickFirstUnreadRun(
  runs: readonly Pick<Run, "id" | "status" | "unreadSequence">[],
  readCursor: number,
): { run?: Pick<Run, "id" | "status" | "unreadSequence">; matched: boolean } {
  const firstUnread = runs.find(
    (run) => (run.unreadSequence ?? 0) > readCursor,
  );
  if (firstUnread) return { run: firstUnread, matched: true };
  // Legacy runs predating per-run unread cursors fall back to the newest turn
  // that could have surfaced the unread state.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (
      !activeStatuses.has(run.status) ||
      run.status === "waiting_user" ||
      run.status === "unknown"
    ) {
      return { run, matched: false };
    }
  }
  return { run: runs.at(-1), matched: false };
}
