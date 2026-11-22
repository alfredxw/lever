import { useId } from "react";
import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import {
  ArrowLeft,
  FolderCode,
  GitBranch,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, APIError } from "@/api/client";
import type { Plugin, PluginUpdate, UpdateSettings } from "@/api/types.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PluginIcon, pluginName } from "./PluginCard";
import { releaseLabel, type PackageAction } from "./PluginPackageDialog";

const policyValues = ["inherit", "auto", "notify", "manual"] as const;
const modes: UpdateSettings["mode"][] = ["auto", "notify", "manual"];
const intervals: UpdateSettings["interval"][] = ["1h", "6h", "24h"];

export function PluginSubscriptionsView({
  plugins,
  settings,
  settingsPending,
  checkByID,
  checkingAny,
  onSaveSettings,
  onCheckAll,
  onSavePluginPolicy,
  onReloadLocal,
  reloadingId,
  onPackageAction,
  onAutoUpdated,
  onOpenPlugin,
  onBack,
  onInstall,
}: {
  plugins: Plugin[];
  settings: UpdateSettings;
  settingsPending: boolean;
  checkByID: Map<string, UseQueryResult<PluginUpdate>>;
  checkingAny: boolean;
  onSaveSettings: (next: UpdateSettings) => void;
  onCheckAll: () => void;
  onSavePluginPolicy: (
    id: string,
    policy: NonNullable<Plugin["updatePolicy"]>,
  ) => void;
  onReloadLocal: (id: string) => void;
  reloadingId?: string;
  onPackageAction: (action: PackageAction) => void;
  onAutoUpdated: (plugin: Plugin) => void;
  onOpenPlugin: (id: string) => void;
  onBack: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const modeId = useId();
  const intervalId = useId();

  const gitPlugins = plugins.filter((p) => !!p.current);
  const localPlugins = plugins.filter(
    (p) => !p.builtin && !p.current && !!p.directory,
  );

  const autoApply = useMutation({
    mutationFn: (plugin: Plugin) =>
      api<{ plugin: Plugin; applied: boolean }>(
        `/plugins/${plugin.id}/auto-update`,
        {},
      ),
    onSuccess: ({ plugin: updated, applied }, plugin) => {
      if (applied) {
        onAutoUpdated(updated);
        toast.success(t("plugins.autoUpdateApplied"));
        return;
      }
      toast.info(t("plugins.autoUpdateNeedsReview"));
      const commit = checkByID.get(plugin.id)?.data?.commit;
      if (commit) {
        onPackageAction({ kind: "update", plugin, commit });
      }
    },
    onError: (error, plugin) => {
      if (
        error instanceof APIError &&
        error.code === "plugin_update_needs_review"
      ) {
        toast.info(t("plugins.autoUpdateNeedsReview"));
        const commit = checkByID.get(plugin.id)?.data?.commit;
        if (commit) {
          onPackageAction({ kind: "update", plugin, commit });
        }
        return;
      }
      toast.error(error.message);
    },
  });

  return (
    <article className="plugins-detail">
      <Button
        variant="ghost"
        size="sm"
        className="plugins-back"
        onClick={onBack}
      >
        <ArrowLeft data-icon="inline-start" />
        {t("plugins.back")}
      </Button>

      <header className="plugins-title">
        <div className="min-w-0">
          <h2>{t("plugins.subscriptions")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("plugins.subscriptionsSubtitle")}
          </p>
        </div>
        <div className="plugins-detail-actions">
          {gitPlugins.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={checkingAny}
              onClick={onCheckAll}
            >
              <RefreshCw
                data-icon="inline-start"
                className={checkingAny ? "animate-spin" : undefined}
              />
              {t("updates.checkAll")}
            </Button>
          )}
          <Button size="sm" onClick={onInstall}>
            <Plus data-icon="inline-start" />
            {t("plugins.install")}
          </Button>
        </div>
      </header>

      <section className="plugins-panel panel-surface">
        <div className="plugins-panel-head">
          <h3>{t("updates.globalTitle")}</h3>
        </div>
        <div className="divide-y divide-border/60">
          <div className="plugins-panel-row flex-wrap">
            <div className="min-w-0 flex-1">
              <div id={modeId} className="text-[13px] font-medium">
                {t("updates.mode")}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("updates.pluginAutoHint")}
              </p>
            </div>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              spacing={0}
              aria-labelledby={modeId}
              disabled={settingsPending}
              value={settings.mode}
              onValueChange={(value) => {
                if (value && value !== settings.mode) {
                  onSaveSettings({
                    ...settings,
                    mode: value as UpdateSettings["mode"],
                  });
                }
              }}
            >
              {modes.map((mode) => (
                <ToggleGroupItem key={mode} value={mode} className="text-xs">
                  {t(`updates.mode.${mode}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {settings.mode !== "manual" && (
            <div className="plugins-panel-row flex-wrap">
              <div className="min-w-0 flex-1">
                <div id={intervalId} className="text-[13px] font-medium">
                  {t("updates.interval")}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("updates.intervalHint")}
                </p>
              </div>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                aria-labelledby={intervalId}
                disabled={settingsPending}
                value={settings.interval}
                onValueChange={(value) => {
                  if (value && value !== settings.interval) {
                    onSaveSettings({
                      ...settings,
                      interval: value as UpdateSettings["interval"],
                    });
                  }
                }}
              >
                {intervals.map((interval) => (
                  <ToggleGroupItem
                    key={interval}
                    value={interval}
                    className="text-xs tabular-nums"
                  >
                    {t(`updates.interval.${interval}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          )}
        </div>
      </section>

      <section className="plugins-panel panel-surface">
        <div className="plugins-panel-head">
          <div className="flex items-center gap-2">
            <GitBranch className="size-3.5 text-muted-foreground" />
            <h3>{t("plugins.gitTracked")}</h3>
            <span className="text-xs text-muted-foreground tabular-nums">
              {gitPlugins.length}
            </span>
          </div>
        </div>
        {gitPlugins.length === 0 ? (
          <div className="px-4 py-5 text-xs text-muted-foreground">
            {t("plugins.noGitPlugins")}
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {gitPlugins.map((plugin) => {
              const check = checkByID.get(plugin.id);
              const nextCommit =
                check?.data?.available && !check.isError
                  ? check.data.commit
                  : undefined;
              const policy = plugin.updatePolicy ?? "inherit";
              return (
                <div
                  key={plugin.id}
                  className="flex flex-col gap-3 px-4 py-3.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
                      onClick={() => onOpenPlugin(plugin.id)}
                    >
                      <span className="plugins-mini-icon">
                        <PluginIcon plugin={plugin} size={18} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-foreground">
                          <span className="truncate">
                            {pluginName(plugin, t)}
                          </span>
                          <Badge
                            variant="outline"
                            className="h-5 px-1.5 text-[11px] font-normal tabular-nums"
                          >
                            v{plugin.manifest.version}
                          </Badge>
                          {nextCommit ? (
                            <span className="plugins-pill" data-tone="running">
                              {t("plugins.updateAvailable")} ·{" "}
                              {nextCommit.slice(0, 7)}
                            </span>
                          ) : check?.isSuccess ? (
                            <span className="plugins-pill" data-tone="muted">
                              {t("updates.upToDate")}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                          {plugin.current!.source.url} ·{" "}
                          {plugin.current!.source.ref} (
                          {plugin.current!.commit.slice(0, 8)})
                        </span>
                      </span>
                    </button>

                    <ToggleGroup
                      type="single"
                      size="sm"
                      variant="outline"
                      spacing={0}
                      aria-label={t("plugins.itemPolicyTitle")}
                      value={policy}
                      onValueChange={(value) => {
                        if (value && value !== policy) {
                          onSavePluginPolicy(
                            plugin.id,
                            value as NonNullable<Plugin["updatePolicy"]>,
                          );
                        }
                      }}
                    >
                      {policyValues.map((value) => (
                        <ToggleGroupItem
                          key={value}
                          value={value}
                          className="text-xs"
                        >
                          {t(`updates.policy.${value}`)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {nextCommit && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            onPackageAction({
                              kind: "update",
                              plugin,
                              commit: nextCommit,
                            })
                          }
                        >
                          {t("plugins.reviewUpdate")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={autoApply.isPending}
                          onClick={() => autoApply.mutate(plugin)}
                        >
                          <ShieldCheck data-icon="inline-start" />
                          {t("plugins.autoApplySafe")}
                        </Button>
                      </>
                    )}
                    {check && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={check.isFetching}
                        onClick={() => void check.refetch()}
                      >
                        {t("plugins.checkUpdates")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        onPackageAction({ kind: "select", plugin })
                      }
                    >
                      {t("plugins.selectVersion")}
                    </Button>
                    {plugin.previous && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={releaseLabel(plugin.previous)}
                        onClick={() =>
                          onPackageAction({ kind: "rollback", plugin })
                        }
                      >
                        <RotateCcw data-icon="inline-start" />
                        {t("plugins.rollback")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {localPlugins.length > 0 && (
        <section className="plugins-panel panel-surface">
          <div className="plugins-panel-head">
            <div className="flex items-center gap-2">
              <FolderCode className="size-3.5 text-muted-foreground" />
              <h3>{t("plugins.localTracked")}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {localPlugins.length}
              </span>
            </div>
          </div>
          <div className="divide-y divide-border/60">
            {localPlugins.map((plugin) => (
              <div key={plugin.id} className="plugins-panel-row">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
                  onClick={() => onOpenPlugin(plugin.id)}
                >
                  <span className="plugins-mini-icon">
                    <PluginIcon plugin={plugin} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {pluginName(plugin, t)}
                    </span>
                    <code className="block truncate text-[11px] text-muted-foreground">
                      {plugin.directory}
                    </code>
                  </span>
                </button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reloadingId === plugin.id}
                  onClick={() => onReloadLocal(plugin.id)}
                >
                  <RefreshCw
                    data-icon="inline-start"
                    className={
                      reloadingId === plugin.id ? "animate-spin" : undefined
                    }
                  />
                  {t("plugins.reload")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
