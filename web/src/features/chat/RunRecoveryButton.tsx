import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Play, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { APIError, queryClient } from "@/api/client";
import type { Run, Session } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { canContinueRun, canRecoverRun, recoverRun } from "./runControls";

export { canRecoverRun };

export function RunRecoveryButton({
  run,
  session,
  disabled,
  onRetried,
}: {
  run: Run;
  session?: Session;
  disabled?: boolean;
  onRetried?: () => void;
}) {
  const { t } = useTranslation();
  const paused = run.status === "paused";
  const continuing = canContinueRun(run, session);
  const action = useMutation({
    mutationFn: (commandId?: string) => recoverRun(run, commandId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
        queryClient.invalidateQueries({ queryKey: ["session", run.sessionId] }),
        run.comparisonId
          ? queryClient.invalidateQueries({
              queryKey: ["comparison", run.comparisonId],
            })
          : undefined,
      ]);
      if (!paused) onRetried?.();
    },
    onError: (error) => toast.error(error.message),
  });
  const responseUncertain =
    action.isError &&
    (!(action.error instanceof APIError) || action.error.status >= 500);
  const Icon = continuing ? Play : RotateCcw;
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={action.isPending || disabled}
      onClick={() =>
        action.mutate(
          paused
            ? undefined
            : (responseUncertain && action.variables) || crypto.randomUUID(),
        )
      }
    >
      {action.isPending ? (
        <LoaderCircle
          data-icon="inline-start"
          className="animate-spin motion-reduce:animate-none"
        />
      ) : (
        <Icon data-icon="inline-start" />
      )}
      {t(continuing ? "chat.resumeReply" : "common.retry")}
    </Button>
  );
}
