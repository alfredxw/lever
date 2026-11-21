import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ChevronDown,
  Copy,
  Ellipsis,
  History,
  Pencil,
  Play,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { isMyGo } from "mygo-runtime";
import { toast } from "sonner";
import { active, api, queryClient } from "@/api/client";
import { Dialogs } from "@/api/desktop.gen";
import type {
  Agent,
  Automation,
  AutomationRun,
  Chat,
  TaskExecution,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { ActivityTime } from "@/components/workbench/ActivityTime";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { displayChatTitle } from "@/features/chat/conversationTitle";
import { RunStatus } from "@/features/chat/RunStatus";
import { automationPath, automationsQuery } from "./automationsQuery";

export function AutomationDetails({
  plan,
  agent,
  chat,
  kind,
  timing,
  next,
  onEdit,
  onArchived,
  onOpenChat,
}: {
  plan: Automation;
  agent?: Agent;
  chat?: Chat;
  kind: string;
  timing: string;
  next: string;
  onEdit: () => void;
  onArchived: () => void;
  onOpenChat: (run: TaskExecution, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [archiving, setArchiving] = useState(false);
  const path = automationPath + "/" + plan.id;
  const historyKey = ["automation-runs", plan.id];
  const history = useQuery({
    queryKey: historyKey,
    queryFn: ({ signal }) =>
      api<AutomationRun[]>(path + "/history", undefined, "GET", signal),
    refetchOnWindowFocus: true,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(path, { enabled }, "PATCH"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: automationsQuery.queryKey }),
    onError: (error) => toast.error(error.message),
  });
  const mutate = useMutation({
    mutationFn: (action: "run" | "archive") =>
      action === "run"
        ? api(path + "/run", { commandId: crypto.randomUUID() }, "POST")
        : api(path, {}, "DELETE"),
    onSuccess: async (_result, action) => {
      if (action === "archive") onArchived();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: automationsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: historyKey }),
      ]);
    },
  });
  const busy = (history.data ?? plan.recentRuns)?.some(
    ({ status }) => status === "queued" || active(status),
  );
  const copy = async (value: string) => {
    try {
      if (isMyGo()) await Dialogs.writeClipboard(value, "");
      else await navigator.clipboard.writeText(value);
      toast.success(t("automations.copied"));
    } catch {
      toast.error(t("automations.copyFailed"));
    }
  };
  const eventToken = plan.eventToken;
  const zone = plan.trigger.schedule?.timezone;
  const nextAt =
    plan.enabled && plan.nextAt ? new Date(plan.nextAt * 1000) : undefined;
  return (
    <article className="automation-detail">
      <header className="automation-detail-header">
        <div className="min-w-0">
          <h2>{plan.name}</h2>
          <p className="automation-trigger-line">
            {kind}
            <span aria-hidden="true">·</span>
            {timing}
            {zone && <span className="automation-zone">{zone}</span>}
          </p>
        </div>
        <div className="automation-detail-actions">
          {plan.trigger.kind === "schedule" && (
            <Button
              size="sm"
              aria-label={t("automations.runNow")}
              title={t("automations.runNow")}
              disabled={mutate.isPending || busy}
              onClick={() => mutate.mutate("run")}
            >
              <Play data-icon="inline-start" />
              <span>{t("automations.runNow")}</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            aria-label={t("automations.edit")}
            title={t("automations.edit")}
          >
            <Pencil data-icon="inline-start" />
            <span>{t("automations.editAction")}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("automations.actions")}
                disabled={mutate.isPending}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  mutate.reset();
                  setArchiving(true);
                }}
              >
                {t("automations.archive")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="automation-state">
        <label>
          <Switch
            checked={plan.enabled}
            disabled={toggle.isPending}
            aria-label={t("automations.toggle", { name: plan.name })}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
          />
          {t(plan.enabled ? "automations.enabled" : "automations.paused")}
        </label>
        {plan.enabled &&
          (nextAt ? (
            <time
              dateTime={nextAt.toISOString()}
              title={nextAt.toLocaleString(i18n.language, {
                dateStyle: "full",
                timeStyle: "long",
              })}
            >
              {next}
            </time>
          ) : (
            <span>{next}</span>
          ))}
      </div>
      {plan.error && <ErrorNotice error={plan.error} />}
      {(plan.sourceDisabled || plan.sourceError) && (
        <ErrorNotice
          error={
            plan.sourceDisabled
              ? t("automations.sourceDisabled")
              : plan.sourceError
          }
        />
      )}
      {mutate.error && !archiving && <ErrorNotice error={mutate.error} />}
      <dl className="automation-properties">
        <div>
          <dt>{t("automations.owner")}</dt>
          <dd>
            {agent && <AgentAvatar agent={agent} size="sm" />}
            {agent?.name ?? t("tasks.unassigned")}
          </dd>
        </div>
        <div>
          <dt>{t("automations.destination")}</dt>
          <dd>
            {t("automations.destination." + plan.destination.mode)}
            {chat && (
              <span className="automation-bound-chat">
                {" "}
                · {displayChatTitle(chat, t)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("automations.agentActivity")}</dt>
          <dd>
            {t(
              plan.quiet
                ? "automations.activityAttention"
                : "automations.activityNormal",
            )}
          </dd>
        </div>
        <div>
          <dt>{t("automations.boardItems")}</dt>
          <dd>
            {t(
              plan.workItem === false
                ? "automations.boardOff"
                : "automations.boardOn",
            )}
          </dd>
        </div>
      </dl>
      <details
        className="automation-instructions"
        open={plan.prompt.length <= 260 && plan.prompt.split("\n").length <= 4}
      >
        <summary>
          {t("automations.prompt")}
          <ChevronDown aria-hidden="true" />
        </summary>
        <p>{plan.prompt}</p>
      </details>
      {plan.eventUrl && eventToken && (
        <details className="automation-event-source">
          <summary>
            {t("automations.eventSource")}
            <ChevronDown aria-hidden="true" />
          </summary>
          <div>
            <code className="automation-endpoint">POST {plan.eventUrl}</code>
            <p>{t("automations.eventHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void copy(
                    "curl -X POST " +
                      JSON.stringify(plan.eventUrl) +
                      ' -H "Authorization: Bearer ' +
                      eventToken +
                      '" -H "Content-Type: application/json" -d \'{"type":"example"}\'',
                  )
                }
              >
                <Copy data-icon="inline-start" /> {t("automations.copyRequest")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void copy(eventToken)}
              >
                {t("automations.copyToken")}
              </Button>
            </div>
          </div>
        </details>
      )}
      <section
        className="automation-history"
        aria-label={t("automations.history")}
      >
        <h3>{t("automations.history")}</h3>
        {history.isPending ? (
          <Loading />
        ) : history.error && !history.data ? (
          <ErrorNotice
            error={history.error}
            retry={() => void history.refetch()}
          />
        ) : !history.data?.length ? (
          <div className="automation-no-runs">
            <History aria-hidden="true" />
            <p>{t("automations.noRuns")}</p>
          </div>
        ) : (
          <ol className="automation-history-list">
            {history.data.map((run) => (
              <li key={run.id} className="automation-history-row">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {run.status === "skipped" ? (
                      <Badge variant="secondary">
                        {t("automations.skipped")}
                      </Badge>
                    ) : (
                      <RunStatus status={run.status} />
                    )}
                    <ActivityTime
                      timestamp={
                        run.plannedAt
                          ? new Date(run.plannedAt * 1000).toISOString()
                          : run.createdAt
                      }
                    />
                    <span className="text-xs text-muted-foreground">
                      {run.trigger === "event"
                        ? t("automations.eventsReceived", {
                            count: run.eventCount ?? 0,
                          })
                        : t(
                            run.trigger === "manual"
                              ? "automations.manual"
                              : "automations.schedule",
                          )}
                    </span>
                  </div>
                  {run.error && (
                    <p className="text-xs text-destructive">{run.error}</p>
                  )}
                </div>
                {run.execution && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenChat(run.execution!, run.name)}
                  >
                    <ArrowUpRight data-icon="inline-start" />{" "}
                    {t(
                      run.execution.topic
                        ? "automations.openTopic"
                        : "tasks.openChat",
                    )}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {archiving && (
        <Dialog
          open
          onOpenChange={(open) =>
            !open && !mutate.isPending && setArchiving(false)
          }
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("automations.archive")}</DialogTitle>
              <DialogDescription>
                {t("automations.archiveConfirm", { name: plan.name })}
              </DialogDescription>
            </DialogHeader>
            {mutate.error && <ErrorNotice error={mutate.error} />}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={mutate.isPending}
                onClick={() => setArchiving(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={mutate.isPending}
                onClick={() => mutate.mutate("archive")}
              >
                {t("automations.archive")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </article>
  );
}
