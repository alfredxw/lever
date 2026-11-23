import { useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Agent, Selection } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useComposerModel } from "@/features/chat/useComposerModel";
import {
  isAskPermission,
  recommendedUnattendedPermission,
} from "@/features/runtime/permissionMapping";
import { PermissionMenu, permissionLabel } from "@/features/runtime/Permissions";
import {
  selectionForAgentProvider,
  useRuntimePreferences,
} from "@/features/runtime/runtimePreferences";
import { primaryDirectory } from "@/features/worktrees/scope";

function resolveCandidate(agent: Agent, value?: Selection): Selection {
  const base: Selection = {
    provider: agent.profile.provider,
    model: agent.profile.model,
    permission: agent.profile.permission,
    effort: "",
    fast: false,
  };
  if (!value) return base;
  const provider = value.provider || base.provider;
  const sameProvider = provider === base.provider;
  return {
    provider,
    model: value.model || (sameProvider ? base.model : ""),
    permission: value.permission || (sameProvider ? base.permission : ""),
    effort: value.effort || "",
    fast: Boolean(value.fast),
  };
}

export function hasSelectionOverride(value?: Selection): boolean {
  if (!value) return false;
  return Boolean(
    value.provider ||
      value.model ||
      value.permission ||
      value.effort ||
      value.fast,
  );
}

export function useAutomationRuntime(
  agent: Agent | undefined,
  value?: Selection,
  cwdOverride?: string,
) {
  const cwd = cwdOverride ?? (agent ? primaryDirectory(agent.profile) : "");
  const candidate: Selection = agent
    ? resolveCandidate(agent, value)
    : { provider: "", model: "", permission: "", effort: "", fast: false };
  const modelState = useComposerModel(candidate, cwd);
  const effectivePermission =
    candidate.permission || modelState.catalog.data?.defaultPermission || "";
  const askMode = Boolean(
    agent && isAskPermission(modelState.catalog.data, effectivePermission),
  );
  const recommended = recommendedUnattendedPermission(modelState.catalog.data);
  return {
    ...modelState,
    cwd,
    candidate,
    effectivePermission,
    askMode,
    recommended,
  };
}

export function AutomationAskWarning({
  providerType,
  recommendedLabel,
  onSwitch,
  disabled,
  compact,
}: {
  providerType?: string;
  recommendedLabel?: string;
  onSwitch?: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="automation-ask-warning"
      data-compact={compact || undefined}
      role="status"
      data-provider-type={providerType}
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {t(
          compact
            ? "automations.askPermissionShort"
            : "automations.askPermissionWarning",
        )}
      </span>
      {recommendedLabel && onSwitch && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          className="automation-ask-switch-btn shrink-0"
          onClick={onSwitch}
        >
          {t("automations.switchPermissionTo", { mode: recommendedLabel })}
        </Button>
      )}
    </div>
  );
}

export function AutomationRuntimeControls({
  agent,
  cwd: cwdOverride,
  value,
  onChange,
  disabled,
  compact,
  showWarning = true,
  showReset = true,
  idPrefix,
}: {
  agent?: Agent;
  cwd?: string;
  value?: Selection;
  onChange: (next?: Selection) => void;
  disabled?: boolean;
  compact?: boolean;
  showWarning?: boolean;
  showReset?: boolean;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const [modelOpen, setModelOpen] = useState(false);
  const preferences = useRuntimePreferences(agent?.id ?? "");
  const {
    providers,
    runtime,
    catalog,
    selection,
    cwd,
    candidate,
    effectivePermission,
    askMode,
    recommended,
    runtimeUnavailable,
    modelUnavailable,
  } = useAutomationRuntime(agent, value, cwdOverride);

  if (!agent) return null;

  const preferFavorites =
    preferences?.favoriteSelections?.[selection.provider] === selection.model;
  const overridden = hasSelectionOverride(value);
  const recommendedLabel = recommended
    ? permissionLabel(t, runtime?.type, recommended.id, recommended.name)
    : undefined;

  function applyModel(next: Selection) {
    const providerChanged = next.provider !== candidate.provider;
    onChange({
      provider: next.provider,
      model: next.model,
      effort: next.effort,
      fast: next.fast,
      permission: providerChanged ? "" : (value?.permission ?? ""),
    });
  }

  function applyPermission(nextPermission: string) {
    const nextProvider = value?.provider || agent!.profile.provider;
    const isAgentDefault =
      !value?.model &&
      !value?.effort &&
      !value?.fast &&
      nextProvider === agent!.profile.provider &&
      nextPermission === agent!.profile.permission;
    if (isAgentDefault) {
      onChange(undefined);
      return;
    }
    onChange({
      provider: nextProvider,
      model: value?.model ?? "",
      effort: value?.effort ?? "",
      fast: Boolean(value?.fast),
      permission: nextPermission,
    });
  }

  const runtimeError = runtimeUnavailable
    ? t("composer.runtimeDisabled")
    : modelUnavailable
      ? t("composer.modelUnavailable")
      : "";

  return (
    <>
      <div
        className="automation-runtime-controls"
        data-compact={compact || undefined}
      >
        <ModelPicker
          key={`${agent.id}:${selection.provider}`}
          providers={providers}
          catalog={catalog}
          cwd={cwd}
          open={modelOpen}
          onOpenChange={setModelOpen}
          value={selection}
          preferFavorites={preferFavorites}
          selectionForProvider={(provider, previous) =>
            selectionForAgentProvider(
              agent.profile,
              provider,
              preferences,
              previous,
            )
          }
          onChange={applyModel}
          disabled={disabled}
        />
        <PermissionMenu
          id={idPrefix ? `${idPrefix}-permission` : undefined}
          providerType={runtime?.type}
          permissions={catalog.data?.permissions}
          legacyPermissions={catalog.data?.legacyPermissions}
          value={effectivePermission}
          onChange={applyPermission}
          disabled={disabled}
          nextTurn={false}
          showLabel
          compact={compact}
          side="bottom"
          align="end"
          className="automation-permission-trigger"
        />
        {showReset && overridden && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t("automations.resetRuntime")}
            title={t("automations.resetRuntime")}
            onClick={() => onChange(undefined)}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
      {runtimeError && (
        <p className="automation-runtime-full text-xs text-destructive" role="alert">
          {runtimeError}
        </p>
      )}
      {showWarning && askMode && (
        <div className="automation-runtime-full">
          <AutomationAskWarning
            providerType={runtime?.type}
            recommendedLabel={recommendedLabel}
            disabled={disabled}
            compact={compact}
            onSwitch={
              recommended ? () => applyPermission(recommended.id) : undefined
            }
          />
        </div>
      )}
    </>
  );
}
