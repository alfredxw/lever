import { api } from "@/api/client";
import type { Run } from "@/api/types.gen";

type InterruptibleReply = Pick<Run, "id" | "canPause" | "channel">;

export const canPauseReply = (run: InterruptibleReply) =>
  !!run.canPause && !run.channel;

export function interruptReply(run: InterruptibleReply) {
  return api(`/runs/${run.id}/${canPauseReply(run) ? "pause" : "stop"}`, {});
}

export function resumeReply(run: Pick<Run, "id" | "nativeTurnId">) {
  return api(`/runs/${run.id}/resume`, { nativeTurnId: run.nativeTurnId });
}
