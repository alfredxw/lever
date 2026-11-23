import { useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  Funnel,
  GitBranch,
  LayoutGrid,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Agent,
  PersonalChannelReceipt,
  Plugin,
  PluginUpdate,
  UpdateSettings,
} from "@/api/types.gen";
import { api, APIError, queryClient } from "@/api/client";
import { ErrorNotice, Loading } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  SecondarySidebar,
  useSecondarySidebarState,
} from "@/components/workbench/SecondarySidebar";
import { UpdatePolicyPopover } from "@/components/workbench/UpdatePolicyPopover";
import { automationsQuery } from "@/features/automations/automationsQuery";
import { connectionsQuery } from "@/features/runtime/queries";
import { SettingsProviders } from "@/features/settings/SettingsProviders";
import { useTaskSources } from "@/features/tasks/TaskSources";
import {
  PluginCard,
  PluginIcon,
  isFeishuPlugin,
  isPersonalChannelPlugin,
  pluginDescription,
  pluginName,
  pluginSignal,
} from "./PluginCard";
import { FeishuChannel } from "./FeishuChannel";
import { PersonalChannel } from "./PersonalChannel";
import { useFeishuChannel } from "./channelQuery";
import { pluginsQuery, pluginUpdateSettingsQuery } from "./pluginsQuery";
import {
  PluginPackageDialog,
  releaseLabel,
  type PackageAction,
} from "./PluginPackageDialog";
import { PluginIndex } from "./PluginIndex";
import { PluginTaskSourcesPanel } from "./PluginTaskSourcesPanel";
import { PluginEventSourcesPanel } from "./PluginEventSourcesPanel";
import { PluginSubscriptionsView } from "./PluginSubscriptionsView";
import { groupPlugins, pluginKindLabel } from "./pluginGroups";
import "./plugins.css";
import "@/components/workbench/catalog.css";

const originOptions = {
  all: "plugins.filter.all",
  builtin: "plugins.builtin",
  local: "plugins.local",
  git: "plugins.git",
} as const;

const filterOptionClass =
  "px-1.5 text-xs text-muted-foreground data-[state=on]:text-foreground";

const policyValues = ["inherit", "auto", "notify", "manual"] as const;
const SUBSCRIPTIONS_VIEW = "__subscriptions__";
const defaultUpdateSettings: UpdateSettings = {
  mode: "notify",
  interval: "6h",
};

export default function PluginsPage({
  agents,
  initialPlugin,
  onManageConnections,
  onOpenChat,
  onOpenPersonalReceipt,
  onOpenWorks,
  onOpenAutomations,
}: {
  agents: Agent[];
  initialPlugin?: string;
  onManageConnections: (pluginId: string) => void;
  onOpenChat: (chatId: string, agentId: string, title: string) => void;
  onOpenPersonalReceipt?: (
    receipt: PersonalChannelReceipt,
    title: string,
  ) => void;
  onOpenWorks?: () => void;
  onOpenAutomations?: (automationId?: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const plugins = useQuery({
    ...pluginsQuery,
    refetchOnWindowFocus: "always",
  });
  const providers = useQuery({
    ...connectionsQuery,
    refetchOnWindowFocus: "always",
  });
  const updateSettingsQuery = useQuery(pluginUpdateSettingsQuery);
  const updateSettings = updateSettingsQuery.data ?? defaultUpdateSettings;

  const [selected, setSelected] = useState(initialPlugin ?? "");
  const [detailTab, setDetailTab] = useState<"config" | "package">("config");
  const { compact, sidebar, setSidebar } = useSecondarySidebarState();
  const overlayOpen = compact && sidebar;
  const [overviewSearch, setOverviewSearch] = useState("");
  const [detailSearch, setDetailSearch] = useState("");
  const [origin, setOrigin] = useState("all");
  const [status, setStatus] = useState("all");
  const originLabel = useId();
  const [packageAction, setPackageAction] = useState<PackageAction | null>(
    null,
  );

  const subscriptionsActive = selected === SUBSCRIPTIONS_VIEW;
  const plugin = subscriptionsActive
    ? undefined
    : plugins.data?.find((item) => item.id === selected);
  const inOverview = !plugin && !subscriptionsActive;

  const taskSources = useTaskSources(inOverview);
  const automations = useQuery({ ...automationsQuery, enabled: inOverview });

  const tracked = (plugins.data ?? []).filter(
    (p) => p.current?.source.kind === "branch",
  );
  const checks = useQueries({
    queries: tracked.map((p) => ({
      queryKey: ["plugin-update", p.id, p.revision],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<PluginUpdate>(
          "/plugins/" + p.id + "/update",
          undefined,
          "GET",
          signal,
        ),
      staleTime: 15 * 60_000,
      gcTime: 15 * 60_000,
      retry: false,
      refetchOnWindowFocus: true,
    })),
  });
  const checkByID = new Map(tracked.map((p, i) => [p.id, checks[i]]));
  const updatesCount = checks.filter(
    (c) => c.data?.available && !c.isError,
  ).length;
  const checkingAny = checks.some((c) => c.isFetching);

  const scroll = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listReturn = useRef<{ top: number; trigger?: HTMLElement } | null>(
    null,
  );
  const check = plugin ? checkByID.get(plugin.id) : undefined;
  const nextCommit =
    check?.data?.available && !check.isError ? check.data.commit : undefined;

  useLayoutEffect(() => {
    if (overlayOpen) return;
    if (plugin) {
      detailHeading.current?.focus({ preventScroll: true });
      return;
    }
    if (subscriptionsActive) return;
    const saved = listReturn.current;
    listReturn.current = null;
    if (saved) scroll.current?.scrollTo({ top: saved.top });
    const trigger = saved?.trigger;
    (trigger?.isConnected && !trigger.closest("[inert], [hidden]")
      ? trigger
      : heading.current
    )?.focus({
      preventScroll: true,
    });
  }, [plugin?.id, subscriptionsActive, overlayOpen]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["channel"] });
    void queryClient.invalidateQueries({ queryKey: ["automations"] });
    void queryClient.invalidateQueries({ queryKey: ["task-sources"] });
  };

  function packageSaved(p: Plugin) {
    queryClient.setQueryData<Plugin[]>(["plugins"], (old) =>
      old?.some((item) => item.id === p.id)
        ? old.map((item) => (item.id === p.id ? p : item))
        : [...(old ?? []), p],
    );
    setPackageAction(null);
    openPlugin(p.id);
    refresh();
  }

  const reload = useMutation({
    mutationFn: (id: string) => api<Plugin>("/plugins/" + id + "/reload", {}),
    onSuccess: (p) => {
      packageSaved(p);
      toast.success(t("plugins.reloaded"));
    },
    onError: (error) => toast.error(error.message),
  });

  const update = useMutation({
    mutationFn: (payload: {
      id: string;
      enabled?: boolean;
      updatePolicy?: NonNullable<Plugin["updatePolicy"]>;
    }) => {
      const { id, ...body } = payload;
      return api<{ updated: boolean }>(`/plugins/${id}`, body, "PUT");
    },
    onSuccess: async (_, { id, enabled, updatePolicy }) => {
      await queryClient.cancelQueries({ queryKey: ["plugins"] });
      queryClient.setQueryData<Plugin[]>(["plugins"], (list) =>
        list?.map((item) =>
          item.id === id
            ? {
                ...item,
                ...(enabled !== undefined ? { enabled } : {}),
                ...(updatePolicy !== undefined ? { updatePolicy } : {}),
              }
            : item,
        ),
      );
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const saveUpdateSettings = useMutation({
    mutationFn: (next: UpdateSettings) =>
      api<UpdateSettings>("/plugin-update-settings", next, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(["plugin-update-settings"], saved);
    },
    onError: (error) => toast.error(error.message),
  });

  const autoApply = useMutation({
    mutationFn: (target: Plugin) =>
      api<{ plugin: Plugin; applied: boolean }>(
        `/plugins/${target.id}/auto-update`,
        {},
      ),
    onSuccess: ({ plugin: saved, applied }, target) => {
      if (applied) {
        packageSaved(saved);
        toast.success(t("plugins.autoUpdateApplied"));
        return;
      }
      toast.info(t("plugins.autoUpdateNeedsReview"));
      const commit = checkByID.get(target.id)?.data?.commit;
      if (commit) {
        setPackageAction({ kind: "update", plugin: target, commit });
      }
    },
    onError: (error, target) => {
      if (
        error instanceof APIError &&
        error.code === "plugin_update_needs_review"
      ) {
        toast.info(t("plugins.autoUpdateNeedsReview"));
        const commit = checkByID.get(target.id)?.data?.commit;
        if (commit) {
          setPackageAction({ kind: "update", plugin: target, commit });
        }
        return;
      }
      toast.error(error.message);
    },
  });

  const uninstall = useMutation({
    mutationFn: (id: string) => api(`/plugins/${id}`, {}, "DELETE"),
    onSuccess: (_, id) => {
      setSelected((current) => (current === id ? "" : current));
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const hasFilters = origin !== "all" || status !== "all";
  const filtered = !!overviewSearch.trim() || hasFilters;
  const filtersLabel = t("plugins.filters");
  const feishu = useFeishuChannel(
    !!plugins.data?.some(isFeishuPlugin),
    inOverview,
  );
  const signalFor = (item: Plugin) =>
    pluginSignal(
      item,
      providers.data,
      providers.isError,
      isFeishuPlugin(item) ? feishu.data : undefined,
      t,
    );
  const detailSignal = plugin && signalFor(plugin);
  const eligible = (plugins.data ?? []).filter((item) => {
    const { tone } = signalFor(item);
    const trackedUpdate = checkByID.get(item.id);
    return (
      (origin === "all" ||
        origin ===
          (item.builtin ? "builtin" : item.current ? "git" : "local")) &&
      (status === "all" ||
        (status === "enabled"
          ? item.enabled
          : status === "off"
            ? !item.enabled
            : tone === "attention" ||
              tone === "error" ||
              trackedUpdate?.data?.available ||
              trackedUpdate?.isError))
    );
  });
  const groups = groupPlugins(
    eligible,
    overviewSearch,
    t,
    i18n.resolvedLanguage,
  );
  const indexGroups = inOverview
    ? groups
    : groupPlugins(plugins.data ?? [], detailSearch, t, i18n.resolvedLanguage);
  const visible = groups.flatMap((group) => group.entries);
  const feishuAgent = agents.find((agent) => agent.id === feishu.data?.agentId);

  const enableControl = (item: Plugin, size: "sm" | "default" = "default") => (
    <Switch
      size={size}
      aria-label={t("plugins.enabled", { name: pluginName(item, t) })}
      checked={item.enabled}
      disabled={update.isPending || uninstall.isPending}
      onCheckedChange={(enabled) => update.mutate({ id: item.id, enabled })}
    />
  );

  function openPlugin(id: string, trigger?: HTMLElement) {
    if (inOverview) {
      listReturn.current = { top: scroll.current?.scrollTop ?? 0, trigger };
      setDetailSearch(overviewSearch);
    }
    if (id !== selected) {
      setDetailTab("config");
      scroll.current?.scrollTo({ top: 0 });
    }
    setSelected(id);
    if (compact) setSidebar(false);
  }

  function showOverview() {
    setSelected("");
    if (compact) setSidebar(false);
  }

  function showSubscriptions() {
    if (inOverview) {
      listReturn.current = { top: scroll.current?.scrollTop ?? 0 };
      setDetailSearch(overviewSearch);
    }
    scroll.current?.scrollTo({ top: 0 });
    setSelected(SUBSCRIPTIONS_VIEW);
    if (compact) setSidebar(false);
  }

  const checkAllUpdates = () => {
    checks.forEach((c) => void c.refetch());
  };

  const hasProviders = !!plugin?.manifest.contributes.providers?.length;
  const hasTaskSources = !!plugin?.manifest.contributes.taskSources?.length;
  const hasEventSources = !!plugin?.manifest.contributes.eventSources?.length;
  const isChannel =
    !!plugin && (isFeishuPlugin(plugin) || isPersonalChannelPlugin(plugin));
  const hasRichConfig =
    isChannel || hasProviders || hasTaskSources || hasEventSources;

  return (
    <main
      className="workspace-frame plugins-page catalog-page"
      data-sidebar={sidebar}
      aria-label={t("nav.plugins")}
    >
      <SecondarySidebar
        id="plugin-sidebar"
        open={sidebar}
        onOpenChange={setSidebar}
        label={t(sidebar ? "nav.hideMenu" : "nav.showMenu")}
      >
        <div className="sidebar-heading">
          <h1>{t("nav.plugins")}</h1>
          <Button
            size="xs"
            aria-label={t("plugins.install")}
            title={t("plugins.install")}
            onClick={() => setPackageAction({ kind: "install" })}
          >
            <Plus />
            {t("plugins.installShort")}
          </Button>
        </div>
        <PluginIndex
          groups={indexGroups}
          selected={plugin?.id}
          subscriptionsActive={subscriptionsActive}
          updateCount={updatesCount}
          updateSettings={updateSettings}
          signalFor={signalFor}
          total={plugins.data?.length ?? 0}
          subscriptionCount={tracked.length}
          search={inOverview ? overviewSearch : detailSearch}
          onSearch={(value) => {
            if (!inOverview) setDetailSearch(value);
            else {
              setOverviewSearch(value);
              scroll.current?.scrollTo({ top: 0 });
            }
          }}
          onSelect={openPlugin}
          onOverview={showOverview}
          onSubscriptions={showSubscriptions}
          open={sidebar}
          onOpenChange={setSidebar}
          compact={compact}
          loading={!plugins.data}
        />
      </SecondarySidebar>

      <div className="plugins-scroll" ref={scroll} inert={overlayOpen}>
        {plugins.error && (
          <ErrorNotice
            error={plugins.error}
            retry={() => void plugins.refetch()}
          />
        )}

        <section
          className="plugins-library"
          hidden={!inOverview}
          aria-labelledby="plugin-library-title"
        >
          <header className="plugins-library-heading">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 id="plugin-library-title" ref={heading} tabIndex={-1}>
                  {t("plugins.overview")}
                </h2>
                <div className="plugins-results" role="status">
                  {plugins.data &&
                    t("plugins.results", { count: visible.length })}
                  {providers.isFetching && (
                    <span className="sr-only">{t("plugins.detecting")}</span>
                  )}
                </div>
              </div>
              <p className="plugins-library-subtitle">
                {t("plugins.overviewSubtitle")}
              </p>
            </div>
            <div className="plugins-overview-actions">
              <ToggleGroup
                type="single"
                size="sm"
                spacing={0}
                className="catalog-segments"
                aria-label={t("plugins.filterStatus")}
                value={status}
                onValueChange={(value) => value && setStatus(value)}
              >
                {(["all", "enabled", "attention", "off"] as const).map(
                  (value) => (
                    <ToggleGroupItem key={value} value={value}>
                      {t(`plugins.filter.${value}`)}
                    </ToggleGroupItem>
                  ),
                )}
              </ToggleGroup>
              <UpdatePolicyPopover
                compactLabel
                settings={updateSettings}
                hint={t("updates.pluginAutoHint")}
                pending={saveUpdateSettings.isPending}
                checking={checkingAny}
                hasSources={checks.length > 0}
                onSave={(next) => saveUpdateSettings.mutate(next)}
                onCheckAll={checkAllUpdates}
              />
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="relative text-muted-foreground data-[filtered=true]:text-foreground"
                    aria-label={filtersLabel}
                    aria-description={
                      origin !== "all" ? t("plugins.filtersApplied") : undefined
                    }
                    title={filtersLabel}
                    data-filtered={origin !== "all"}
                  >
                    <Funnel />
                    {origin !== "all" && (
                      <span
                        aria-hidden="true"
                        className="absolute end-1 top-1 size-1.5 rounded-full bg-foreground"
                      />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={6}
                  aria-label={filtersLabel}
                  className="grid max-h-(--radix-popover-content-available-height) w-68 max-w-(--radix-popover-content-available-width) gap-3 overflow-y-auto p-3"
                >
                  <div className="plugins-filter-group">
                    <span
                      id={originLabel}
                      className="text-xs text-muted-foreground"
                    >
                      {t("plugins.filterOrigin")}
                    </span>
                    <ToggleGroup
                      type="single"
                      size="sm"
                      spacing={1}
                      className="w-full flex-wrap"
                      aria-labelledby={originLabel}
                      value={origin}
                      onValueChange={(value) => {
                        if (value) setOrigin(value);
                      }}
                    >
                      {Object.entries(originOptions).map(([value, label]) => (
                        <ToggleGroupItem
                          key={value}
                          value={value}
                          className={filterOptionClass}
                        >
                          {t(label)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={plugins.isFetching || providers.isFetching}
                    onClick={() => {
                      void plugins.refetch();
                      void providers.refetch();
                    }}
                  >
                    <RefreshCw data-icon="inline-start" />
                    {t("plugins.refresh")}
                  </Button>
                </PopoverContent>
              </Popover>
              <Button
                size="sm"
                className="plugins-install-cta"
                aria-label={t("plugins.install")}
                onClick={() => setPackageAction({ kind: "install" })}
              >
                <Plus data-icon="inline-start" />
                <span>{t("plugins.install")}</span>
              </Button>
            </div>
          </header>

          {updatesCount > 0 && (
            <div className="plugins-info-banner" data-tone="update">
              <div className="plugins-info-banner-copy">
                <Download className="size-3.5 shrink-0" />
                <span>
                  {t("plugins.updatesAvailableBanner", { count: updatesCount })}
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={showSubscriptions}>
                {t("plugins.reviewUpdates")}
              </Button>
            </div>
          )}

          {providers.error && (
            <ErrorNotice
              error={providers.error}
              retry={() => void providers.refetch()}
            />
          )}

          {plugins.isPending ? (
            <Loading className="p-0">
              <div className="plugins-grid">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-28" />
                ))}
              </div>
            </Loading>
          ) : (
            <div className="plugins-grid plugins-groups">
              {groups.map(({ id, label, icon: Icon, entries }) => (
                <section
                  key={id}
                  className="plugins-group"
                  aria-labelledby={`plugin-group-${id}`}
                  data-count={entries.length}
                >
                  <div className="plugins-group-heading">
                    <Icon size={15} aria-hidden="true" />
                    <h3 id={`plugin-group-${id}`}>{t(label)}</h3>
                    <span>{entries.length}</span>
                    {id !== "other" && (
                      <span className="plugins-group-target">
                        {t(`plugins.target.${id}`)}
                      </span>
                    )}
                  </div>
                  {entries.map((entry) => {
                    const channel = isFeishuPlugin(entry)
                      ? feishu.data
                      : undefined;
                    const taskSourceCount = taskSources.data?.filter(
                      (s) => s.pluginId === entry.id,
                    ).length;
                    const eventConsumerCount = automations.data?.filter(
                      (a) => a.trigger.source?.pluginId === entry.id,
                    ).length;
                    return (
                      <PluginCard
                        key={entry.id}
                        plugin={entry}
                        updateAvailable={
                          checkByID.get(entry.id)?.data?.available
                        }
                        checkFailed={checkByID.get(entry.id)?.isError}
                        providers={providers.data}
                        signal={signalFor(entry)}
                        channel={channel}
                        channelAgentName={
                          channel ? feishuAgent?.name : undefined
                        }
                        taskSourceCount={taskSourceCount}
                        eventConsumerCount={eventConsumerCount}
                        enableControl={enableControl(entry, "sm")}
                        onOpen={(trigger) => openPlugin(entry.id, trigger)}
                      />
                    );
                  })}
                </section>
              ))}
            </div>
          )}

          {!visible.length && !plugins.isPending && !plugins.error && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LayoutGrid />
                </EmptyMedia>
                <EmptyTitle>{t("plugins.noMatches")}</EmptyTitle>
              </EmptyHeader>
              {filtered && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setOverviewSearch("");
                    setStatus("all");
                    setOrigin("all");
                  }}
                >
                  {t("plugins.resetFilters")}
                </Button>
              )}
            </Empty>
          )}
        </section>

        {subscriptionsActive && (
          <PluginSubscriptionsView
            plugins={plugins.data ?? []}
            settings={updateSettings}
            settingsPending={saveUpdateSettings.isPending}
            checkByID={checkByID}
            checkingAny={checkingAny}
            onSaveSettings={(next) => saveUpdateSettings.mutate(next)}
            onCheckAll={checkAllUpdates}
            onSavePluginPolicy={(id, updatePolicy) =>
              update.mutate({ id, updatePolicy })
            }
            onReloadLocal={(id) => reload.mutate(id)}
            reloadingId={reload.isPending ? reload.variables : undefined}
            onPackageAction={setPackageAction}
            onAutoUpdated={packageSaved}
            onOpenPlugin={(id) => openPlugin(id)}
            onBack={showOverview}
            onInstall={() => setPackageAction({ kind: "install" })}
          />
        )}

        {plugin && detailSignal && (
          <article className="plugins-detail">
            <div className="plugins-detail-topline">
              <Button
                variant="ghost"
                size="sm"
                className="plugins-back"
                onClick={showOverview}
              >
                <ArrowLeft data-icon="inline-start" />
                {t("plugins.back")}
              </Button>
              <span className="plugin-origin-pill">
                {t(pluginKindLabel(plugin))} ·{" "}
                {t(
                  plugin.builtin
                    ? "plugins.builtin"
                    : plugin.current
                      ? "plugins.git"
                      : "plugins.local",
                )}
              </span>
            </div>

            <div className="plugins-title">
              <div className="plugins-detail-identity">
                <span className="plugin-icon">
                  <PluginIcon plugin={plugin} size={26} />
                </span>
                <div className="min-w-0">
                  <div className="plugins-detail-name">
                    <h2 ref={detailHeading} tabIndex={-1}>
                      {pluginName(plugin, t)}
                    </h2>
                    <span
                      className="plugins-pill"
                      data-tone={detailSignal.tone}
                    >
                      {detailSignal.label}
                    </span>
                    {nextCommit && (
                      <span className="plugins-pill" data-tone="running">
                        {t("plugins.updateAvailable")}
                      </span>
                    )}
                  </div>
                  <p className="plugins-description">
                    {pluginDescription(plugin, t)}
                  </p>
                </div>
              </div>
              <div className="plugins-detail-actions">
                {!plugin.builtin && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("plugins.uninstall", {
                      name: pluginName(plugin, t),
                    })}
                    disabled={uninstall.isPending || update.isPending}
                    onClick={() => uninstall.mutate(plugin.id)}
                  >
                    <Trash2 />
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  {t(plugin.enabled ? "plugins.filter.enabled" : "plugins.off")}
                </span>
                {enableControl(plugin)}
              </div>
            </div>

            {hasRichConfig && (
              <div className="plugins-sub-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className="plugins-sub-tab"
                  aria-selected={detailTab === "config"}
                  onClick={() => setDetailTab("config")}
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden="true" />
                  {t("plugins.tabConfig")}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="plugins-sub-tab"
                  aria-selected={detailTab === "package"}
                  onClick={() => setDetailTab("package")}
                >
                  <GitBranch className="size-3.5" aria-hidden="true" />
                  {t("plugins.tabPackage")}
                  {nextCommit && (
                    <span
                      className="plugins-status-dot"
                      data-tone="running"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </div>
            )}

            {hasRichConfig && detailTab === "config" && (
              <div className="flex flex-col gap-5">
                {isFeishuPlugin(plugin) && (
                  <FeishuChannel agents={agents} onOpenChat={onOpenChat} />
                )}
                {isPersonalChannelPlugin(plugin) && (
                  <PersonalChannel
                    key={plugin.id}
                    plugin={plugin}
                    agents={agents}
                    onOpenChat={onOpenChat}
                    onOpenReceipt={onOpenPersonalReceipt}
                  />
                )}
                {hasProviders && (
                  <div className="flex flex-col gap-4">
                    <div className="plugins-info-banner">
                      <div className="plugins-info-banner-copy">
                        <RefreshCw className="size-3.5 shrink-0 text-[var(--status-positive)]" />
                        <span>{t("plugins.sharedProvidersHint")}</span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onManageConnections(plugin.id)}
                      >
                        {t("connections.manage")}
                        <ArrowUpRight data-icon="inline-end" />
                      </Button>
                    </div>
                    {!plugin.enabled && (
                      <p className="plugins-disabled-note" role="status">
                        {t("plugins.disabledHint")}
                      </p>
                    )}
                    <SettingsProviders
                      key={plugin.id}
                      pluginId={plugin.id}
                      visible
                      embedded
                    />
                  </div>
                )}
                {hasTaskSources && (
                  <PluginTaskSourcesPanel
                    plugin={plugin}
                    onOpenWorks={onOpenWorks}
                  />
                )}
                {hasEventSources && (
                  <PluginEventSourcesPanel
                    plugin={plugin}
                    agents={agents}
                    onOpenAutomations={onOpenAutomations}
                  />
                )}
              </div>
            )}

            {(!hasRichConfig || detailTab === "package") && (
              <section
                className="plugins-panel panel-surface"
                aria-label={t("plugins.packageVersion")}
              >
                <div className="plugins-panel-head">
                  <h3>{t("plugins.packageVersion")}</h3>
                  <Badge variant="outline" className="font-mono text-[11px]">
                    v{plugin.manifest.version}
                  </Badge>
                </div>
                <div className="divide-y divide-border/60">
                  <div className="plugins-panel-row">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">
                        {plugin.manifest.id}
                      </div>
                      <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                        {plugin.builtin
                          ? t("plugins.builtinRelease")
                          : plugin.current
                            ? [
                                plugin.current.source.url,
                                plugin.current.source.path,
                                `${plugin.current.source.ref} · ${plugin.current.commit.slice(0, 8)}`,
                                plugin.current.source.kind !== "branch"
                                  ? t("plugins.pinned")
                                  : undefined,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : plugin.directory}
                      </p>
                    </div>
                    {!plugin.builtin && !plugin.current && plugin.directory && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={reload.isPending}
                        onClick={() => reload.mutate(plugin.id)}
                      >
                        <RefreshCw
                          data-icon="inline-start"
                          className={
                            reload.isPending ? "animate-spin" : undefined
                          }
                        />
                        {t("plugins.reload")}
                      </Button>
                    )}
                  </div>

                  {plugin.current && (
                    <>
                      <div className="plugins-panel-row flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium">
                            {t("plugins.itemPolicyTitle")}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("plugins.itemPolicyHint")}
                          </p>
                        </div>
                        <ToggleGroup
                          type="single"
                          size="sm"
                          variant="outline"
                          spacing={0}
                          aria-label={t("plugins.itemPolicyTitle")}
                          value={plugin.updatePolicy ?? "inherit"}
                          disabled={update.isPending}
                          onValueChange={(value) => {
                            if (
                              value &&
                              value !== (plugin.updatePolicy ?? "inherit")
                            ) {
                              update.mutate({
                                id: plugin.id,
                                updatePolicy: value as NonNullable<
                                  Plugin["updatePolicy"]
                                >,
                              });
                            }
                          }}
                        >
                          {policyValues.map((value) => (
                            <ToggleGroupItem
                              key={value}
                              value={value}
                              className="text-xs"
                            >
                              {t(`updates.policy.${value}`)}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                        {nextCommit && (
                          <>
                            <Button
                              size="sm"
                              onClick={() =>
                                setPackageAction({
                                  kind: "update",
                                  plugin,
                                  commit: nextCommit,
                                })
                              }
                            >
                              {t("plugins.reviewUpdate")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={autoApply.isPending}
                              onClick={() => autoApply.mutate(plugin)}
                            >
                              <ShieldCheck data-icon="inline-start" />
                              {t("plugins.autoApplySafe")}
                            </Button>
                          </>
                        )}
                        {check && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={check.isFetching}
                            onClick={() => void check.refetch()}
                          >
                            {t("plugins.checkUpdates")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPackageAction({ kind: "select", plugin })
                          }
                        >
                          {t("plugins.selectVersion")}
                        </Button>
                        {plugin.previous && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={releaseLabel(plugin.previous)}
                            onClick={() =>
                              setPackageAction({ kind: "rollback", plugin })
                            }
                          >
                            <RotateCcw data-icon="inline-start" />
                            {t("plugins.rollback")}
                          </Button>
                        )}
                        {check?.isSuccess && !check.data.available && (
                          <span className="ms-auto text-xs text-muted-foreground">
                            {t("plugins.upToDate")}
                          </span>
                        )}
                      </div>
                      {check?.isError && (
                        <div className="px-4 py-3">
                          <ErrorNotice error={check.error} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </section>
            )}
          </article>
        )}
      </div>

      {packageAction && (
        <PluginPackageDialog
          action={packageAction}
          onClose={() => setPackageAction(null)}
          onSaved={packageSaved}
        />
      )}
    </main>
  );
}
