import { useId } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Download,
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  SkillSubscription,
  SkillSubscriptionSyncResult,
  UpdateSettings,
} from "@/api/types.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { skillsQuery, skillSubscriptionsQuery } from "./skillsQuery";

const policyValues = ["inherit", "auto", "notify", "manual"] as const;
const modes: UpdateSettings["mode"][] = ["auto", "notify", "manual"];
const intervals: UpdateSettings["interval"][] = ["1h", "6h", "24h"];

export function SkillSubscriptionsView({
  subscriptions,
  settings,
  settingsPending,
  onSaveSettings,
  onAddSubscription,
  onBack,
}: {
  subscriptions: SkillSubscription[];
  settings: UpdateSettings;
  settingsPending: boolean;
  onSaveSettings: (next: UpdateSettings) => void;
  onAddSubscription: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const modeId = useId();
  const intervalId = useId();

  const invalidate = () => {
    void queryClient.invalidateQueries(skillSubscriptionsQuery);
    void queryClient.invalidateQueries(skillsQuery);
  };

  const updatePolicy = useMutation({
    mutationFn: ({
      id,
      updatePolicy,
    }: {
      id: string;
      updatePolicy: SkillSubscription["updatePolicy"];
    }) =>
      api<SkillSubscription>(
        `/skill-subscriptions/${id}`,
        { updatePolicy },
        "PUT",
      ),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });

  const checkOne = useMutation({
    mutationFn: (id: string) =>
      api<SkillSubscription>(`/skill-subscriptions/${id}/check`, {}),
    onSuccess: (sub) => {
      invalidate();
      if (sub.available) {
        toast.info(t("skills.updateAvailableBadge"));
      } else {
        toast.success(t("updates.upToDate"));
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const checkAll = useMutation({
    mutationFn: async () => {
      for (const sub of subscriptions) {
        await api<SkillSubscription>(`/skill-subscriptions/${sub.id}/check`, {});
      }
    },
    onSuccess: () => {
      invalidate();
      toast.success(t("updates.checkAll"));
    },
    onError: (error) => toast.error(error.message),
  });

  const syncOne = useMutation({
    mutationFn: (id: string) =>
      api<SkillSubscriptionSyncResult>(`/skill-subscriptions/${id}/sync`, {}),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        t("skills.syncResult", {
          added: result.added,
          updated: result.updated,
        }),
      );
      if (result.skippedModified > 0) {
        toast.info(t("skills.syncSkipped", { count: result.skippedModified }));
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const removeOne = useMutation({
    mutationFn: (id: string) =>
      api(`/skill-subscriptions/${id}`, {}, "DELETE"),
    onSuccess: () => {
      invalidate();
      toast.success(t("skills.subscriptionRemoved"));
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="skills-overview" aria-label={t("skills.subscriptions")}>
      <div className="skills-overview-inner skills-subscriptions-inner">
        <Button
          variant="ghost"
          size="sm"
          className="mb-3 self-start"
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" />
          {t("common.overview")}
        </Button>

        <header className="skills-overview-header">
          <div className="min-w-0 flex-1">
            <h2>{t("skills.subscriptions")}</h2>
            <p className="skills-overview-subtitle">
              {t("skills.subscriptionsSubtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {subscriptions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={checkAll.isPending}
                onClick={() => checkAll.mutate()}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={checkAll.isPending ? "animate-spin" : undefined}
                />
                {t("updates.checkAll")}
              </Button>
            )}
            <Button size="sm" onClick={onAddSubscription}>
              <Plus data-icon="inline-start" />
              {t("skills.addSubscription")}
            </Button>
          </div>
        </header>

        <div className="flex flex-col gap-5">
          <section className="skills-panel panel-surface">
            <div className="skills-panel-head">
              <h3>{t("updates.globalTitle")}</h3>
            </div>
            <div className="divide-y divide-border/60">
              <div className="skills-panel-row flex-wrap">
                <div className="min-w-0 flex-1">
                  <div id={modeId} className="text-[13px] font-medium">
                    {t("updates.mode")}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("updates.skillAutoHint")}
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
                <div className="skills-panel-row flex-wrap">
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

          <section className="skills-panel panel-surface">
            <div className="skills-panel-head">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3.5 text-muted-foreground" />
                <h3>{t("skills.subscribedGroup")}</h3>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {subscriptions.length}
                </span>
              </div>
            </div>

            {subscriptions.length === 0 ? (
              <div className="flex flex-col items-start gap-3 px-4 py-6 text-xs text-muted-foreground">
                <p>{t("skills.noSubscriptions")}</p>
                <Button size="sm" variant="outline" onClick={onAddSubscription}>
                  <Plus data-icon="inline-start" />
                  {t("skills.addSubscription")}
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {subscriptions.map((sub) => {
                  const checkedText = sub.lastCheckedAt
                    ? new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: "short",
                        timeStyle: "short",
                      }).format(new Date(sub.lastCheckedAt))
                    : undefined;
                  const busy =
                    (checkOne.isPending && checkOne.variables === sub.id) ||
                    (syncOne.isPending && syncOne.variables === sub.id) ||
                    (removeOne.isPending && removeOne.variables === sub.id);
                  return (
                    <div
                      key={sub.id}
                      className="flex flex-col gap-3 px-4 py-3.5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13.5px] font-semibold text-foreground">
                              {sub.name}
                            </span>
                            <Badge
                              variant="outline"
                              className="h-5 px-1.5 text-[11px] font-normal tabular-nums"
                            >
                              {sub.skillCount} Skills
                            </Badge>
                            {sub.available ? (
                              <span
                                className="skills-pill"
                                data-tone="running"
                              >
                                {t("skills.updateAvailableBadge")}
                                {sub.availableCommit
                                  ? ` · ${sub.availableCommit.slice(0, 7)}`
                                  : ""}
                              </span>
                            ) : (
                              <span className="skills-pill" data-tone="muted">
                                {t("updates.upToDate")}
                              </span>
                            )}
                            {!!sub.modifiedCount && (
                              <span
                                className="skills-pill"
                                data-tone="attention"
                              >
                                {t("skills.modifiedCount", {
                                  count: sub.modifiedCount,
                                })}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                            {sub.source.url}
                            {sub.source.path ? `/${sub.source.path}` : ""} ·{" "}
                            {sub.source.ref} ({sub.commit.slice(0, 8)})
                          </p>
                          {checkedText && (
                            <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                              {t("skills.lastChecked", { time: checkedText })}
                            </p>
                          )}
                          {sub.error && (
                            <p className="mt-1 text-xs text-destructive">
                              {sub.error}
                            </p>
                          )}
                        </div>

                        <ToggleGroup
                          type="single"
                          size="sm"
                          variant="outline"
                          spacing={0}
                          aria-label={t("updates.policy")}
                          value={sub.updatePolicy || "inherit"}
                          disabled={updatePolicy.isPending}
                          onValueChange={(value) => {
                            if (value && value !== sub.updatePolicy) {
                              updatePolicy.mutate({
                                id: sub.id,
                                updatePolicy:
                                  value as SkillSubscription["updatePolicy"],
                              });
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
                        <Button
                          size="sm"
                          variant={sub.available ? "default" : "outline"}
                          disabled={busy}
                          onClick={() => syncOne.mutate(sub.id)}
                        >
                          <Download data-icon="inline-start" />
                          {t("skills.syncNow")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => checkOne.mutate(sub.id)}
                        >
                          <RefreshCw
                            data-icon="inline-start"
                            className={
                              checkOne.isPending &&
                              checkOne.variables === sub.id
                                ? "animate-spin"
                                : undefined
                            }
                          />
                          {t("skills.checkNow")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ms-auto text-muted-foreground hover:text-destructive"
                          disabled={busy}
                          onClick={() => removeOne.mutate(sub.id)}
                        >
                          <Trash2 data-icon="inline-start" />
                          {t("skills.removeSubscription")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
