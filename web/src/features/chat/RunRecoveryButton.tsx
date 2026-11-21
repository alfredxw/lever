import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Play, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import type { Run } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { resumeReply } from "./runControls";

export function canRecoverRun(status: string) {
  return ["paused", "failed", "interrupted"].includes(status);
}

export function RunRecoveryButton({
  run,
  disabled,
  onRetried,
}: {
  run: Run;
  disabled?: boolean;
  onRetried?: () => void;
}) {
  const { t } = useTranslation();
  const paused = run.status === "paused";
  const action = useMutation({
    mutationFn: (commandId?: string) =>
      paused ? resumeReply(run) : api(`/runs/${run.id}/retry`, { commandId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
        queryClient.invalidateQueries({ queryKey: ["session", run.sessionId] }),
      ]);
      if (!paused) onRetried?.();
    },
    onError: (error) => toast.error(error.message),
  });
  const responseUncertain =
    action.isError &&
    (!(action.error instanceof APIError) || action.error.status >= 500);
  const Icon = paused ? Play : RotateCcw;
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
      {t(paused ? "chat.resumeReply" : "common.retry")}
    </Button>
  );
}
