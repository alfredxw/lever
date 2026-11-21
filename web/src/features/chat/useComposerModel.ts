import type { Catalog, ModelInfo, Selection } from "@/api/types.gen";
import { useModels, useProviders } from "@/features/runtime/queries";

function unavailable(
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

export function modelSelection(choice: Selection, model: ModelInfo): Selection {
  return {
    ...choice,
    model: model.id,
    effort: model.efforts.includes(choice.effort)
      ? choice.effort
      : model.defaultEffort,
    fast: choice.fast && model.fast,
  };
}

export function useComposerModel(
  candidate: Selection,
  cwd: string,
  profileFallback?: Selection,
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
    !candidateUnavailable,
  );
  const useFallback =
    profileFallback &&
    (candidateUnavailable ||
      (candidateCatalog.isSuccess &&
        unavailable(candidate, candidateCatalog.data)));
  const choice = useFallback ? profileFallback : candidate;
  const differentProvider = choice.provider !== candidate.provider;
  const disabled = runtimeUnavailable(choice.provider);
  const fallbackCatalog = useModels(
    choice.provider,
    cwd,
    differentProvider && !disabled,
  );
  const catalog = differentProvider ? fallbackCatalog : candidateCatalog;
  const model = selectedModel(choice, catalog.data);
  const selection =
    model &&
    ((!choice.model && model.id) ||
      (profileFallback && !useFallback && !catalog.data?.provisional))
      ? modelSelection(choice, model)
      : choice;

  return {
    providers: providers.data,
    runtime: providers.data?.find((item) => item.id === choice.provider),
    catalog,
    model,
    selection,
    runtimeUnavailable: disabled,
    modelUnavailable: catalog.isSuccess && unavailable(choice, catalog.data),
    checkingPreference:
      !!profileFallback &&
      !useFallback &&
      (providers.isPending || catalog.isPending),
  };
}
