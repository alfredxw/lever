import { useMutation } from "@tanstack/react-query";
import {
  CornerUpRight,
  MessageCircle,
  MessagesCircle,
  Pencil,
  Play,
  X,
} from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Catalog, Run } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { Attachments } from "./Attachments";
import { MessageInput } from "./References";
import { QuotedMessage } from "./QuotedMessage";
import { steerModelHint } from "./steer";
import { isLeverReference } from "./prompt";
import { WaitingDependencies } from "./WaitingDependencies";
import { dependencyProgress } from "./waitRuns";

export function QueuedMessages({
  runs,
  activeRun,
  queuePaused,
  catalog,
  disabled,
  editing,
  onEdit,
  onSteer,
}: {
  runs: Run[];
  activeRun?: Run;
  queuePaused?: boolean;
  catalog?: Catalog | null;
  disabled?: boolean;
  editing?: string;
  onEdit?: (run: Run) => void;
  onSteer?: (run: Run) => void;
}) {
  const { t } = useTranslation();
  const queueId = useId();
  const action = useMutation({
    mutationFn: ({ run, action }: { run: Run; action: string }) => {
      if (action === "resume")
        return api(`/sessions/${run.sessionId}/queue/resume`, {});
      if (action === "main" || action === "topic")
        return api("/messages", {
          commandId: crypto.randomUUID(),
          chatId: run.chatId,
          editRunId: run.id,
          operation: action,
          text: run.input,
          selection: run.selection,
          attachmentIds: run.attachments.map((file) => file.id),
          references: run.references,
          quote: run.quote,
          afterRunIds: run.afterRunIds,
        });
      return api(`/runs/${run.id}/queue`, {
        action,
        steerRunId: action === "send" ? activeRun?.id : undefined,
      });
    },
    onSuccess: async (_, { run, action }) => {
      if (action === "send") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
          queryClient.invalidateQueries({
            queryKey: ["session", run.sessionId],
          }),
          queryClient.invalidateQueries({ queryKey: ["overview"] }),
        ]);
        onSteer?.(run);
      } else {
        void queryClient.invalidateQueries();
      }
    },
    onError: (error) => toast.error(error.message),
  });
  if (!runs.length) return null;
  const sorted = [...runs].sort((a, b) => a.sequence - b.sequence);
  const head = sorted[0];
  const headDeps = dependencyProgress(head.waitingOn);
  const waiting = !activeRun && headDeps.completed < headDeps.total;
  const paused = !activeRun && !waiting && queuePaused;
  const heading = waiting
    ? headDeps.blocked > 0
      ? "after.queueBlocked"
      : "after.queueWaiting"
    : paused
      ? "queue.paused"
      : "queue.count";
  return (
    <section className="queued-messages" aria-label={t("queue.title")}>
      <div className="queue-heading">
        <span>{t(heading, { count: runs.length })}</span>
        {paused && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || action.isPending}
            onClick={() => action.mutate({ run: head, action: "resume" })}
          >
            <Play />
            {t("queue.resume")}
          </Button>
        )}
      </div>
      <ol>
        {sorted.map((run) => {
            const busy = disabled || action.isPending;
            const editable = onEdit && !run.comparisonId && !run.channel;
            const hasWaiting = Boolean(
              run.afterRunIds?.length || run.waitingOn?.length,
            );
            const currentSelection =
              !activeRun?.channel &&
              activeRun?.sessionId === run.sessionId &&
              ["starting", "running"].includes(activeRun.status)
                ? activeRun.selection
                : undefined;
            const differentPolicy =
              currentSelection &&
              (currentSelection.provider !== run.selection.provider ||
                (run.selection.permission &&
                  currentSelection.permission !== run.selection.permission));
            const canSteer =
              !hasWaiting &&
              (activeRun?.canSteer || activeRun?.steerPending) &&
              !run.references?.some(isLeverReference) &&
              currentSelection &&
              !differentPolicy &&
              run.steerRunId !== activeRun?.id;
            const steerHint =
              editable &&
              !hasWaiting &&
              (differentPolicy
                ? t("queue.steerRequiresSameRuntimeAndPermission")
                : canSteer
                  ? steerModelHint(t, catalog, currentSelection, run.selection)
                  : undefined);
            const steerHintId = steerHint ? `${queueId}-${run.id}` : undefined;
            return (
              <li
                key={run.id}
                data-queued-id={run.id}
                data-editing={editing === run.id || undefined}
              >
                <div className="queued-message-content">
                  {run.quote && <QuotedMessage quote={run.quote} />}
                  <MessageInput
                    text={run.input}
                    references={run.references}
                    sessionId={run.sessionId}
                  />
                  <Attachments files={run.attachments} />
                  {hasWaiting && (
                    <WaitingDependencies
                      run={run}
                      compact
                      showActions={false}
                    />
                  )}
                  {activeRun && run.steerRunId === activeRun.id && (
                    <p
                      role="status"
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {t("queue.steerWhenReady")}
                    </p>
                  )}
                  {steerHint && (
                    <p
                      id={steerHintId}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {steerHint}
                    </p>
                  )}
                  {run.error && <p role="status">{run.error}</p>}
                </div>
                <div className="queue-actions">
                  {editable && run.operation !== "reply" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="queue-mode"
                      aria-label={t(
                        run.operation === "topic"
                          ? "queue.toChat"
                          : "queue.toTopic",
                      )}
                      title={t(
                        run.operation === "topic"
                          ? "queue.toChat"
                          : "queue.toTopic",
                      )}
                      disabled={busy || !!editing}
                      onClick={() =>
                        action.mutate({
                          run,
                          action: run.operation === "topic" ? "main" : "topic",
                        })
                      }
                    >
                      {run.operation === "topic" ? (
                        <MessagesCircle />
                      ) : (
                        <MessageCircle />
                      )}
                      {t(
                        run.operation === "topic"
                          ? "chat.topic"
                          : "workspace.chat",
                      )}
                    </Button>
                  )}
                  {hasWaiting ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("after.runNow")}
                      title={t("after.runNow")}
                      disabled={busy || !!editing}
                      onClick={() => action.mutate({ run, action: "run_now" })}
                    >
                      <Play />
                    </Button>
                  ) : (
                    editable && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t(
                          activeRun?.steerPending
                            ? "queue.steerWhenReady"
                            : "queue.steer",
                        )}
                        aria-describedby={steerHintId}
                        title={t(
                          activeRun?.steerPending
                            ? "queue.steerWhenReady"
                            : "queue.steer",
                        )}
                        disabled={busy || !canSteer || !!editing}
                        onClick={() => action.mutate({ run, action: "send" })}
                      >
                        <CornerUpRight />
                      </Button>
                    )
                  )}
                  {editable && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("queue.edit")}
                      title={t("queue.edit")}
                      disabled={busy || !!editing}
                      onClick={() => onEdit(run)}
                    >
                      <Pencil />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("queue.remove")}
                    title={t("queue.remove")}
                    disabled={busy || editing === run.id}
                    onClick={() => action.mutate({ run, action: "remove" })}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            );
          })}
      </ol>
    </section>
  );
}
