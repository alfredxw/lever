import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Ellipsis, Play } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Automation } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
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
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { AutomationPlanIcon } from "./AutomationPlanIcon";
import {
  automationPath,
  automationsQuery,
  type AutomationPlanTab,
} from "./automationsQuery";

export function AutomationPlanHeader({
  plan,
  tab,
  runCount,
  hasConfigAttention,
  busy,
  savedNotice,
  onRunNow,
  onArchived,
}: {
  plan: Automation;
  tab: AutomationPlanTab;
  runCount: number;
  hasConfigAttention: boolean;
  busy: boolean;
  savedNotice: boolean;
  onRunNow: () => void;
  onArchived: () => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const [archiving, setArchiving] = useState(false);

  const path = `${automationPath}/${plan.id}`;

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => api(path, { enabled }, "PATCH"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: automationsQuery.queryKey }),
    onError: (error) => toast.error(error.message),
  });

  const archivePlan = useMutation({
    mutationFn: () => api(path, {}, "DELETE"),
    onSuccess: () => {
      setArchiving(false);
      onArchived();
      void queryClient.invalidateQueries({
        queryKey: automationsQuery.queryKey,
      });
      void queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
    },
  });

  const indicatorTransition = reducedMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.23, 1, 0.32, 1] as const };

  return (
    <div className="automation-plan-head-wrap">
      <header className="automation-stage-header">
        <div className="automation-stage-title min-w-0 flex-1">
          <AutomationPlanIcon
            plan={plan}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <h2 className="min-w-0 truncate" title={plan.name}>
            {plan.name}
          </h2>
          {savedNotice && (
            <span className="automation-saved-tag" role="status">
              <Check className="size-3" aria-hidden="true" />
              {t("automations.autoSaved")}
            </span>
          )}
        </div>
        <div className="automation-stage-actions">
          {plan.trigger.kind === "schedule" && (
            <Button
              size="xs"
              aria-label={t("automations.runNow")}
              title={t("automations.runNow")}
              disabled={busy}
              onClick={onRunNow}
            >
              <Play data-icon="inline-start" />
              <span>{t("automations.runNow")}</span>
            </Button>
          )}
          <Switch
            size="sm"
            checked={plan.enabled}
            disabled={toggleEnabled.isPending}
            aria-label={t("automations.toggle", { name: plan.name })}
            onCheckedChange={(enabled) => toggleEnabled.mutate(enabled)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("automations.actions")}
                disabled={archivePlan.isPending}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  archivePlan.reset();
                  setArchiving(true);
                }}
              >
                {t("automations.archive")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="automation-plan-tabs-bar">
        <TabsList
          variant="line"
          className="automation-plan-tabs-list"
          aria-label={t("automations.planViews")}
        >
          <TabsTrigger value="runs" className="automation-plan-tab">
            <span>{t("automations.tabRuns")}</span>
            {runCount > 0 && (
              <span className="automation-plan-tab-count tabular-nums">
                {runCount}
              </span>
            )}
            {tab === "runs" && (
              <motion.span
                layoutId={`automation-tab-indicator-${plan.id}`}
                className="automation-plan-tab-indicator"
                transition={indicatorTransition}
                aria-hidden="true"
              />
            )}
          </TabsTrigger>
          <TabsTrigger value="config" className="automation-plan-tab">
            <span>{t("automations.tabConfig")}</span>
            {hasConfigAttention && (
              <span
                className="automation-dot"
                data-tone="attention"
                aria-hidden="true"
              />
            )}
            {tab === "config" && (
              <motion.span
                layoutId={`automation-tab-indicator-${plan.id}`}
                className="automation-plan-tab-indicator"
                transition={indicatorTransition}
                aria-hidden="true"
              />
            )}
          </TabsTrigger>
        </TabsList>
      </div>

      {archiving && (
        <Dialog
          open
          onOpenChange={(open) =>
            !open && !archivePlan.isPending && setArchiving(false)
          }
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("automations.archive")}</DialogTitle>
              <DialogDescription>
                {t("automations.archiveConfirm", { name: plan.name })}
              </DialogDescription>
            </DialogHeader>
            {archivePlan.error && <ErrorNotice error={archivePlan.error} />}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={archivePlan.isPending}
                onClick={() => setArchiving(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={archivePlan.isPending}
                onClick={() => archivePlan.mutate()}
              >
                {t("automations.archive")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
