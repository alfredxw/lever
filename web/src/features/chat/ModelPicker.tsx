import { type ReactElement, useId, useRef, useState } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { RadioGroup, Toolbar } from "radix-ui";
import {
  Check,
  ChevronDown,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  Catalog,
  ModelInfo,
  ProviderInfo,
  Selection,
} from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ErrorNotice, Loading } from "@/components/common";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import {
  modelDescription,
  modelSearchAliases,
} from "@/features/runtime/modelLabels";
import { modelsQuery, refreshModels } from "@/features/runtime/queries";
import {
  toggleModelStar,
  useStarredModelsByProvider,
} from "@/features/runtime/runtimePreferences";
import { modelSelection } from "./useComposerModel";
import {
  connectionName,
  hasConnectionLabel,
} from "@/features/runtime/connections";
import "./composer.css";

function normalizedLabel(label: string) {
  return label.toLowerCase().replace(/[\s._-]+/g, "");
}

function revealCurrent(item: HTMLButtonElement | null) {
  item?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

type ModelEntry = {
  model: ModelInfo;
  provider: string;
  runtimeName: string;
  starred: boolean;
};

function isCurrent(entry: ModelEntry, value: Selection) {
  return entry.provider === value.provider && entry.model.id === value.model;
}

function ModelList({
  models,
  value,
  effortListId,
  favorites,
  disabled,
  onActivate,
  onRemoveFavorite,
}: {
  models: ModelEntry[];
  value: Selection;
  effortListId?: string;
  favorites: boolean;
  disabled?: boolean;
  onActivate: (entry: ModelEntry, focusEffort?: boolean) => void;
  onRemoveFavorite: () => void;
}) {
  const { t } = useTranslation();
  const [focusedModel, setFocusedModel] = useState<string>();
  return (
    <Toolbar.Root
      className="model-list"
      orientation="vertical"
      aria-label={t("models.list")}
    >
      {models.map((entry) => {
        const { model, provider, runtimeName, starred } = entry;
        const key = JSON.stringify([provider, model.id]);
        const detail =
          model.id === "default" && !model.requiresVersion
            ? model.resolvedModel
            : modelDescription(t, model, runtimeName);
        const description =
          detail && normalizedLabel(detail) !== normalizedLabel(model.name)
            ? detail
            : undefined;
        const subtitle = favorites
          ? [runtimeName, description].filter(Boolean).join(" · ")
          : description;
        const name = favorites ? `${model.name} · ${runtimeName}` : model.name;
        const hasEfforts = model.efforts.length > 0 && !model.requiresVersion;
        const current = isCurrent(entry, value);
        // Version-gated rows have no focusable model button.
        const starTabStop =
          !!model.requiresVersion ||
          (focusedModel ? focusedModel === key : current);
        const starLabel = t("models.star", { model: name });
        return (
          <div className="model-row" key={key}>
            <Toolbar.Button
              ref={current ? revealCurrent : undefined}
              className="model-choice"
              disabled={disabled || !!model.requiresVersion}
              aria-label={name}
              aria-current={current || undefined}
              aria-controls={current ? effortListId : undefined}
              aria-keyshortcuts={hasEfforts ? "ArrowRight" : undefined}
              onClick={(event) => onActivate(entry, event.detail === 0)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" && hasEfforts) {
                  event.preventDefault();
                  onActivate(entry, true);
                }
              }}
              onFocus={() => setFocusedModel(key)}
              title={subtitle ? `${model.name} · ${subtitle}` : model.name}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{model.name}</span>
                {subtitle && (
                  <small className="block truncate text-muted-foreground">
                    {subtitle}
                  </small>
                )}
              </span>
              {current && <Check size={14} aria-hidden="true" />}
            </Toolbar.Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="model-star"
              aria-label={starLabel}
              aria-pressed={starred}
              tabIndex={starTabStop ? 0 : -1}
              title={starred ? t("models.unstar", { model: name }) : starLabel}
              disabled={disabled}
              onClick={(event) => {
                const button = event.currentTarget;
                toggleModelStar(provider, model.id);
                if (favorites) {
                  setFocusedModel(undefined);
                  onRemoveFavorite();
                  return;
                }
                // Reordering a focused row can return keyboard focus to the document.
                if (event.detail === 0)
                  requestAnimationFrame(() => button.focus());
              }}
            >
              <Star className={starred ? "fill-current" : undefined} />
            </Button>
          </div>
        );
      })}
    </Toolbar.Root>
  );
}

export function ModelPicker({
  providers,
  catalog,
  value,
  preferFavorites = false,
  onChange,
  open,
  onOpenChange,
  onReturnToComposer,
  onConfigureRuntime,
  disabled,
  cwd,
  selectionForProvider,
  trigger,
  label,
}: {
  providers?: ProviderInfo[];
  catalog: UseQueryResult<Catalog | null>;
  value: Selection;
  preferFavorites?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReturnToComposer?: () => void;
  onConfigureRuntime?: () => void;
  onChange: (value: Selection, fromFavorites?: boolean) => void;
  disabled?: boolean;
  cwd?: string;
  selectionForProvider: (provider: string, previous?: Selection) => Selection;
  trigger?: ReactElement;
  label?: string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<boolean>();
  const effortList = useRef<HTMLDivElement>(null);
  const effortListId = useId();
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<Record<string, Selection>>({});
  const runtime = providers?.find((item) => item.id === value.provider);
  const readyProviders =
    providers?.filter(
      (item) => item.available && item.installed && !item.error,
    ) ?? [];
  const runtimeUnavailable =
    !!providers && !readyProviders.some((item) => item.id === value.provider);
  const models = catalog.data?.models ?? [];
  const selected = models.find((model) => model.id === value.model);
  const starred = useStarredModelsByProvider(
    providers?.map(({ id }) => id) ?? [value.provider],
  );
  const browsingFavorites =
    (favorites ??
      (preferFavorites &&
        !runtimeUnavailable &&
        !runtime?.hiddenModels?.includes(value.model) &&
        starred.get(value.provider)?.has(value.model) === true)) &&
    readyProviders.length > 0;
  const favoriteProviders = browsingFavorites
    ? readyProviders.filter(({ id }) => starred.get(id)?.size)
    : [];
  const favoriteCatalogs = useQueries({
    queries: favoriteProviders.map(({ id }) => ({
      ...modelsQuery(id, cwd),
      enabled: open,
    })),
  });
  const sources = browsingFavorites
    ? favoriteProviders.map((runtime, index) => ({
        provider: runtime.id,
        runtime,
        catalog: favoriteCatalogs[index],
      }))
    : runtimeUnavailable
      ? []
      : [{ provider: value.provider, runtime, catalog }];
  const query = search.trim().toLocaleLowerCase();
  const visible = sources.flatMap(({ provider, runtime, catalog }) => {
    const runtimeName = runtime
      ? connectionName(runtime, providers ?? [], t)
      : provider;
    const hidden = new Set(runtime?.hiddenModels);
    return (catalog.data?.models ?? [])
      .filter((model) => !hidden.has(model.id))
      .map((model) => ({
        model,
        provider,
        runtimeName,
        starred: starred.get(provider)?.has(model.id) ?? false,
      }))
      .filter(
        (entry) =>
          (!browsingFavorites || entry.starred) &&
          [
            entry.model.name,
            ...modelSearchAliases(entry.model),
            ...(browsingFavorites ? [runtimeName] : []),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
      )
      .sort((a, b) => Number(b.starred) - Number(a.starred));
  });
  const refresh = (provider: string) => {
    void refreshModels(provider, cwd).catch(() => {}); // The query error is rendered in the picker.
  };
  const changeOpen = (next: boolean) => {
    onOpenChange(next);
    // A saved comparison can be retried without discovery. Load its catalog only for editing.
    if (next && !catalog.isEnabled && !runtimeUnavailable)
      void catalog.refetch();
    if (!next) setSearch("");
  };
  function returnToComposer() {
    changeOpen(false);
    onReturnToComposer?.();
  }
  function selectProvider(provider: string) {
    if (provider === value.provider) return value;
    previous.current[value.provider] = value;
    return selectionForProvider(provider, previous.current[provider]);
  }
  function activateModel(
    { model, provider }: ModelEntry,
    focusEffort?: boolean,
  ) {
    onChange(
      modelSelection(selectProvider(provider), model),
      browsingFavorites,
    );
    if (!model.efforts.length) returnToComposer();
    else if (focusEffort)
      requestAnimationFrame(() => effortList.current?.focus());
  }
  const effortLabel = (effort: string) =>
    t(`models.effort.${effort}`, { defaultValue: effort });
  const runtimeName = runtime
    ? connectionName(runtime, providers ?? [], t)
    : value.provider;
  const namedConnections = readyProviders.some((p) =>
    hasConnectionLabel(p, providers ?? []),
  );
  const runtimeChoices = [
    {
      id: "favorites",
      name: t("models.favorites"),
      icon: <Star size={17} fill="currentColor" aria-hidden="true" />,
    },
    ...readyProviders.map((provider) => ({
      id: `provider:${provider.id}`,
      name: connectionName(provider, providers ?? [], t),
      icon: <RuntimeIcon provider={provider} size={17} />,
    })),
  ];
  const modelName =
    selected?.name || value.model || t("composer.command.model");
  const current = visible.find((entry) => isCurrent(entry, value));
  const effortModel =
    current?.model.efforts.length && !current.model.requiresVersion
      ? current.model
      : undefined;
  const currentEffort = effortModel
    ? modelSelection(value, effortModel).effort
    : "";
  const setupMessage = runtimeUnavailable
    ? readyProviders.length
      ? t("models.runtimeNeedsSetup", { runtime: runtimeName })
      : t("models.noRuntimes")
    : catalog.data === null
      ? t("models.runtimeNotFound")
      : catalog.data && !models.length
        ? t("providers.noModels")
        : "";
  const needsSetup = !!setupMessage || (!!catalog.error && !models.length);
  const listNeedsSetup = needsSetup && !browsingFavorites;
  const loading = sources.some(({ catalog }) => catalog.isPending);
  const errors = sources.filter(({ catalog }) => catalog.error);
  function configure(action: () => void) {
    changeOpen(false);
    action();
  }
  const fastUnavailable = catalog.data?.fastUnavailable;
  const fast = !!selected?.fast && value.fast;
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <InputGroupButton
            variant="ghost"
            size="sm"
            className="model-trigger"
            disabled={disabled}
            aria-label={t("models.choose")}
            title={`${runtimeName} · ${modelName}`}
          >
            <RuntimeIcon provider={value.provider} />
            <span className="model-trigger-name composer-action-detail">
              {runtime && hasConnectionLabel(runtime, providers ?? [])
                ? `${runtimeName} · ${modelName}`
                : modelName}
            </span>
            {value.effort && (
              <span className="model-trigger-effort composer-action-detail">
                {effortLabel(value.effort)}
              </span>
            )}
            {value.fast && (
              <Zap size={14} className="fast-icon composer-action-detail" />
            )}
            <ChevronDown size={12} className="composer-action-detail" />
          </InputGroupButton>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="model-picker"
        side="top"
        align="end"
        aria-label={label ?? t("models.choose")}
        onOpenAutoFocus={(event) => {
          if (input.current) {
            event.preventDefault();
            input.current.focus();
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          returnToComposer();
        }}
        onCloseAutoFocus={(event) => {
          if (onReturnToComposer) event.preventDefault();
        }}
      >
        <div className="model-picker-body">
          {!!readyProviders.length && (
            <TooltipProvider delayDuration={300}>
              <RadioGroup.Root
                className="runtime-rail"
                data-named={namedConnections || undefined}
                aria-label={t("models.runtime")}
                orientation="vertical"
                disabled={disabled}
                value={
                  browsingFavorites ? "favorites" : `provider:${value.provider}`
                }
                onValueChange={(next) => {
                  setSearch("");
                  setFavorites(next === "favorites");
                  if (next === "favorites") return;
                  const provider = next.slice("provider:".length);
                  if (provider !== value.provider)
                    onChange(selectProvider(provider), false);
                }}
              >
                {runtimeChoices.map(({ id, name, icon }) => (
                  <Tooltip key={id}>
                    <TooltipTrigger asChild>
                      <RadioGroup.Item
                        value={id}
                        className="runtime-choice"
                        aria-label={name}
                      >
                        {icon}
                        {namedConnections && (
                          <span className="truncate">{name}</span>
                        )}
                      </RadioGroup.Item>
                    </TooltipTrigger>
                    <TooltipContent side="left" sideOffset={8}>
                      {name}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </RadioGroup.Root>
            </TooltipProvider>
          )}
          <div className="model-catalog">
            {(browsingFavorites || !runtimeUnavailable) && (
              <InputGroup className="model-search">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  ref={input}
                  aria-label={t("models.search")}
                  placeholder={t("models.search")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      event.currentTarget
                        .closest(".model-catalog")
                        ?.querySelector<HTMLButtonElement>(
                          ".model-choice:not(:disabled)",
                        )
                        ?.focus();
                    }
                  }}
                />
                {!browsingFavorites && (
                  <InputGroupAddon align="inline-end">
                    {onConfigureRuntime && !needsSetup && (
                      <InputGroupButton
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("models.configureRuntime")}
                        title={t("models.configureRuntime")}
                        onClick={() => configure(onConfigureRuntime)}
                      >
                        <Settings2 />
                      </InputGroupButton>
                    )}
                    <InputGroupButton
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("models.refresh")}
                      title={t("models.refresh")}
                      disabled={catalog.isFetching}
                      onClick={() => refresh(value.provider)}
                    >
                      <RefreshCw
                        className={
                          catalog.isFetching ? "animate-spin" : undefined
                        }
                      />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
            )}
            <div className="model-catalog-lists">
              <div className="model-list-scroll">
                {errors.map(({ provider, catalog }) => (
                  <ErrorNotice
                    key={provider}
                    error={catalog.error}
                    retry={() => refresh(provider)}
                  />
                ))}
                {listNeedsSetup ? (
                  <div className="model-catalog-state flex flex-col items-start gap-2">
                    {setupMessage && <span role="status">{setupMessage}</span>}
                    {onConfigureRuntime && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => configure(onConfigureRuntime)}
                      >
                        {t("connections.manage")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    {(!loading || visible.length > 0) && (
                      <ModelList
                        key={
                          browsingFavorites
                            ? "favorites"
                            : `provider:${value.provider}`
                        }
                        models={visible}
                        value={value}
                        effortListId={effortModel ? effortListId : undefined}
                        favorites={browsingFavorites}
                        disabled={disabled}
                        onActivate={activateModel}
                        onRemoveFavorite={() => {
                          setFavorites(true);
                          input.current?.focus();
                        }}
                      />
                    )}
                    {loading && <Loading />}
                    {!loading &&
                      visible.length === 0 &&
                      errors.length === 0 && (
                        <div className="model-catalog-state">
                          {t(
                            browsingFavorites && !query
                              ? "models.noFavorites"
                              : "models.noMatches",
                          )}
                        </div>
                      )}
                  </>
                )}
              </div>
              {effortModel && !listNeedsSetup && (
                <div className="model-efforts" id={effortListId}>
                  <span className="model-option-label">
                    {t("models.reasoning")}
                  </span>
                  <ToggleGroup
                    key={JSON.stringify([value.provider, effortModel.id])}
                    ref={effortList}
                    type="single"
                    role="radiogroup"
                    orientation="vertical"
                    aria-label={t("models.reasoning")}
                    aria-description={effortModel.name}
                    size="sm"
                    spacing={1}
                    className="w-full"
                    value={currentEffort}
                    disabled={disabled}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        event.currentTarget
                          .closest(".model-catalog")
                          ?.querySelector<HTMLButtonElement>(
                            '.model-choice[aria-current="true"]',
                          )
                          ?.focus();
                      }
                    }}
                  >
                    {effortModel.efforts.map((effort) => (
                      <ToggleGroupItem
                        key={effort}
                        ref={
                          effort === currentEffort ? revealCurrent : undefined
                        }
                        value={effort}
                        className="justify-between"
                        onClick={() => {
                          onChange({
                            ...modelSelection(value, effortModel),
                            effort,
                          });
                          returnToComposer();
                        }}
                      >
                        <span className="truncate" title={effortLabel(effort)}>
                          {effortLabel(effort)}
                        </span>
                        {effort === currentEffort && (
                          <Check aria-hidden="true" />
                        )}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              )}
            </div>
          </div>
        </div>
        {!needsSetup && (
          <div className="model-picker-footer">
            <span className="model-option-label">{t("models.speed")}</span>
            <RadioGroup.Root
              className="model-options"
              aria-label={t("models.speed")}
              orientation="horizontal"
              disabled={disabled}
              value={fast ? "fast" : "standard"}
              onValueChange={(speed) =>
                onChange({ ...value, fast: speed === "fast" })
              }
            >
              <RadioGroup.Item value="standard">
                {t("models.standard")}
              </RadioGroup.Item>
              <RadioGroup.Item
                value="fast"
                disabled={!selected?.fast}
                title={
                  !selected?.fast
                    ? `${t("models.fastUnavailable")}${fastUnavailable ? ` (${fastUnavailable})` : ""}`
                    : t("models.fastCost")
                }
              >
                <Zap size={14} />
                Fast
              </RadioGroup.Item>
            </RadioGroup.Root>
            {catalog.data && (
              <span className="model-runtime-name" title={runtimeName}>
                {runtimeName}
              </span>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
