import { api } from "@/api/client";
import type { Run } from "@/api/types.gen";
export { canContinueRun, canRecoverRun } from "./runRecovery";

type InterruptibleReply = Pick<Run, "id" | "canPause" | "channel">;

export const canPauseReply = (run: InterruptibleReply) =>
  !!run.canPause && !run.channel;

export function interruptReply(run: InterruptibleReply) {
  return api(`/runs/${run.id}/${canPauseReply(run) ? "pause" : "stop"}`, {});
}

export function resumeReply(run: Pick<Run, "id" | "nativeTurnId">) {
  return api(`/runs/${run.id}/resume`, { nativeTurnId: run.nativeTurnId });
}

export function recoverRun(
  run: Pick<Run, "id" | "status" | "nativeTurnId">,
  commandId?: string,
) {
  return run.status === "paused"
    ? resumeReply(run)
    : api(`/runs/${run.id}/retry`, { commandId });
}
