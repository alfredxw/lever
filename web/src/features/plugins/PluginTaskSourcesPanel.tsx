import { useState } from "react";
import { ArrowUpRight, ChevronDown, Plus, RefreshCw, Rss } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError, queryClient } from "@/api/client";
import type { Plugin, TaskSource } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  AddTaskSourceDialog,
  TaskSourceDetail,
  useTaskSources,
} from "@/features/tasks/TaskSources";

export function PluginTaskSourcesPanel({
  plugin,
  onOpenWorks,
}: {
  plugin: Plugin;
  onOpenWorks?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const sourcesQuery = useTaskSources(true);
  const sources = (sourcesQuery.data ?? []).filter(
    (s) => s.pluginId === plugin.id,
  );
  const [selectedId, setSelectedId] = useState<string>("");
  const [adding, setAdding] = useState(false);

  const selected =
    sources.find((s) => s.id === selectedId) ??
    (sources.length === 1 ? sources[0] : undefined);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/tasks/sources/${id}`, { enabled }, "PUT"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["task-sources"] }),
    onError: (error) => toast.error(error.message),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api(`/tasks/sources/${id}/sync`, {}),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["task-sources"] }),
    onError: (error) =>
      toast.error(
        error instanceof APIError && error.code === "task_source_rateLimit"
          ? t("tasks.sourceError.rateLimit")
          : error.message,
      ),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="plugins-info-banner">
        <div className="plugins-info-banner-copy">
          <Rss className="size-3.5 shrink-0 text-muted-foreground" />
          <span>{t("plugins.sharedTaskSourcesHint")}</span>
        </div>
        {onOpenWorks && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenWorks}
          >
            {t("plugins.openWorks")}
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        )}
      </div>

      {!plugin.enabled && (
        <p className="plugins-disabled-note" role="status">
          {t("plugins.disabledHint")}
        </p>
      )}

      {sourcesQuery.error && (
        <ErrorNotice
          error={sourcesQuery.error}
          retry={() => void sourcesQuery.refetch()}
        />
      )}

      <section className="plugins-panel panel-surface">
        <div className="plugins-panel-head">
          <div className="flex items-center gap-2">
            <h3>{t("plugins.taskSource.heading")}</h3>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("plugins.taskSource.count", { count: sources.length })}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!plugin.enabled}
            onClick={() => setAdding(true)}
          >
            <Plus data-icon="inline-start" />
            {t("plugins.taskSource.add")}
          </Button>
        </div>

        {sources.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-4 py-5 text-xs text-muted-foreground">
            <p>{t("plugins.taskSource.empty")}</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {sources.map((source) => {
              const isExpanded = selected?.id === source.id;
              const active = source.enabled && source.pluginEnabled;
              const syncedAt = source.lastSyncedAt
                ? new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(new Date(source.lastSyncedAt * 1000))
                : undefined;
              return (
                <div key={source.id}>
                  <div className="plugins-panel-row">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
                      onClick={() =>
                        setSelectedId(isExpanded ? "" : source.id)
                      }
                    >
                      <span
                        className="plugins-status-dot"
                        data-tone={
                          !active
                            ? "muted"
                            : source.error
                              ? "error"
                              : source.syncPending
                                ? "attention"
                                : "positive"
                        }
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                          <span className="truncate">{source.name}</span>
                          {source.contributionId === "github" &&
                            source.syncKind && (
                              <Badge
                                variant="outline"
                                className="h-5 px-1.5 text-[11px] font-normal"
                              >
                                {t(`tasks.syncKind.${source.syncKind}`)}
                              </Badge>
                            )}
                          {source.summary && (
                            <Badge
                              variant="outline"
                              className="h-5 max-w-56 truncate px-1.5 text-[11px] font-normal text-muted-foreground"
                            >
                              {source.summary}
                            </Badge>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground tabular-nums">
                          {source.error
                            ? t(`tasks.sourceError.${source.error}`, {
                                defaultValue: source.error,
                              })
                            : !source.enabled
                              ? t("tasks.sourcePaused")
                              : syncedAt
                                ? t("tasks.syncedAt", { time: syncedAt })
                                : t("tasks.sourceWaiting")}
                        </span>
                      </span>
                      <ChevronDown
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("tasks.syncSource", {
                          name: source.name,
                        })}
                        title={t("tasks.syncNow")}
                        disabled={
                          !active || source.syncPending || sync.isPending
                        }
                        onClick={() => sync.mutate(source.id)}
                      >
                        <RefreshCw
                          className={
                            active && source.syncPending
                              ? "animate-spin"
                              : undefined
                          }
                        />
                      </Button>
                      <Switch
                        size="sm"
                        aria-label={t("tasks.sourceAutoSync")}
                        checked={source.enabled}
                        disabled={toggle.isPending}
                        onCheckedChange={(enabled) =>
                          toggle.mutate({ id: source.id, enabled })
                        }
                      />
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-border/50 bg-background/60 px-4 py-4">
                      <TaskSourceDetail source={source} visible embedded />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {adding && (
        <AddTaskSourceDialog
          pluginId={plugin.id}
          onAdded={(source: TaskSource) => setSelectedId(source.id)}
          onClose={() => setAdding(false)}
          onCloseAutoFocus={(event) => event.preventDefault()}
        />
      )}
    </div>
  );
}
