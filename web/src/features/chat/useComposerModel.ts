import type { Catalog, ModelInfo, Selection } from "@/api/types.gen";
import {
  resolveEffort,
  type EffortSource,
} from "@/features/runtime/effortMapping";
import { useModels, useProviders } from "@/features/runtime/queries";

export function isModelUnavailable(
  selection: Selection,
  catalog: Catalog | null | undefined,
) {
  return (
    catalog === null ||
    (!!selection.model &&
      !!catalog &&
      !catalog.provisional &&
      !catalog.models.some(
        (model) => model.id === selection.model && !model.requiresVersion,
      ))
  );
}

export function selectedModel(choice: Selection, catalog?: Catalog | null) {
  const models = catalog?.models;
  return choice.model
    ? models?.find((model) => model.id === choice.model)
    : (models?.find((model) => model.default && !model.requiresVersion) ??
        models?.find((model) => !model.requiresVersion));
}

export function modelSelection(
  choice: Selection,
  model: ModelInfo,
  effortSource?: EffortSource,
): Selection {
  return {
    ...choice,
    model: model.id,
    effort: resolveEffort(effortSource ?? choice.effort, model),
    fast: choice.fast && model.fast,
  };
}

export function useComposerModel<T extends Selection>(
  candidate: T,
  cwd: string,
  profileFallback?: Selection,
  effortSource?: EffortSource,
) {
  const providers = useProviders();
  const runtimeUnavailable = (provider: string) =>
    providers.isSuccess &&
    !providers.data.some(
      (runtime) => runtime.id === provider && runtime.available,
    );
  const candidateUnavailable = runtimeUnavailable(candidate.provider);
  const candidateCatalog = useModels(
    candidate.provider,
    cwd,
    !!candidate.provider && !candidateUnavailable,
  );
  const useFallback =
    profileFallback &&
    (candidateUnavailable ||
      (candidateCatalog.isSuccess &&
        isModelUnavailable(candidate, candidateCatalog.data)));
  const choice = useFallback ? profileFallback : candidate;
  const activeEffortSource = useFallback ? undefined : effortSource;
  const differentProvider = choice.provider !== candidate.provider;
  const disabled = runtimeUnavailable(choice.provider);
  const fallbackCatalog = useModels(
    choice.provider,
    cwd,
    !!choice.provider && differentProvider && !disabled,
  );
  const catalog = differentProvider ? fallbackCatalog : candidateCatalog;
  const model = selectedModel(choice, catalog.data);
  const selection =
    model &&
    ((!choice.model && model.id) ||
      (!!activeEffortSource && !choice.effort) ||
      (profileFallback && !useFallback && !catalog.data?.provisional))
      ? modelSelection(choice, model, activeEffortSource)
      : choice;

  return {
    providers: providers.data,
    runtime: providers.data?.find((item) => item.id === choice.provider),
    catalog,
    model,
    selection,
    runtimeUnavailable: disabled,
    modelUnavailable: catalog.isSuccess && isModelUnavailable(choice, catalog.data),
    checkingPreference:
      !!profileFallback &&
      !useFallback &&
      (providers.isPending || catalog.isPending),
  };
}
