import { useMutation } from "@tanstack/react-query";
import {
  CornerUpRight,
  GitBranch,
  MessageCircle,
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

export function QueuedMessages({
  runs,
  activeRun,
  steeringSupported,
  catalog,
  disabled,
  editing,
  onEdit,
  onSteer,
}: {
  runs: Run[];
  activeRun?: Run;
  steeringSupported?: boolean;
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
        });
      return api(`/runs/${run.id}/queue`, { action });
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
  return (
    <section className="queued-messages" aria-label={t("queue.title")}>
      <div className="queue-heading">
        <span>
          {t(activeRun ? "queue.count" : "queue.paused", {
            count: runs.length,
          })}
        </span>
        {!activeRun && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || action.isPending}
            onClick={() => action.mutate({ run: runs[0], action: "resume" })}
          >
            <Play />
            {t("queue.resume")}
          </Button>
        )}
      </div>
      <ol>
        {[...runs]
          .sort((a, b) => a.sequence - b.sequence)
          .map((run) => {
            const busy = disabled || action.isPending;
            const editable = onEdit && !run.comparisonId && !run.channel;
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
              steeringSupported &&
              !run.references?.some(isLeverReference) &&
              currentSelection &&
              !differentPolicy &&
              run.steerRunId !== activeRun?.id;
            const steerHint =
              editable &&
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
                        <GitBranch />
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
                  {editable && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("queue.steer")}
                        aria-describedby={steerHintId}
                        title={t("queue.steer")}
                        disabled={busy || !canSteer || !!editing}
                        onClick={() => action.mutate({ run, action: "send" })}
                      >
                        <CornerUpRight />
                      </Button>
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
                    </>
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
