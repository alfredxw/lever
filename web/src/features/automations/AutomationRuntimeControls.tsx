import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  Catalog,
  Overview,
  ProviderInfo,
  Selection,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/features/chat/ModelPicker";
import {
  modelSelection,
  selectedModel,
  useComposerModel,
} from "@/features/chat/useComposerModel";
import {
  isAskPermission,
  recommendedUnattendedPermission,
  resolveAgentPermissionForCatalog,
} from "@/features/runtime/permissionMapping";
import { PermissionMenu, permissionLabel } from "@/features/runtime/Permissions";
import { modelsQuery, providersQuery } from "@/features/runtime/queries";
import {
  agentProfileSelection,
  selectionForAgentProvider,
  useRuntimePreferences,
} from "@/features/runtime/runtimePreferences";
import { primaryDirectory } from "@/features/worktrees/scope";

function resolveCandidate(agent: Agent, value?: Selection): Selection {
  const base = agentProfileSelection(agent.profile);
  if (!value) return { ...base, permission: "" };
  const provider = value.provider || base.provider;
  const sameProvider = provider === base.provider;
  const model = value.model || (sameProvider ? base.model : "");
  const sameModel = sameProvider && (!value.model || value.model === base.model);
  return {
    provider,
    model,
    permission: value.permission || "",
    effort: value.effort || (sameModel ? base.effort : ""),
    fast: value.fast ?? (sameModel ? base.fast : false),
  };
}

function fallbackPermissionForAgent(
  agent: Agent,
  catalog: Catalog | null | undefined,
  providerType?: string,
) {
  if (agent.profile.permission) {
    return resolveAgentPermissionForCatalog(
      agent.profile.permission,
      catalog,
      providerType,
    );
  }
  if (catalog?.defaultPermission) return catalog.defaultPermission;
  const defaultMode =
    queryClient.getQueryData<Overview>(["overview"])?.permissionSettings
      ?.defaultMode ?? "auto";
  if (
    providerType === "codex" ||
    providerType === "claude" ||
    providerType === "pi" ||
    providerType === "antigravity"
  ) {
    return resolveAgentPermissionForCatalog(
      defaultMode === "yolo" ? "full_access" : "auto",
      undefined,
      providerType,
    );
  }
  return "";
}

export function snapshotAgentSelection(
  agent: Agent,
  cwdOverride?: string,
): Selection {
  const cwd = cwdOverride ?? primaryDirectory(agent.profile);
  const base = agentProfileSelection(agent.profile);
  const providers = queryClient.getQueryData<ProviderInfo[]>(
    providersQuery.queryKey,
  );
  const runtime = providers?.find((item) => item.id === base.provider);
  const catalog = base.provider
    ? queryClient.getQueryData<Catalog | null>(
        modelsQuery(base.provider, cwd).queryKey,
      )
    : undefined;
  const model = selectedModel(base, catalog);
  const resolved =
    model && (!base.model || !catalog?.provisional)
      ? modelSelection(base, model)
      : base;
  const permission = fallbackPermissionForAgent(agent, catalog, runtime?.type);
  return {
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    fast: Boolean(resolved.fast),
    permission,
  };
}

export function lockAutomationSelection(
  agent: Agent | undefined,
  value?: Selection,
  cwdOverride?: string,
): Selection | undefined {
  if (!agent) return value;
  const cwd = cwdOverride ?? primaryDirectory(agent.profile);
  const candidate = resolveCandidate(agent, value);
  const providers = queryClient.getQueryData<ProviderInfo[]>(
    providersQuery.queryKey,
  );
  const runtime = providers?.find((item) => item.id === candidate.provider);
  const catalog = candidate.provider
    ? queryClient.getQueryData<Catalog | null>(
        modelsQuery(candidate.provider, cwd).queryKey,
      )
    : undefined;
  const model = selectedModel(candidate, catalog);
  const resolved =
    model && (!candidate.model || !catalog?.provisional)
      ? modelSelection(candidate, model)
      : candidate;
  const permission =
    candidate.permission ||
    fallbackPermissionForAgent(agent, catalog, runtime?.type);
  return {
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    fast: Boolean(resolved.fast),
    permission,
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
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview?scope=local"),
    enabled: !!agent,
  });
  const defaultPermissionMode =
    overview.data?.permissionSettings?.defaultMode ?? "auto";
  const cwd = cwdOverride ?? (agent ? primaryDirectory(agent.profile) : "");
  const candidate: Selection = agent
    ? resolveCandidate(agent, value)
    : { provider: "", model: "", permission: "", effort: "", fast: false };
  const modelState = useComposerModel(candidate, cwd);
  const effectivePermission =
    candidate.permission ||
    (agent
      ? resolveAgentPermissionForCatalog(
          agent.profile.permission,
          modelState.catalog.data,
          modelState.runtime?.type,
        )
      : "") ||
    modelState.catalog.data?.defaultPermission ||
    "";
  const askMode = Boolean(
    agent && isAskPermission(modelState.catalog.data, effectivePermission),
  );
  const recommended = recommendedUnattendedPermission(
    modelState.catalog.data,
    defaultPermissionMode,
  );
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
  lockOnReset = false,
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
  lockOnReset?: boolean;
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
  const agentLatest = snapshotAgentSelection(agent, cwd);
  const differsFromAgent =
    selection.provider !== agentLatest.provider ||
    selection.model !== agentLatest.model ||
    selection.effort !== agentLatest.effort ||
    Boolean(selection.fast) !== Boolean(agentLatest.fast) ||
    effectivePermission !== agentLatest.permission;
  const showSyncButton =
    showReset && (lockOnReset ? differsFromAgent : hasSelectionOverride(value));
  const recommendedLabel = recommended
    ? permissionLabel(t, runtime?.type, recommended.id, recommended.name)
    : undefined;

  function applyModel(next: Selection) {
    const providerChanged = next.provider !== candidate.provider;
    let nextPermission = value?.permission || effectivePermission;
    if (providerChanged) {
      const nextRuntime = providers?.find((item) => item.id === next.provider);
      const nextCatalog = queryClient.getQueryData<Catalog | null>(
        modelsQuery(next.provider, cwd).queryKey,
      );
      nextPermission = resolveAgentPermissionForCatalog(
        agent!.profile.permission,
        nextCatalog,
        nextRuntime?.type,
      );
    }
    onChange({
      provider: next.provider,
      model: next.model,
      effort: next.effort,
      fast: next.fast,
      permission: nextPermission,
    });
  }

  function applyPermission(nextPermission: string) {
    onChange({
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort,
      fast: Boolean(selection.fast),
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
          effortHabit={preferences?.effortHabit}
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
        {showSyncButton && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t("automations.resetRuntime")}
            title={t("automations.resetRuntime")}
            onClick={() =>
              onChange(
                lockOnReset ? snapshotAgentSelection(agent, cwd) : undefined,
              )
            }
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
