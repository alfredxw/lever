import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type MouseEventHandler,
} from "react";
import { focusManager, useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight, Plus, RefreshCw, X } from "lucide-react";
import { api, queryClient } from "@/api/client";
import type {
  Plugin,
  Provider,
  ProviderCandidate,
  ProviderContribution,
  ProviderInfo,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PluginIcon } from "@/features/plugins/PluginCard";
import { pluginsQuery } from "@/features/plugins/pluginsQuery";
import { connectionName } from "@/features/runtime/connections";
import {
  connectionsQuery,
  modelsQuery,
  providerCandidatesQuery,
  providersQuery,
  refreshModels,
  scanLocalProviders,
  useModels,
} from "@/features/runtime/queries";
import { ProviderForm } from "./ProviderForm";
import {
  InstallGuide,
  ProviderConnection,
  ProviderDetails,
  ProviderHeading,
  ProviderMark,
  installationGuides,
  providerSource,
  providerStatus,
  type ProviderStatus,
} from "./ProviderDetails";
import { useProviderLogin } from "./ProviderLogin";
import "./provider-settings.css";

type Choice = {
  key: string;
  plugin: Plugin;
  item: ProviderContribution;
};

type Editor = {
  choice?: string;
  fromPicker?: boolean;
  customExecutable?: boolean;
};

const builtinOrder = [
  "lever.codex",
  "lever.claude",
  "lever.antigravity",
  "lever.pi",
  "lever.dsh",
  "lever.acp",
];
const pluginOrder = (plugin: Plugin) => {
  const index = builtinOrder.indexOf(plugin.id);
  return index < 0 ? builtinOrder.length : index;
};
const contributionKey = (
  entry: Pick<Provider, "pluginId" | "contributionId">,
) => `${entry.pluginId}/${entry.contributionId}`;
const runtimeFor = ({ plugin, item }: Choice) => ({
  pluginId: plugin.id,
  type: item.driver,
});
const isCustomACP = ({ plugin, item }: Choice) =>
  plugin.id === "lever.acp" && !item.command;

function ProviderEntry({
  name,
  runtime,
  description,
  status,
  selected,
  onClick,
}: {
  name: string;
  runtime: Pick<Provider, "pluginId" | "type">;
  description?: string;
  status?: ProviderStatus;
  selected?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      className="provider-entry"
      aria-pressed={selected}
      onClick={onClick}
    >
      <ProviderMark runtime={runtime} />
      <span className="provider-entry-copy">
        <span title={name}>{name}</span>
        {description && <small>{description}</small>}
      </span>
      {status && (
        <span
          className="provider-status-dot"
          data-tone={status.tone}
          title={t(status.label)}
        >
          <span className="sr-only">{t(status.label)}</span>
        </span>
      )}
      {selected === undefined && <ChevronRight data-icon="inline-end" />}
    </Button>
  );
}

export function SettingsProviders({
  providerId: controlledProviderId,
  pluginId,
  target,
  onSelect: onSelectProp,
  onShowAll,
  onOpenPlugin,
  visible,
  embedded = false,
}: {
  providerId?: string;
  pluginId?: string;
  target?: { id?: string; pluginId?: string };
  onSelect?: (id: string) => void;
  onShowAll?: () => void;
  onOpenPlugin?: (id?: string) => void;
  visible: boolean;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const [internalProviderId, setInternalProviderId] = useState("");
  const providerId = controlledProviderId ?? internalProviderId;
  const onSelect = onSelectProp ?? setInternalProviderId;
  const indexTitle = useId();
  const detail = useRef<HTMLElement>(null);
  const list = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const compactBack = useRef<HTMLButtonElement>(null);
  const listReturn = useRef<{ trigger: HTMLElement; top: number } | undefined>(
    undefined,
  );
  const [detailOpen, setDetailOpen] = useState(
    !!(target?.id || target?.pluginId),
  );
  const [typeKey, setTypeKey] = useState<string>();
  const [editor, setEditor] = useState<Editor>();

  const providers = useQuery({ ...connectionsQuery, enabled: visible });
  const candidates = useQuery({ ...providerCandidatesQuery, enabled: visible });
  const plugins = useQuery({ ...pluginsQuery, enabled: visible });
  const login = useProviderLogin(visible);

  const rows = (providers.data ?? []).filter(
    (p) => !pluginId || p.pluginId === pluginId,
  );
  const types = [...(plugins.data ?? [])]
    .filter((p) => !pluginId || p.id === pluginId)
    .sort((left, right) => pluginOrder(left) - pluginOrder(right))
    .flatMap((plugin) =>
      (plugin.manifest.contributes.providers ?? []).map((item) => ({
        plugin,
        item,
        key: contributionKey({ pluginId: plugin.id, contributionId: item.id }),
      })),
    );
  const byType = (key: string) =>
    rows.filter((p) => contributionKey(p) === key);
  const scope = plugins.data?.find((p) => p.id === pluginId);
  const unconnected = types.filter(({ key }) => !byType(key).length);
  const type =
    types.find(({ key }) => key === typeKey) ??
    (!rows.length && !providerId ? unconnected[0] : undefined);
  const pendingSelection =
    !!providerId &&
    providers.isFetching &&
    !rows.some((p) => p.id === providerId);
  const selected = type
    ? byType(type.key)[0]
    : (rows.find((p) => p.id === providerId) ??
      (!pendingSelection
        ? (rows.find(
            (p) => p.available && p.installed && p.loginStatus === "signedIn",
          ) ??
          rows.find(
            (p) =>
              p.available &&
              p.installed &&
              !p.error &&
              p.loginStatus !== "signedOut",
          ) ??
          rows.find((p) => p.available && p.installed) ??
          rows[0])
        : undefined));
  const owner = plugins.data?.find((p) => p.id === selected?.pluginId);
  const assignable = types.find(({ key }) => key === editor?.choice);
  const found = new Map(candidates.data?.map((p) => [contributionKey(p), p]));

  const canLoadModels = !!(
    selected?.available &&
    selected.installed &&
    selected.loginStatus !== "signedOut"
  );
  const catalog = useModels(
    selected?.id ?? "",
    "",
    visible && !editor && canLoadModels,
  );

  const refreshConnections = () =>
    queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
  const scan = useMutation({
    mutationFn: (_manual: boolean) => scanLocalProviders(),
    onSettled: (result, _error, manual) => {
      if (!result?.connected && !manual) return;
      return Promise.all([
        refreshConnections(),
        queryClient.invalidateQueries({ queryKey: pluginsQuery.queryKey }),
      ]);
    },
  });
  const runScan = scan.mutate;
  useEffect(() => {
    if (!visible) return;
    runScan(false);
    return focusManager.subscribe((focused) => {
      if (focused) runScan(false);
    });
  }, [visible, runScan]);
  useEffect(() => {
    if (!target) return;
    setTypeKey(undefined);
    setEditor(undefined);
    setDetailOpen(!!(target.id || target.pluginId));
    detail.current?.scrollTo({ top: 0 });
  }, [target]);
  useEffect(() => {
    if (!providerId && !typeKey && !providers.isPlaceholderData && selected)
      onSelect(selected.id);
  }, [onSelect, providerId, providers.isPlaceholderData, selected, typeKey]);

  const detectionPending =
    scan.isPending || providers.isFetching || candidates.isFetching;
  const detect = () => runScan(true);
  const refresh = () => {
    if (selected && canLoadModels)
      void refreshModels(selected.id).catch(() => {});
  };

  function showDetail(trigger?: HTMLElement, focusHeading = false) {
    if (trigger && trigger.closest(".provider-index")) {
      listReturn.current = { trigger, top: list.current?.scrollTop ?? 0 };
    }
    setDetailOpen(true);
    detail.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => {
      const focus = focusHeading
        ? detail.current?.querySelector<HTMLElement>("[data-provider-heading]")
        : compactBack.current;
      if (focus?.getClientRects().length) focus.focus({ preventScroll: true });
    });
  }

  function showList() {
    setDetailOpen(false);
    setEditor(undefined);
    const saved = listReturn.current;
    listReturn.current = undefined;
    requestAnimationFrame(() => {
      if (saved) list.current?.scrollTo({ top: saved.top });
      const trigger = saved?.trigger;
      (trigger?.isConnected ? trigger : addButton.current)?.focus({
        preventScroll: true,
      });
    });
  }

  function showProvider(id: string, trigger?: HTMLElement) {
    onSelect(id);
    setTypeKey(undefined);
    setEditor(undefined);
    showDetail(trigger);
  }

  function selectType(choice: Choice, trigger: HTMLElement) {
    setTypeKey(choice.key);
    setEditor(
      isCustomACP(choice) && choice.plugin.enabled
        ? { choice: choice.key }
        : undefined,
    );
    showDetail(trigger);
  }

  function openEditor(next: Editor, event?: MouseEvent<HTMLButtonElement>) {
    setEditor(next);
    showDetail(event?.currentTarget, true);
  }

  function saved(provider: Provider, signIn = false) {
    if (pluginId && pluginId !== provider.pluginId) onShowAll?.();
    void queryClient
      .cancelQueries({ queryKey: providersQuery.queryKey })
      .then(() => refreshConnections());
    showProvider(provider.id);
    if (signIn) login.open(provider);
  }

  const useLocal = useMutation({
    mutationFn: (candidate: ProviderCandidate) =>
      api<Provider>(
        `/provider-candidates/${encodeURIComponent(candidate.pluginId)}/${encodeURIComponent(candidate.contributionId)}`,
        {},
      ),
    onSuccess: (provider) => saved(provider),
  });
  const managed = useMutation({
    mutationFn: () =>
      api<Provider>("/providers", {
        pluginId: "lever.antigravity",
        contributionId: "antigravity",
        id: "",
        type: "antigravity",
        name: t("providers.managedAntigravityName"),
        enabled: true,
        command: "",
        args: [],
      }),
    onSuccess: (provider) => saved(provider),
  });
  const useManaged = () => {
    const existing = rows.find(
      (p) => p.pluginId === "lever.antigravity" && !p.command,
    );
    if (existing) showProvider(existing.id);
    else managed.mutate();
  };

  function availableStatus(choice: Choice) {
    if (!choice.plugin.enabled) return "plugins.off";
    if (found.has(choice.key)) return "plugins.status.detected";
    if (isCustomACP(choice) || !choice.plugin.builtin)
      return "connections.canAdd";
    if (!candidates.data) return undefined;
    return "settings.notInstalled";
  }

  const typeSource = (choice: Choice) =>
    isCustomACP(choice)
      ? "connections.localCommand"
      : choice.plugin.builtin
        ? "connections.localCLI"
        : "providers.source.plugin";

  function addType(choice: Choice) {
    if (!choice.plugin.enabled) {
      setEditor(undefined);
      setTypeKey(choice.key);
      showDetail(undefined, true);
      return;
    }
    openEditor({
      choice: choice.key,
      fromPicker: true,
      customExecutable:
        !!providers.data &&
        availableStatus(choice) === "settings.notInstalled" &&
        !byType(choice.key).some((provider) => provider.installed),
    });
  }

  function useLocalButton(choice: Choice) {
    const candidate = found.get(choice.key);
    if (!candidate) return;
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={useLocal.isPending}
        onClick={() => useLocal.mutate(candidate)}
      >
        {t("connections.useNamed", { name: candidate.name })}
      </Button>
    );
  }

  const typeStatus = type ? availableStatus(type) : undefined;
  const connectionError =
    providers.error ?? candidates.error ?? plugins.error ?? scan.error;
  const editorInstances = assignable ? byType(assignable.key) : [];
  const local = editorInstances.find(
    (p) =>
      !p.configDir &&
      (p.type === "antigravity"
        ? p.command === "agy"
        : p.command === (assignable?.item.command ?? "")) &&
      (p.args?.length ?? 0) === (assignable?.item.args?.length ?? 0) &&
      (p.args ?? []).every(
        (arg, index) => arg === assignable?.item.args?.[index],
      ),
  );

  const detailContent = (
    <>
      {!embedded && (
        <Button
          ref={compactBack}
          size="sm"
          variant="ghost"
          className="provider-compact-back"
          onClick={showList}
        >
          <ArrowLeft data-icon="inline-start" />
          {t("settings.providers")}
        </Button>
      )}
      {(useLocal.error || managed.error) && (
        <ErrorNotice error={useLocal.error ?? managed.error!} />
      )}
      {editor ? (
        assignable?.plugin.enabled ? (
          <>
            {editor.fromPicker && types.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                onClick={() => openEditor({})}
              >
                <ArrowLeft data-icon="inline-start" />
                {t("providers.chooseType")}
              </Button>
            )}
            <ProviderHeading
              title={t("providers.addNamed", {
                name: assignable.item.name,
              })}
              runtime={runtimeFor(assignable)}
              embedded={embedded}
            />
            <ProviderForm
              key={assignable.key + !!editor.customExecutable}
              plugin={assignable.plugin}
              item={assignable.item}
              defaultName={
                editorInstances.length
                  ? t("providers.newInstanceName", {
                      name: assignable.item.name,
                    })
                  : assignable.item.name
              }
              customExecutable={editor.customExecutable}
              localAction={
                local ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => showProvider(local.id)}
                  >
                    {t("connections.useLocalDefault")}
                  </Button>
                ) : (
                  useLocalButton(assignable)
                )
              }
              onSaved={saved}
              onClose={showList}
            />
          </>
        ) : (
          <>
            <ProviderHeading title={t("providers.add")} embedded={embedded}>
              <Button variant="ghost" size="sm" onClick={showList}>
                {t("common.cancel")}
              </Button>
            </ProviderHeading>
            <div className="provider-type-picker panel-surface">
              {types.map((choice) => {
                const count = byType(choice.key).length;
                return (
                  <ProviderEntry
                    key={choice.key}
                    runtime={runtimeFor(choice)}
                    name={choice.item.name}
                    description={t(
                      !choice.plugin.enabled
                        ? "plugins.off"
                        : count
                          ? "providers.instanceCount"
                          : availableStatus(choice) === "settings.notInstalled"
                            ? "settings.notInstalled"
                            : typeSource(choice),
                      { count },
                    )}
                    onClick={() => addType(choice)}
                  />
                );
              })}
            </div>
          </>
        )
      ) : selected ? (
        <ProviderDetails
          key={selected.id}
          provider={selected}
          plugin={owner}
          name={connectionName(selected, rows, t)}
          catalog={catalog}
          visible={visible}
          embedded={embedded}
          detecting={detectionPending}
          onDetect={() => {
            detect();
            refresh();
          }}
          onRefreshModels={refresh}
          onLogin={() => login.open(selected)}
          onSpecifyExecutable={
            owner?.builtin &&
            types.some(({ key }) => key === contributionKey(selected))
              ? () =>
                  openEditor({
                    choice: contributionKey(selected),
                    customExecutable: true,
                  })
              : undefined
          }
          onUseManaged={useManaged}
          addingManaged={managed.isPending}
          onSaved={saved}
          onRemove={() => {
            onSelect("");
            setTypeKey(undefined);
          }}
          onOpenPlugin={
            onOpenPlugin ? () => onOpenPlugin(selected.pluginId) : undefined
          }
        />
      ) : type ? (
        <>
          <ProviderHeading
            title={type.item.name}
            runtime={runtimeFor(type)}
            description={t(typeSource(type))}
            embedded={embedded}
          />
          <ProviderConnection
            status={{
              label: typeStatus ?? "plugins.status.checking",
              tone: "muted",
            }}
            description={
              found.get(type.key)?.configPath || found.get(type.key)?.path
            }
          >
            {type.plugin.enabled ? (
              <>
                {useLocalButton(type)}
                {installationGuides[type.plugin.id] && !found.has(type.key) && (
                  <InstallGuide url={installationGuides[type.plugin.id]} />
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    openEditor({
                      choice: type.key,
                      customExecutable:
                        type.plugin.builtin && !isCustomACP(type),
                    })
                  }
                >
                  {t(
                    type.plugin.builtin && !isCustomACP(type)
                      ? "providers.source.custom"
                      : "providers.add",
                  )}
                </Button>
                {type.plugin.id === "lever.antigravity" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={managed.isPending}
                    onClick={useManaged}
                  >
                    {t("providers.useManagedAntigravity")}
                  </Button>
                )}
              </>
            ) : !embedded && onOpenPlugin ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenPlugin(type.plugin.id)}
              >
                {t("connections.viewPlugin")}
              </Button>
            ) : null}
          </ProviderConnection>
        </>
      ) : providers.isPending || pendingSelection || plugins.isPending ? (
        <>
          <Skeleton className="h-11 w-44" />
          <Skeleton className="h-16" />
          <Skeleton className="h-28" />
        </>
      ) : (
        <ProviderHeading title={t("connections.empty")} embedded={embedded} />
      )}
    </>
  );

  if (embedded) {
    const canAddDirect = types.length === 1 && types[0].plugin.enabled;
    return (
      <div className="provider-embedded" ref={detail as never}>
        {connectionError && (
          <ErrorNotice error={connectionError} retry={detect} />
        )}
        <div className="provider-inst-heading">
          <h3>
            {t("connections.instances")} <span>{rows.length}</span>
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("settings.detect")}
            title={t("settings.detect")}
            disabled={detectionPending}
            onClick={detect}
          >
            <RefreshCw
              className={detectionPending ? "animate-spin" : undefined}
            />
            {t("settings.detect")}
          </Button>
          {types.some((c) => c.plugin.enabled) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!plugins.data}
              onClick={(event) =>
                canAddDirect ? addType(types[0]) : openEditor({}, event)
              }
            >
              <Plus data-icon="inline-start" />
              {t("connections.add")}
            </Button>
          )}
        </div>
        <div className="provider-inst-bar">
          {rows.map((p) => {
            const model =
              p.id === selected?.id
                ? catalog.data
                : queryClient.getQueryData(modelsQuery(p.id).queryKey);
            const status = providerStatus(
              p,
              model,
              p.id === selected?.id && catalog.isError,
            );
            const name = connectionName(p, rows, t);
            return (
              <Button
                key={p.id}
                type="button"
                variant="outline"
                size="sm"
                className="provider-inst-chip"
                aria-pressed={!editor && selected?.id === p.id}
                onClick={(event) => showProvider(p.id, event.currentTarget)}
              >
                <span
                  className="provider-status-dot"
                  data-tone={status.tone}
                  aria-hidden="true"
                />
                <span className="truncate">{name}</span>
              </Button>
            );
          })}
          {unconnected.map((choice) => (
            <Button
              key={choice.key}
              type="button"
              variant="outline"
              size="sm"
              className="provider-inst-chip"
              aria-pressed={
                type?.key === choice.key &&
                (!editor || editor.choice === choice.key)
              }
              onClick={(event) => selectType(choice, event.currentTarget)}
            >
              <span
                className="provider-status-dot"
                data-tone={found.has(choice.key) ? "detected" : "muted"}
                aria-hidden="true"
              />
              <span className="truncate">{choice.item.name}</span>
            </Button>
          ))}
        </div>
        <div className="provider-embedded-body">{detailContent}</div>
        {login.dialog}
      </div>
    );
  }

  return (
    <div className="provider-workspace" data-detail={detailOpen}>
      <section className="provider-index" aria-labelledby={indexTitle}>
        <header className="provider-index-header">
          <h2 id={indexTitle}>{t("settings.providers")}</h2>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("settings.detect")}
            title={t("settings.detect")}
            disabled={detectionPending}
            onClick={detect}
          >
            <RefreshCw
              className={detectionPending ? "animate-spin" : undefined}
            />
          </Button>
          <Button
            ref={addButton}
            size="sm"
            variant="ghost"
            aria-label={t("providers.add")}
            title={t("providers.add")}
            disabled={!plugins.data}
            onClick={(event) => openEditor({}, event)}
          >
            <Plus data-icon="inline-start" />
            {t("connections.addShort")}
          </Button>
        </header>
        <nav
          className="provider-index-scroll"
          aria-label={t("connections.mine")}
          ref={list}
        >
          {scope && onShowAll && (
            <Button
              className="provider-filter"
              size="sm"
              variant="outline"
              aria-label={t("connections.showAll")}
              title={t("connections.showAll")}
              onClick={onShowAll}
            >
              <PluginIcon plugin={scope} size={16} />
              <span className="truncate">{scope.manifest.name}</span>
              <X data-icon="inline-end" />
            </Button>
          )}
          {connectionError && (
            <ErrorNotice error={connectionError} retry={detect} />
          )}
          {(scan.data === null || candidates.data === null) && (
            <p
              className="px-2 py-1 text-xs text-muted-foreground"
              role="status"
            >
              {t("providers.discoveryUpdate")}
            </p>
          )}
          {(providers.isPending || plugins.isPending) && rows.length === 0 ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-11" />
              <Skeleton className="h-11" />
              <Skeleton className="h-11" />
            </div>
          ) : (
            <>
              {rows.length > 0 && (
                <section
                  className="provider-index-group"
                  aria-label={t("connections.connected")}
                >
                  <h3>{t("connections.connected")}</h3>
                  {rows.map((p) => {
                    const model =
                      p.id === selected?.id
                        ? catalog.data
                        : queryClient.getQueryData(modelsQuery(p.id).queryKey);
                    const status = providerStatus(
                      p,
                      model,
                      p.id === selected?.id && catalog.isError,
                    );
                    const name = connectionName(p, rows, t);
                    const count =
                      status.tone === "ready"
                        ? model?.models.filter(
                            ({ id }) => !p.hiddenModels?.includes(id),
                          ).length
                        : undefined;
                    return (
                      <ProviderEntry
                        key={p.id}
                        name={name}
                        runtime={p}
                        description={
                          t(providerSource(p)) +
                          (count !== undefined
                            ? ` · ${t("providers.modelCount", { count })}`
                            : "")
                        }
                        status={status}
                        selected={!editor && selected?.id === p.id}
                        onClick={(event) =>
                          showProvider(p.id, event.currentTarget)
                        }
                      />
                    );
                  })}
                </section>
              )}
              {unconnected.length > 0 && (
                <section
                  className="provider-index-group"
                  aria-label={t("connections.available")}
                >
                  <h3>{t("connections.available")}</h3>
                  {unconnected.map((choice) => {
                    const status = availableStatus(choice);
                    return (
                      <ProviderEntry
                        key={choice.key}
                        runtime={runtimeFor(choice)}
                        name={choice.item.name}
                        description={status && t(status)}
                        selected={
                          type?.key === choice.key &&
                          (!editor || editor.choice === choice.key)
                        }
                        onClick={(event) =>
                          selectType(choice, event.currentTarget)
                        }
                      />
                    );
                  })}
                </section>
              )}
            </>
          )}
        </nav>
      </section>

      <section
        className="provider-detail"
        aria-label={t("connections.details")}
        ref={detail}
      >
        <div className="provider-detail-body">{detailContent}</div>
      </section>
      {login.dialog}
    </div>
  );
}
