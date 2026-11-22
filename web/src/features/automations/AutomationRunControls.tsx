import { useMutation, useIsMutating } from "@tanstack/react-query";
import { Pause, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import { Button } from "@/components/ui/button";

export function AutomationRunControls({
  id,
  status,
  canPause,
}: {
  id: string;
  status: string;
  canPause?: boolean;
}) {
  const { t } = useTranslation();
  const mutationKey = ["automation-run-control", id];
  const busy = useIsMutating({ mutationKey }) > 0;
  const control = useMutation({
    mutationKey,
    mutationFn: (action: "pause" | "stop") =>
      status === "queued"
        ? api(`/runs/${id}/queue`, { action: "remove" })
        : api(`/runs/${id}/${action}`, {}),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["automation-runs"] }),
    onError: (error) => toast.error(error.message),
  });
  if (
    ![
      "queued",
      "starting",
      "running",
      "waiting_user",
      "cancelling",
      "paused",
    ].includes(status)
  )
    return null;
  const pending = busy || status === "cancelling";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      {canPause && (status === "running" || status === "waiting_user") && (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => control.mutate("pause")}
        >
          <Pause />
          {t("automations.pauseRun")}
        </Button>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={() => control.mutate("stop")}
      >
        <Square />
        {t(status === "queued" ? "automations.cancelQueuedRun" : "automations.stopRun")}
      </Button>
    </span>
  );
}
