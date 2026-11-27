import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  Agent,
  ComparisonSelection,
  ProviderInfo,
  Selection,
} from "@/api/types.gen";
import { modelsQuery } from "@/features/runtime/queries";
import {
  agentProfileSelection,
  useAgentRuntimePreferences,
} from "@/features/runtime/runtimePreferences";
import { primaryDirectory } from "@/features/worktrees/scope";
import { modelSelection, selectedModel } from "./useComposerModel";

export function comparisonModelLabel(
  t: TFunction,
  runtime: string,
  choice: ComparisonSelection,
) {
  const model = [choice.modelName, choice.model].find(
    (value) => value && value.toLowerCase() !== "default",
  );
  const effort = choice.effort
    ? t("comparison.effort", {
        effort: t(`models.effort.${choice.effort}`, {
          defaultValue: choice.effort,
        }),
      })
    : t("comparison.runtimeEffort");
  return [
    runtime,
    model || t("comparison.unreportedModel"),
    effort,
    choice.fast && "Fast",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function useComparisonModels(
  agents: Agent[],
  selected: string[] | undefined,
  ownerId: string,
  ownerSelection: Selection,
  providers?: ProviderInfo[],
  options: {
    overrides?: Record<string, Selection>;
    submitted?: Record<string, ComparisonSelection>;
    sharedCwd?: string;
  } = {},
) {
  const { t } = useTranslation();
  const participants = selected ? agents : [];
  const preferences = useAgentRuntimePreferences(
    participants.map((agent) => agent.id),
  );
  const catalogs = new Map<
    string,
    ReturnType<typeof modelsQuery> & { enabled: boolean }
  >();
  const candidates = participants.map((agent, index) => {
    const preference = preferences[index];
    const profileSelection = agentProfileSelection(agent.profile);
    const provider = agent.profile.provider;
    const saved = options.submitted?.[agent.id];
    function selectionForProvider(
      provider: string,
      previous?: Selection,
    ): Selection {
      if (previous) return previous;
      if (agent.id === ownerId && provider === ownerSelection.provider)
        return ownerSelection;
      if (provider === agent.profile.provider) return profileSelection;
      return {
        provider,
        model: "",
        effort: "",
        fast: false,
        ...preference?.models[provider],
      };
    }
    const choice =
      saved ??
      options.overrides?.[agent.id] ??
      (agent.id === ownerId ? ownerSelection : selectionForProvider(provider));
    const runtime = providers?.find((item) => item.id === choice.provider);
    const cwd = options.sharedCwd ?? primaryDirectory(agent.profile);
    const key = JSON.stringify([choice.provider, cwd]);
    if (selected?.includes(agent.id)) {
      catalogs.set(key, {
        ...modelsQuery(choice.provider, cwd),
        enabled: !!runtime?.available && !saved,
      });
    }
    return { agent, choice, runtime, key, saved, cwd, selectionForProvider };
  });
  // Agents sharing a runtime and directory share its catalog discovery.
  const results = useQueries({ queries: [...catalogs.values()] });
  const byKey = new Map(
    [...catalogs.keys()].map((key, index) => [key, results[index]]),
  );
  return candidates.map(
    ({ agent, choice, runtime, key, saved, cwd, selectionForProvider }) => {
      const query = byKey.get(key);
      const model = selectedModel(choice, query?.data);
      let selection = saved;
      if (!selection && model && !model.requiresVersion) {
        const {
          provider,
          model: id,
          effort,
          fast,
          permission,
        } = modelSelection(choice, model);
        selection = {
          provider,
          model: id,
          effort,
          fast,
          permission,
          modelName: model.resolvedModel || model.name,
        };
      }
      const available = !agent.archived && !!runtime?.available;
      const runtimeName = runtime?.name ?? choice.provider;
      let label = [runtimeName, choice.model].filter(Boolean).join(" · ");
      if (selection) label = comparisonModelLabel(t, runtimeName, selection);
      else if (
        !available ||
        (query && !query.isPending && !query.data?.provisional)
      )
        label += ` · ${t("comparison.agentUnavailable")}`;
      else if (query) label += ` · ${t("common.loading")}`;
      else if (choice.model && choice.effort)
        label = comparisonModelLabel(t, runtimeName, choice);
      return {
        agent,
        available,
        selection,
        label,
        choice: selection ?? choice,
        catalog: query,
        cwd,
        selectionForProvider,
        capabilities: query?.data?.capabilities ?? runtime?.capabilities,
      };
    },
  );
}
