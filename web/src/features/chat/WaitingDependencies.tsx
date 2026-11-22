import { useMutation } from "@tanstack/react-query";
import { Pencil, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Run, RunDependency } from "@/api/types.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OpenRun } from "./DelegatedTasks";
import { DependencyStatusIcon } from "./WaitRunPicker";
import { dependencyProgress, isDependencyBlocked } from "./waitRuns";

export function WaitingDependencies({
  run,
  compact = false,
  disabled = false,
  showActions = true,
  onEdit,
  onOpenRun,
}: {
  run: Run;
  compact?: boolean;
  disabled?: boolean;
  showActions?: boolean;
  onEdit?: (run: Run) => void;
  onOpenRun?: OpenRun;
}) {
  const { t } = useTranslation();
  const deps = run.waitingOn;
  const action = useMutation({
    mutationFn: (kind: "run_now" | "remove") =>
      api(`/runs/${run.id}/queue`, { action: kind }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] });
      void queryClient.invalidateQueries({
        queryKey: ["session", run.sessionId],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  if (!deps?.length) return null;
  const { total, completed, blocked } = dependencyProgress(deps);
  const queued = run.status === "queued";
  const busy = disabled || action.isPending;

  function renderChip(dep: RunDependency) {
    const title = dep.title || dep.runId.slice(0, 8);
    const depBlocked = isDependencyBlocked(dep.status, dep.blocked);
    const statusText =
      dep.status === "queued"
        ? t(depBlocked ? "after.statusBlocked" : "after.statusWaiting")
        : t(`status.${dep.status}`, { defaultValue: dep.status });
    const content = (
      <>
        <DependencyStatusIcon status={dep.status} blocked={dep.blocked} />
        <span className="max-w-40 truncate">{title}</span>
      </>
    );
    if (onOpenRun) {
      return (
        <Button
          key={dep.runId}
          type="button"
          variant="secondary"
          size="xs"
          data-status={dep.status}
          className={cn(
            "h-6 max-w-full gap-1.5 rounded-full px-2 text-xs font-normal",
            depBlocked && "text-destructive",
          )}
          title={`${title} · ${statusText}`}
          onClick={() => onOpenRun(dep, title)}
        >
          {content}
        </Button>
      );
    }
    return (
      <Badge
        key={dep.runId}
        variant="secondary"
        data-status={dep.status}
        className={cn(
          "h-6 max-w-full gap-1.5 rounded-full px-2 text-xs font-normal",
          depBlocked && "text-destructive",
        )}
        title={`${title} · ${statusText}`}
      >
        {content}
      </Badge>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        compact ? "mt-1.5" : "rounded-xl border border-dashed border-border p-3",
      )}
      data-waiting-blocked={blocked > 0 || undefined}
      role="status"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "text-xs tabular-nums",
            blocked > 0 ? "font-medium text-destructive" : "text-muted-foreground",
          )}
        >
          {blocked > 0
            ? t("after.blockedSummary", {
                failed: blocked,
                completed,
                total,
              })
            : queued
              ? t("after.waitingProgress", { completed, total })
              : t("after.ranAfter", { count: total })}
        </span>
        {queued && showActions && (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => action.mutate("run_now")}
            >
              <Play data-icon="inline-start" />
              {t(blocked > 0 ? "after.runAnyway" : "after.runNow")}
            </Button>
            {onEdit && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("queue.edit")}
                title={t("queue.edit")}
                disabled={busy}
                onClick={() => onEdit(run)}
              >
                <Pencil />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("after.cancelWaiting")}
              title={t("after.cancelWaiting")}
              disabled={busy}
              onClick={() => action.mutate("remove")}
            >
              <X />
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {deps.map(renderChip)}
      </div>
    </div>
  );
}
