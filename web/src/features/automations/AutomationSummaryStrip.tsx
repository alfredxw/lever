import { useMutation } from "@tanstack/react-query";
import { ArrowRight, BellOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Agent, Automation, Selection } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import {
  isAskPermission,
  resolveAgentPermissionForCatalog,
} from "@/features/runtime/permissionMapping";
import { permissionLabel } from "@/features/runtime/Permissions";
import { AutomationPlanIcon } from "./AutomationPlanIcon";
import {
  AutomationAskWarning,
  hasSelectionOverride,
  useAutomationRuntime,
} from "./AutomationRuntimeControls";
import {
  automationInputFromPlan,
  automationPath,
  automationsQuery,
  deliveryModeOf,
  notifyPolicyOf,
  planTargets,
  type AutomationConfigSection,
} from "./automationsQuery";

export function usePlanConfigAttention(plan: Automation, agents: Agent[]) {
  const targets = planTargets(plan);
  const isMultiTarget = targets.length > 1;
  const primaryAgent = agents.find((a) => a.id === targets[0]?.agentId);
  const primaryRuntime = useAutomationRuntime(
    !isMultiTarget ? primaryAgent : undefined,
    plan.selection,
  );
  const multiTargetHasAsk =
    isMultiTarget &&
    targets.some((target) => {
      if (target.enabled === false) return false;
      const targetAgent = agents.find((a) => a.id === target.agentId);
      if (!targetAgent) return false;
      const effectiveSelection = target.selection ?? plan.selection;
      const perm =
        effectiveSelection?.permission ||
        resolveAgentPermissionForCatalog(targetAgent.profile.permission, undefined);
      return isAskPermission(undefined, perm);
    });

  return {
    targets,
    isMultiTarget,
    primaryAgent,
    primaryRuntime,
    multiTargetHasAsk,
    hasConfigAttention: Boolean(
      (!isMultiTarget && primaryRuntime.askMode) ||
        multiTargetHasAsk ||
        plan.error ||
        plan.sourceDisabled ||
        plan.sourceError,
    ),
  };
}

export function AutomationSummaryStrip({
  plan,
  agents,
  kind,
  timing,
  next,
  onOpenSection,
  onSaved,
}: {
  plan: Automation;
  agents: Agent[];
  kind: string;
  timing: string;
  next: string;
  onOpenSection: (section: AutomationConfigSection) => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const {
    targets,
    isMultiTarget,
    primaryAgent,
    primaryRuntime,
    multiTargetHasAsk,
  } = usePlanConfigAttention(plan, agents);

  const deliveryMode = deliveryModeOf(plan);
  const notifyPolicy = notifyPolicyOf(plan);
  const nextAt =
    plan.enabled && plan.nextAt ? new Date(plan.nextAt * 1000) : undefined;

  const quickFixPermission = useMutation({
    mutationFn: (selection: Selection) =>
      api<Automation>(
        `${automationPath}/${plan.id}`,
        automationInputFromPlan(plan, { selection }),
        "PUT",
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData<Automation[]>(
        automationsQuery.queryKey,
        (cached) =>
          cached?.map((item) =>
            item.id === saved.id ? { ...item, ...saved } : item,
          ),
      );
      void queryClient.invalidateQueries({
        queryKey: automationsQuery.queryKey,
      });
      onSaved();
    },
    onError: (error) => toast.error(error.message),
  });

  const runtimeSummary =
    !isMultiTarget && hasSelectionOverride(plan.selection)
      ? [
          primaryRuntime.model?.name ||
            plan.selection?.model ||
            primaryRuntime.runtime?.name,
          plan.selection?.effort,
          plan.selection?.permission
            ? permissionLabel(
                t,
                primaryRuntime.runtime?.type,
                plan.selection.permission,
              )
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  const hasAlerts = Boolean(
    (!isMultiTarget && primaryRuntime.askMode) ||
      multiTargetHasAsk ||
      plan.error ||
      plan.sourceDisabled ||
      plan.sourceError,
  );

  return (
    <div className="automation-summary-wrap">
      <div
        className="automation-summary-strip"
        role="region"
        aria-label={t("automations.summaryLabel")}
      >
        <button
          type="button"
          className="automation-summary-chip"
          title={
            nextAt
              ? nextAt.toLocaleString(i18n.language, {
                  dateStyle: "full",
                  timeStyle: "long",
                })
              : undefined
          }
          onClick={() => onOpenSection("trigger")}
        >
          <AutomationPlanIcon
            plan={plan}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">
            {plan.trigger.kind === "schedule" ? timing : `${kind} · ${timing}`}
          </span>
          <span className="automation-summary-muted" aria-hidden="true">
            ·
          </span>
          <span className="automation-summary-muted truncate">
            {plan.enabled ? next : t("automations.paused")}
          </span>
        </button>

        <span className="automation-summary-sep" aria-hidden="true">
          ·
        </span>

        <button
          type="button"
          className="automation-summary-chip"
          onClick={() => onOpenSection("targets")}
        >
          {isMultiTarget ? (
            <>
              <span className="automation-avatar-stack">
                {targets.slice(0, 4).map((target) => {
                  const targetAgent = agents.find(
                    (a) => a.id === target.agentId,
                  );
                  return targetAgent ? (
                    <AgentAvatar
                      key={target.id || target.agentId}
                      agent={targetAgent}
                      size="xs"
                    />
                  ) : null;
                })}
              </span>
              <span>
                {t("automations.targetCount", { count: targets.length })}
              </span>
            </>
          ) : (
            <>
              {primaryAgent && <AgentAvatar agent={primaryAgent} size="xs" />}
              <span className="truncate">
                {primaryAgent?.name ?? t("tasks.unassigned")}
              </span>
              {runtimeSummary && (
                <>
                  <span className="automation-summary-muted" aria-hidden="true">
                    ·
                  </span>
                  <span className="automation-summary-muted truncate">
                    {runtimeSummary}
                  </span>
                </>
              )}
            </>
          )}
        </button>

        <span className="automation-summary-sep" aria-hidden="true">
          ·
        </span>

        <button
          type="button"
          className="automation-summary-chip"
          onClick={() => onOpenSection("output")}
        >
          <span>{t("automations.delivery." + deliveryMode)}</span>
          <span className="automation-summary-muted" aria-hidden="true">
            ·
          </span>
          <span className="automation-summary-muted inline-flex items-center gap-1">
            {notifyPolicy === "silent" && (
              <BellOff className="size-3" aria-hidden="true" />
            )}
            <span>{t("automations.notify." + notifyPolicy)}</span>
          </span>
          {plan.workItem !== false && (
            <>
              <span className="automation-summary-muted" aria-hidden="true">
                ·
              </span>
              <span className="automation-summary-positive">
                {t("automations.boardOn")}
              </span>
            </>
          )}
        </button>

        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="automation-summary-action"
          onClick={() => onOpenSection("prompt")}
        >
          {t("automations.openConfig")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>

      {hasAlerts && (
        <div className="automation-alert-stack">
          {!isMultiTarget && primaryRuntime.askMode && (
            <AutomationAskWarning
              providerType={primaryRuntime.runtime?.type}
              recommendedLabel={
                primaryRuntime.recommended
                  ? permissionLabel(
                      t,
                      primaryRuntime.runtime?.type,
                      primaryRuntime.recommended.id,
                      primaryRuntime.recommended.name,
                    )
                  : undefined
              }
              disabled={quickFixPermission.isPending}
              onSwitch={
                primaryRuntime.recommended && primaryAgent
                  ? () => {
                      const nextSel: Selection = {
                        provider: primaryRuntime.selection.provider,
                        model: primaryRuntime.selection.model,
                        effort: primaryRuntime.selection.effort,
                        fast: Boolean(primaryRuntime.selection.fast),
                        permission: primaryRuntime.recommended!.id,
                      };
                      quickFixPermission.mutate(nextSel);
                    }
                  : undefined
              }
            />
          )}
          {multiTargetHasAsk && (
            <AutomationAskWarning
              disabled={false}
              recommendedLabel={t("automations.editInConfig")}
              onSwitch={() => onOpenSection("targets")}
            />
          )}
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
        </div>
      )}
    </div>
  );
}
