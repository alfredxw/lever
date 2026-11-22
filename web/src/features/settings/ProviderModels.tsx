import { useId, useState } from "react";
import { useMutation, type UseQueryResult } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RefreshCw, Search, Star } from "lucide-react";
import type { Catalog, ProviderInfo } from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  modelDescription,
  modelSearchAliases,
} from "@/features/runtime/modelLabels";
import { setModelVisibility } from "@/features/runtime/queries";
import { useStarredModels } from "@/features/runtime/runtimePreferences";
import { SettingsRow } from "./SettingsControls";

export function ProviderModels({
  provider,
  catalog,
  onRefresh,
}: {
  provider: ProviderInfo;
  catalog: UseQueryResult<Catalog | null>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [search, setSearch] = useState("");
  const { starred, toggleStar } = useStarredModels(provider.id);
  const models = catalog.data?.models ?? [];
  const hidden = new Set(provider.hiddenModels);
  const query = search.trim().toLocaleLowerCase();
  const matching = models.filter((model) =>
    [model.name, ...modelSearchAliases(model)]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
  const visibleCount = models.filter(({ id }) => !hidden.has(id)).length;
  const showAll = visibleCount < models.length;
  const save = useMutation({
    mutationFn: ({ ids, visible }: { ids: string[]; visible: boolean }) =>
      setModelVisibility(provider.id, ids, visible),
  });
  return (
    <section className="provider-section provider-models" aria-labelledby={id}>
      <header className="provider-model-heading">
        <div className="provider-model-title">
          <h3 id={id}>{t("providers.models")}</h3>
          {!!models.length && (
            <span className="provider-model-count">
              {t("providers.modelsVisible", {
                visible: visibleCount,
                total: models.length,
              })}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={catalog.isFetching}
          aria-label={t("models.refresh")}
          title={t("models.refresh")}
          onClick={onRefresh}
        >
          <RefreshCw
            data-icon="inline-start"
            className={catalog.isFetching ? "animate-spin" : undefined}
          />
          <span>{t("models.refresh")}</span>
        </Button>
      </header>
      <div className="panel-surface">
        {catalog.isPending && catalog.isFetching && (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
        {(catalog.error || save.error) && (
          <div className="p-3">
            {catalog.error && (
              <ErrorNotice error={catalog.error} retry={onRefresh} />
            )}
            {save.error && <ErrorNotice error={save.error} />}
          </div>
        )}
        {!!models.length && (
          <div className="provider-model-toolbar">
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label={t("models.search")}
                placeholder={t("models.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </InputGroup>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  ids: models.map(({ id }) => id),
                  visible: showAll,
                })
              }
            >
              {t(
                showAll ? "providers.showAllModels" : "providers.hideAllModels",
              )}
            </Button>
          </div>
        )}
        <div className="provider-model-list settings-group">
          {matching.map((model) => (
            <SettingsRow
              key={model.id}
              title={
                <span className="[overflow-wrap:anywhere]">{model.name}</span>
              }
              description={modelDescription(t, model, provider.name)}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("models.star", { model: model.name })}
                aria-pressed={starred.has(model.id)}
                onClick={() => toggleStar(model.id)}
              >
                <Star fill={starred.has(model.id) ? "currentColor" : "none"} />
              </Button>
              <Switch
                aria-label={t("providers.showModel", { model: model.name })}
                checked={!hidden.has(model.id)}
                disabled={save.isPending}
                onCheckedChange={(visible) =>
                  save.mutate({ ids: [model.id], visible })
                }
              />
            </SettingsRow>
          ))}
        </div>
        {!catalog.isFetching && !catalog.error && !matching.length && (
          <p className="p-3 text-sm text-muted-foreground">
            {t(models.length ? "models.noMatches" : "providers.noModels")}
          </p>
        )}
      </div>
    </section>
  );
}
