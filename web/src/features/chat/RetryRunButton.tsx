import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import type { Run } from "@/api/types.gen";
import { Button } from "@/components/ui/button";

export function canRetryRun(status: string) {
  return status === "failed" || status === "interrupted";
}

export function RetryRunButton({
  run,
  disabled,
  onRetried,
}: {
  run: Run;
  disabled?: boolean;
  onRetried?: () => void;
}) {
  const { t } = useTranslation();
  const retry = useMutation({
    mutationFn: (commandId: string) =>
      api<Run>(`/runs/${run.id}/retry`, { commandId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["chat", run.chatId] }),
        queryClient.invalidateQueries({ queryKey: ["session", run.sessionId] }),
      ]);
      onRetried?.();
    },
    onError: (error) => toast.error(error.message),
  });
  const responseUncertain =
    retry.isError &&
    (!(retry.error instanceof APIError) || retry.error.status >= 500);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={retry.isPending || disabled}
      onClick={() =>
        retry.mutate(
          responseUncertain && retry.variables
            ? retry.variables
            : crypto.randomUUID(),
        )
      }
    >
      {retry.isPending ? (
        <LoaderCircle
          data-icon="inline-start"
          className="animate-spin motion-reduce:animate-none"
        />
      ) : (
        <RotateCcw data-icon="inline-start" />
      )}
      {t("common.retry")}
    </Button>
  );
}
