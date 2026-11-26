import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileDiff, LoaderCircle, Monitor, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import type { Answer, Request } from "@/api/types.gen";
import type { Record as SharedRecord } from "@/api/hub.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/common";
import { RequestCard } from "./RequestCard";

export interface RemoteDelegationTarget {
  remoteRowId?: string;
  hubId: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
  agentName: string;
  chatId: string;
  title: string;
  status: string;
}

function recordToRequest(rec: SharedRecord): Request {
  return {
    id: rec.id,
    runId: rec.runId ?? "",
    chatId: rec.chatId ?? "",
    sessionId: rec.sessionId ?? "",
    kind: rec.type ?? "approval",
    title: rec.title ?? "",
    detail: rec.text ?? "",
    status: rec.status ?? "pending",
    answeredByUserId: rec.answeredByUserId,
    questions: (rec.questions ?? []).map((q) => ({
      id: q.id,
      text: q.text,
      multiple: !!q.multiple,
      options: (q.options ?? []).map((o) => ({ id: o.id, label: o.name })),
    })),
    options: rec.options?.map((o) => ({
      id: o.id,
      name: o.name,
      allow: !!o.allow,
    })),
    allowOnce: rec.allowOnce
      ? {
          allow: rec.allowOnce.allow,
          optionId: rec.allowOnce.optionId,
          answers: rec.allowOnce.answers ?? {},
        }
      : undefined,
    answer: rec.answer
      ? {
          allow: rec.answer.allow,
          optionId: rec.answer.optionId,
          answers: rec.answer.answers ?? {},
        }
      : undefined,
  };
}

export function RemoteDelegationDialog({
  target,
  onOpenChange,
}: {
  target: RemoteDelegationTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const canPoll = Boolean(
    target && target.hubId && target.spaceId && target.deviceId && target.chatId,
  );
  const archive = useQuery({
    queryKey: [
      "remote-delegation-archive",
      target?.hubId,
      target?.spaceId,
      target?.deviceId,
      target?.chatId,
    ],
    enabled: canPoll,
    queryFn: ({ signal }) =>
      api<SharedRecord[]>(
        "/remote",
        {
          action: "control",
          scope: { hubId: target!.hubId, spaceId: target!.spaceId },
          method: "GET",
          path: `/api/spaces/${encodeURIComponent(target!.spaceId)}/archive/${encodeURIComponent(target!.deviceId)}?chat=${encodeURIComponent(target!.chatId)}`,
        },
        "POST",
        signal,
      ),
    refetchInterval: target && active(target.status) ? 2000 : false,
  });

  const stopMutation = useMutation({
    mutationFn: () =>
      api(`/delegations/remote/${target!.remoteRowId}/stop`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["delegations"] });
      void archive.refetch();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : String(err)),
  });

  const runs = useMemo(
    () =>
      (archive.data ?? [])
        .filter((rec) => rec.kind === "run" && !rec.superseded)
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
    [archive.data],
  );
  const pendingRequests = useMemo(
    () =>
      (archive.data ?? [])
        .filter((rec) => rec.kind === "request" && rec.status === "pending")
        .map(recordToRequest),
    [archive.data],
  );
  const latestStatus = runs.at(-1)?.status || target?.status || "";
  const isRunning = active(latestStatus);

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <div className="flex items-start justify-between gap-3 pr-6">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Monitor className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {target
                    ? t("chat.remoteDelegationTitle", {
                        device: target.deviceName || target.deviceId,
                        agent: target.agentName,
                      })
                    : ""}
                </span>
              </DialogTitle>
              <DialogDescription className="mt-1 line-clamp-2 text-xs">
                {target?.title}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {latestStatus && (
                <Badge variant="outline">
                  {t(
                    latestStatus === "running"
                      ? "tasks.status.running"
                      : `status.${latestStatus}`,
                    { defaultValue: latestStatus },
                  )}
                </Badge>
              )}
              {target?.remoteRowId && isRunning && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={stopMutation.isPending}
                  onClick={() => stopMutation.mutate()}
                >
                  <Square className="size-3" data-icon="inline-start" />
                  {t("chat.remoteDelegationStop")}
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {!target?.chatId ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t("chat.remoteDelegationWaitingAccept")}
            </div>
          ) : archive.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t("chat.remoteDelegationLoading")}
            </div>
          ) : archive.error ? (
            <ErrorNotice
              error={archive.error}
              retry={() => void archive.refetch()}
            />
          ) : runs.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              {t("chat.remoteDelegationEmpty")}
            </p>
          ) : (
            runs.map((run) => (
              <div
                key={run.id}
                className="flex flex-col gap-2.5 rounded-lg border border-border bg-(--panel-background) p-3.5"
              >
                {run.text && (
                  <div className="rounded-md bg-muted/60 px-3 py-2 text-xs whitespace-pre-wrap text-foreground">
                    {run.text}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {(run.items ?? []).map((item) => {
                    if (item.kind === "text" && item.text) {
                      return (
                        <div
                          key={item.id}
                          className="text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground"
                        >
                          {item.text}
                        </div>
                      );
                    }
                    if (item.kind === "tool" || item.kind === "command") {
                      return (
                        <div
                          key={item.id}
                          className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground"
                        >
                          <span className="font-medium text-foreground">
                            {item.title || item.kind}
                          </span>
                          {item.text && (
                            <p className="mt-1 line-clamp-3 whitespace-pre-wrap">
                              {item.text}
                            </p>
                          )}
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
                {run.files && run.files.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                    <FileDiff className="size-3.5 shrink-0" aria-hidden />
                    {run.files.map((file) => (
                      <span
                        key={file.name}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {file.name} (+{file.additions}/-{file.deletions})
                      </span>
                    ))}
                  </div>
                )}
                {run.error && (
                  <p className="text-xs text-destructive whitespace-pre-wrap">
                    {run.error}
                  </p>
                )}
              </div>
            ))
          )}

          {target?.remoteRowId && pendingRequests.length > 0 && (
            <div className="flex flex-col gap-2">
              {pendingRequests.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  source={t("chat.requestFromRemoteCollaborator", {
                    device: target.deviceName || target.deviceId,
                    agent: target.agentName,
                  })}
                  onSubmit={async (value: Answer | "allow-run") => {
                    await api(
                      `/delegations/remote/${target.remoteRowId}/answer`,
                      value === "allow-run"
                        ? { requestId: request.id, allowRun: true }
                        : { requestId: request.id, answer: value },
                    );
                    void archive.refetch();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
