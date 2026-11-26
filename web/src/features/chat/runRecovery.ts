import type { Run, Session } from "../../api/types.gen.ts";

export function canRecoverRun(status: string) {
  return ["paused", "failed", "interrupted"].includes(status);
}

function isStandaloneSlashCommand(
  run: Pick<Run, "input" | "attachments" | "references" | "quote">,
) {
  return (
    run.attachments.length === 0 &&
    !run.references?.length &&
    !run.quote &&
    run.input.trimStart().startsWith("/")
  );
}

export function canContinueRun(
  run: Pick<
    Run,
    | "status"
    | "items"
    | "input"
    | "attachments"
    | "references"
    | "quote"
    | "selection"
    | "channel"
    | "superseded"
  >,
  session?: Pick<Session, "nativeId" | "selection">,
) {
  if (run.channel || run.superseded) return false;
  if (run.status === "paused") return true;
  if (run.status !== "failed" && run.status !== "interrupted") return false;
  return (
    run.items.length > 0 &&
    !!session?.nativeId &&
    session.selection.provider === run.selection.provider &&
    !isStandaloneSlashCommand(run)
  );
}
