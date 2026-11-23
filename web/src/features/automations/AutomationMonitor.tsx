import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Play, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  Automation,
  AutomationInput,
  AutomationRun,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import {
  automationPath,
  automationsQuery,
  cleanSummaryText,
  deliveryModeOf,
  formatCompactTime,
  isSilentOutcome,
  notifyPolicyOf,
  planTargets,
  type NotifyPolicy,
} from "./automationsQuery";
import { AutomationPlanIcon } from "./AutomationPlanIcon";
import { AutomationRunStatusPill } from "./AutomationRunCard";
import { AutomationRunControls } from "./AutomationRunControls";
import { AutomationSparkline } from "./AutomationSparkline";

export function AutomationMonitor({
  rows,
  allRuns,
  agents,
  attentionPlanIds,
  onOpenPlan,
  onOpenRun,
  onRunNow,
  onCreate,
}: {
  rows: { plan: Automation; kind: string; timing: string; next: string }[];
  allRuns: AutomationRun[];
  agents: Agent[];
  attentionPlanIds: ReadonlySet<string>;
  onOpenPlan: (id: string) => void;
  onOpenRun: (planId: string, runId: string) => void;
  onRunNow: (planId: string) => void;
  onCreate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<"all" | "silent" | "attention">("all");

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`${automationPath}/${id}`, { enabled }, "PATCH"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: automationsQuery.queryKey }),
    onError: (error) => toast.error(error.message),
  });

  const changeNotify = useMutation({
    mutationFn: ({
      plan,
      notifyPolicy,
    }: {
      plan: Automation;
      notifyPolicy: NotifyPolicy;
    }) => {
      const input: AutomationInput = {
        name: plan.name,
        prompt: plan.prompt,
        trigger: plan.trigger,
        destination: plan.destination,
        selection: plan.selection,
        targets: plan.targets,
        notifyPolicy,
        deliveryMode: plan.deliveryMode,
        workItem: plan.workItem,
        quiet: notifyPolicy === "silent",
      };
      return api<Automation>(`${automationPath}/${plan.id}`, input, "PUT");
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Automation[]>(
        automationsQuery.queryKey,
        (cached) =>
          cached?.map((item) =>
            item.id === saved.id ? { ...item, ...saved } : item,
          ),
      );
      toast.success(t("automations.autoSaved"));
    },
    onError: (error) => toast.error(error.message),
  });

  const activeCount = rows.filter(({ plan }) => plan.enabled).length;
  const multiTargetCount = rows.filter(
    ({ plan }) => planTargets(plan).length > 1,
  ).length;
  const silentPlans = rows.filter(
    ({ plan }) => notifyPolicyOf(plan) === "silent",
  );
  const silentRunsCount = allRuns.filter((run) => {
    const plan = rows.find((r) => r.plan.id === run.automationId)?.plan;
    return isSilentOutcome(run, plan);
  }).length;
  const linkedWorkItemCount = allRuns.reduce(
    (sum, run) => sum + (run.workItemIds?.length ?? 0),
    0,
  );
  const attentionCount = rows.filter(({ plan }) =>
    attentionPlanIds.has(plan.id),
  ).length;
  const linkedPRCount = new Set(
    allRuns.flatMap(
      (run) =>
        run.pullRequests?.map(
          (pr) => `${pr.repository.toLowerCase()}#${pr.number}`,
        ) ?? [],
    ),
  ).size;

  const latestByPlan = new Map<string, AutomationRun>();
  for (const run of allRuns) {
    if (!latestByPlan.has(run.automationId))
      latestByPlan.set(run.automationId, run);
  }

  const visible = rows.filter(({ plan }) => {
    if (filter === "silent") return notifyPolicyOf(plan) === "silent";
    if (filter === "attention") return attentionPlanIds.has(plan.id);
    return true;
  });

  return (
    <div className="automation-monitor-stage">
      <header className="automation-stage-header">
        <div className="automation-stage-title">
          <Activity
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2>{t("automations.monitor")}</h2>
          <span className="automation-stage-sub truncate">
            {t("automations.monitorHint")}
          </span>
        </div>
        <div className="automation-stage-actions">
          <ToggleGroup
            type="single"
            size="sm"
            className="automation-segmented"
            spacing={0}
            value={filter}
            onValueChange={(value) => {
              if (value) setFilter(value as typeof filter);
            }}
          >
            <ToggleGroupItem value="all">
              {t("automations.monitorAll")} ({rows.length})
            </ToggleGroupItem>
            <ToggleGroupItem value="silent">
              {t("automations.monitorSilent")} ({silentPlans.length})
            </ToggleGroupItem>
            <ToggleGroupItem value="attention">
              {t("automations.monitorAttention")} ({attentionCount})
            </ToggleGroupItem>
          </ToggleGroup>
          <Button size="xs" onClick={onCreate}>
            <Plus data-icon="inline-start" />
            {t("automations.create")}
          </Button>
        </div>
      </header>

      <div className="automation-monitor-scroll">
        <div className="automation-monitor-inner">
          <div className="automation-kpi-strip">
            <div className="automation-kpi-card">
              <div className="automation-kpi-k">
                {t("automations.kpiActive")}
              </div>
              <div className="automation-kpi-v tabular-nums">
                {activeCount}
                <span> / {rows.length}</span>
              </div>
              <div className="automation-kpi-s">
                {t("automations.kpiActiveSub", { count: multiTargetCount })}
              </div>
            </div>
            <div className="automation-kpi-card">
              <div className="automation-kpi-k">
                {t("automations.kpiSilent")}
              </div>
              <div className="automation-kpi-v tabular-nums">
                {silentPlans.length}
              </div>
              <div className="automation-kpi-s">
                {t("automations.kpiSilentSub", { count: silentRunsCount })}
              </div>
            </div>
            <div className="automation-kpi-card">
              <div className="automation-kpi-k">{t("automations.kpiRuns")}</div>
              <div className="automation-kpi-v tabular-nums">
                {allRuns.length}
              </div>
              <div className="automation-kpi-s">
                {t("automations.kpiRunsSub", { count: linkedWorkItemCount })}
                {linkedPRCount > 0 && ` · ${linkedPRCount} PR`}
              </div>
            </div>
            <div className="automation-kpi-card">
              <div className="automation-kpi-k">
                {t("automations.kpiAttention")}
              </div>
              <div
                className="automation-kpi-v tabular-nums"
                data-tone={attentionCount ? "attention" : "positive"}
              >
                {attentionCount}
              </div>
              <div className="automation-kpi-s">
                {t(
                  attentionCount
                    ? "automations.kpiAttentionSub"
                    : "automations.kpiAttentionClear",
                )}
              </div>
            </div>
          </div>

          <div className="automation-monitor-table-wrap">
            <table className="automation-monitor-table">
              <colgroup>
                <col style={{ width: "26%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "11%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>{t("automations.colPlan")}</th>
                  <th>{t("automations.colTargets")}</th>
                  <th>{t("automations.colNotify")}</th>
                  <th>{t("automations.colPulse")}</th>
                  <th>{t("automations.colLatest")}</th>
                  <th className="text-right">{t("automations.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ plan, kind, timing }) => {
                  const targets = planTargets(plan);
                  const firstAgent = agents.find(
                    (a) => a.id === targets[0]?.agentId,
                  );
                  const policy = notifyPolicyOf(plan);
                  const delivery = deliveryModeOf(plan);
                  const latest = latestByPlan.get(plan.id);
                  return (
                    <tr key={plan.id}>
                      <td>
                        <button
                          type="button"
                          className="automation-monitor-plan-btn"
                          onClick={() => onOpenPlan(plan.id)}
                        >
                          <AutomationPlanIcon plan={plan} />
                          <span className="min-w-0 text-left">
                            <span className="block truncate font-semibold text-foreground">
                              {plan.name}
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {plan.trigger.kind === "schedule" ? timing : kind}{" "}
                              · {t("automations.delivery." + delivery)}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td>
                        {targets.length <= 1 ? (
                          <div className="flex items-center gap-1.5">
                            {firstAgent && (
                              <AgentAvatar agent={firstAgent} size="xs" />
                            )}
                            <span className="truncate text-xs">
                              {firstAgent?.name ?? t("tasks.unassigned")}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span className="automation-avatar-stack">
                              {targets.slice(0, 3).map((target) => {
                                const ag = agents.find(
                                  (a) => a.id === target.agentId,
                                );
                                return ag ? (
                                  <AgentAvatar
                                    key={target.id || target.agentId}
                                    agent={ag}
                                    size="xs"
                                  />
                                ) : null;
                              })}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {t("automations.targetCount", {
                                count: targets.length,
                              })}
                            </span>
                          </div>
                        )}
                      </td>
                      <td>
                        <Select
                          value={policy}
                          disabled={changeNotify.isPending}
                          onValueChange={(value) =>
                            changeNotify.mutate({
                              plan,
                              notifyPolicy: value as NotifyPolicy,
                            })
                          }
                        >
                          <SelectTrigger className="h-7 w-[138px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent position="popper">
                            {(["always", "actionable", "silent"] as const).map(
                              (id) => (
                                <SelectItem key={id} value={id}>
                                  {t("automations.notify." + id)}
                                </SelectItem>
                              ),
                            )}
                          </SelectContent>
                        </Select>
                      </td>
                      <td>
                        <AutomationSparkline
                          runs={plan.recentRuns}
                          silentPlan={policy === "silent"}
                        />
                      </td>
                      <td>
                        {latest ? (
                          <button
                            type="button"
                            className="automation-monitor-latest"
                            onClick={() => onOpenRun(plan.id, latest.id)}
                          >
                            <div className="flex items-center gap-1.5">
                              <AutomationRunStatusPill
                                status={latest.status}
                                silent={isSilentOutcome(latest, plan)}
                              />
                              {targets.length > 1 && <span className="truncate">{agents.find((agent) => agent.id === latest.agentId)?.name}</span>}
                              <time
                                className="text-[11px] text-muted-foreground tabular-nums"
                                dateTime={latest.createdAt}
                                title={new Date(
                                  latest.createdAt,
                                ).toLocaleString(i18n.language)}
                              >
                                {formatCompactTime(
                                  latest.createdAt,
                                  i18n.language,
                                )}
                              </time>
                            </div>
                            {latest.summary && (
                              <span className="block w-full truncate text-[11px] text-muted-foreground">
                                {cleanSummaryText(latest.summary)}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t("automations.noRuns")}
                          </span>
                        )}
                        {latest?.execution?.runId && (
                          <AutomationRunControls id={latest.execution.runId} status={latest.status} canPause={latest.canPause} />
                        )}
                      </td>
                      <td className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {plan.trigger.kind === "schedule" && (
                            <Button
                              size="icon-xs"
                              variant="outline"
                              aria-label={t("automations.runNow")}
                              title={t("automations.runNow")}
                              onClick={() => onRunNow(plan.id)}
                            >
                              <Play />
                            </Button>
                          )}
                          <Switch
                            size="sm"
                            checked={plan.enabled}
                            disabled={toggleEnabled.isPending}
                            aria-label={t("automations.toggle", {
                              name: plan.name,
                            })}
                            onCheckedChange={(enabled) =>
                              toggleEnabled.mutate({ id: plan.id, enabled })
                            }
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
