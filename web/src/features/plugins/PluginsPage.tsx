import { useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Download,
  Funnel,
  LayoutGrid,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { Agent, Plugin, PluginUpdate } from "@/api/types.gen";
import { api, queryClient } from "@/api/client";
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
import { connectionsQuery } from "@/features/runtime/queries";
import {
  PluginCard,
  PluginIcon,
  isFeishuPlugin,
  isPersonalChannelPlugin,
  pluginDescription,
  pluginName,
  pluginRuntimeStatus,
} from "./PluginCard";
import { FeishuChannel } from "./FeishuChannel";
import { PersonalChannel } from "./PersonalChannel";
import { useFeishuChannel } from "./channelQuery";
import { pluginsQuery } from "./pluginsQuery";
import {
  PluginPackageDialog,
  releaseLabel,
  type PackageAction,
} from "./PluginPackageDialog";
import { PluginIndex } from "./PluginIndex";
import { groupPlugins } from "./pluginGroups";
import "./plugins.css";
const originOptions = {
  all: "plugins.filter.all",
  builtin: "plugins.builtin",
  local: "plugins.local",
  git: "plugins.git",
} as const;
const filterOptionClass =
  "px-1.5 text-xs text-muted-foreground data-[state=on]:text-foreground";

export default function PluginsPage({
  agents,
  initialPlugin,
  onManageConnections,
  onOpenChat,
}: {
  agents: Agent[];
  initialPlugin?: string;
  onManageConnections: (pluginId: string) => void;
  onOpenChat: (chatId: string, agentId: string, title: string) => void;
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
  const [selected, setSelected] = useState(initialPlugin ?? "");
  const { compact, sidebar, setSidebar } = useSecondarySidebarState();
  const overlayOpen = compact && sidebar;
  const [overviewSearch, setOverviewSearch] = useState("");
  const [detailSearch, setDetailSearch] = useState("");
  const [origin, setOrigin] = useState("all");
  const [status, setStatus] = useState("all");
  const statusLabel = useId();
  const originLabel = useId();
  const [packageAction, setPackageAction] = useState<PackageAction | null>(
    null,
  );
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
  const scroll = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listReturn = useRef<{ top: number; trigger?: HTMLElement } | null>(
    null,
  );
  const plugin = plugins.data?.find((plugin) => plugin.id === selected);
  const check = plugin ? checkByID.get(plugin.id) : undefined;
  const nextCommit =
    check?.data?.available && !check.isError ? check.data.commit : undefined;
  useLayoutEffect(() => {
    if (overlayOpen) return;
    if (plugin) {
      detailHeading.current?.focus({ preventScroll: true });
      return;
    }
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
  }, [plugin?.id, overlayOpen]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
    void queryClient.invalidateQueries({ queryKey: ["models"] });
    void queryClient.invalidateQueries({ queryKey: ["channel"] });
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
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/plugins/${id}`, { enabled }, "PUT"),
    onSuccess: async (_, { id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ["plugins"] });
      queryClient.setQueryData<Plugin[]>(["plugins"], (plugins) =>
        plugins?.map((plugin) =>
          plugin.id === id ? { ...plugin, enabled } : plugin,
        ),
      );
      refresh();
    },
    onError: (error) => toast.error(error.message),
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
  const eligible = (plugins.data ?? []).filter((plugin) => {
    const state = pluginRuntimeStatus(
      plugin,
      providers.data,
      providers.isError,
    );
    return (
      (origin === "all" ||
        origin ===
          (plugin.builtin ? "builtin" : plugin.current ? "git" : "local")) &&
      (status === "all" ||
        (status === "enabled"
          ? plugin.enabled
          : status === "off"
            ? !plugin.enabled
            : state === "needsSetup"))
    );
  });
  const groups = groupPlugins(
    eligible,
    overviewSearch,
    t,
    i18n.resolvedLanguage,
  );
  const indexGroups = plugin
    ? groupPlugins(plugins.data ?? [], detailSearch, t, i18n.resolvedLanguage)
    : groups;
  const visible = groups.flatMap((group) => group.entries);
  const feishu = useFeishuChannel(
    !plugin && visible.some(isFeishuPlugin),
    true,
  );
  const feishuAgent = agents.find((agent) => agent.id === feishu.data?.agentId);
  const enableControl = (
    plugin: Plugin,
    size: "sm" | "default" = "default",
  ) => (
    <Switch
      size={size}
      aria-label={t("plugins.enabled", { name: pluginName(plugin, t) })}
      checked={plugin.enabled}
      disabled={update.isPending || uninstall.isPending}
      onCheckedChange={(enabled) => update.mutate({ id: plugin.id, enabled })}
    />
  );
  function openPlugin(id: string, trigger?: HTMLElement) {
    if (!plugin) {
      listReturn.current = { top: scroll.current?.scrollTop ?? 0, trigger };
      setDetailSearch(overviewSearch);
    }
    if (id !== selected) scroll.current?.scrollTo({ top: 0 });
    setSelected(id);
    if (compact) setSidebar(false);
  }
  function showOverview() {
    setSelected("");
    if (compact) setSidebar(false);
  }
  return (
    <main
      className="workspace-frame plugins-page"
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
            variant="ghost"
            size="icon-sm"
            aria-label={t("plugins.install")}
            title={t("plugins.install")}
            onClick={() => setPackageAction({ kind: "install" })}
          >
            <Plus />
          </Button>
        </div>
        <PluginIndex
          groups={indexGroups}
          selected={plugin?.id}
          search={plugin ? detailSearch : overviewSearch}
          onSearch={(value) => {
            if (plugin) setDetailSearch(value);
            else {
              setOverviewSearch(value);
              scroll.current?.scrollTo({ top: 0 });
            }
          }}
          onSelect={openPlugin}
          onOverview={showOverview}
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
          hidden={!!plugin}
          aria-labelledby="plugin-library-title"
        >
          <header className="plugins-library-heading">
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
            <div className="plugins-overview-actions">
              {checks.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("plugins.checkUpdates")}
                  title={t("plugins.checkUpdates")}
                  disabled={checks.some((c) => c.isFetching)}
                  onClick={() => checks.forEach((c) => void c.refetch())}
                >
                  <Download data-icon="inline-start" />
                  <span>{t("plugins.checkUpdates")}</span>
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("plugins.refresh")}
                title={t("plugins.refresh")}
                disabled={plugins.isFetching || providers.isFetching}
                onClick={() => {
                  void plugins.refetch();
                  void providers.refetch();
                }}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={
                    plugins.isFetching || providers.isFetching
                      ? "animate-spin"
                      : undefined
                  }
                />
                <span>{t("plugins.refresh")}</span>
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="relative text-muted-foreground data-[filtered=true]:text-foreground"
                    aria-label={filtersLabel}
                    aria-description={
                      hasFilters ? t("plugins.filtersApplied") : undefined
                    }
                    title={filtersLabel}
                    data-filtered={hasFilters}
                  >
                    <Funnel />
                    {hasFilters && (
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
                      id={statusLabel}
                      className="text-xs text-muted-foreground"
                    >
                      {t("plugins.filterStatus")}
                    </span>
                    <ToggleGroup
                      type="single"
                      size="sm"
                      spacing={1}
                      className="w-full flex-wrap"
                      aria-labelledby={statusLabel}
                      value={status}
                      onValueChange={(value) => {
                        if (value) setStatus(value);
                      }}
                    >
                      {["all", "enabled", "off", "needsSetup"].map((value) => (
                        <ToggleGroupItem
                          key={value}
                          value={value}
                          className={filterOptionClass}
                        >
                          {t(`plugins.filter.${value}`)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
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
                </PopoverContent>
              </Popover>
            </div>
          </header>
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
                  <Skeleton key={index} className="h-24" />
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
                  </div>
                  {entries.map((entry) => {
                    const channel = isFeishuPlugin(entry)
                      ? feishu.data
                      : undefined;
                    return (
                      <PluginCard
                        key={entry.id}
                        plugin={entry}
                        updateAvailable={
                          checkByID.get(entry.id)?.data?.available
                        }
                        checkFailed={checkByID.get(entry.id)?.isError}
                        providers={providers.data}
                        detectionFailed={providers.isError}
                        channel={channel}
                        channelAgentName={
                          channel ? feishuAgent?.name : undefined
                        }
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
        {plugin && (
          <article className="plugins-detail">
            <Button
              variant="ghost"
              size="sm"
              className="plugins-back"
              onClick={showOverview}
            >
              <ArrowLeft data-icon="inline-start" />
              {t("plugins.back")}
            </Button>
            <div className="plugins-title">
              <div className="plugins-detail-identity">
                <span className="plugin-icon">
                  <PluginIcon plugin={plugin} size={28} />
                </span>
                <div>
                  <h2 ref={detailHeading} tabIndex={-1}>
                    {pluginName(plugin, t)}
                  </h2>
                  <div className="plugins-detail-meta">
                    <span>v{plugin.manifest.version}</span>
                    <Badge variant="outline">
                      {t(
                        plugin.builtin
                          ? "plugins.builtin"
                          : plugin.current
                            ? "plugins.git"
                            : "plugins.local",
                      )}
                    </Badge>
                  </div>
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
                {enableControl(plugin)}
              </div>
            </div>
            {plugin.current && (
              <section
                className="grid gap-2"
                aria-label={t("plugins.packageVersion")}
              >
                <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground break-all">
                  <span>{plugin.current.source.url}</span>
                  {plugin.current.source.path && (
                    <code>{plugin.current.source.path}</code>
                  )}
                  <span>
                    {plugin.current.source.ref} ·{" "}
                    {plugin.current.commit.slice(0, 8)}
                  </span>
                  {plugin.current.source.kind !== "branch" && (
                    <span>{t("plugins.pinned")}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {nextCommit && (
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
                    onClick={() => setPackageAction({ kind: "select", plugin })}
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
                      {t("plugins.rollback")}
                    </Button>
                  )}
                  {check?.isSuccess && !check.data.available && (
                    <span className="text-xs text-muted-foreground">
                      {t("plugins.upToDate")}
                    </span>
                  )}
                </div>
                {check?.isError && <ErrorNotice error={check.error} />}
              </section>
            )}
            {!plugin.builtin && !plugin.current && plugin.directory && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reload.isPending}
                  onClick={() => reload.mutate(plugin.id)}
                >
                  {t("plugins.reload")}
                </Button>
              </div>
            )}
            {isFeishuPlugin(plugin) ? (
              <FeishuChannel agents={agents} onOpenChat={onOpenChat} />
            ) : isPersonalChannelPlugin(plugin) ? (
              <PersonalChannel
                key={plugin.id}
                plugin={plugin}
                agents={agents}
                onOpenChat={onOpenChat}
              />
            ) : (
              <>
                <p className="plugins-description">
                  {pluginDescription(plugin, t)}
                </p>
                <div className="plugins-package-info">
                  <code>{plugin.manifest.id}</code>
                  {!!plugin.manifest.contributes.providers?.length && (
                    <span>
                      {t("plugins.kind.providers")}
                      {providers.data &&
                        ` · ${t("connections.count", {
                          count: providers.data.filter(
                            (p) => p.pluginId === plugin.id,
                          ).length,
                        })}`}
                    </span>
                  )}
                  {!!plugin.manifest.contributes.taskSources?.length && (
                    <span>{t("plugins.kind.taskSources")}</span>
                  )}
                  {!!plugin.manifest.contributes.eventSources?.length && (
                    <span>{t("plugins.kind.eventSources")}</span>
                  )}
                  {!plugin.current && plugin.directory && (
                    <code>{plugin.directory}</code>
                  )}
                </div>
                {!plugin.enabled &&
                  !!plugin.manifest.contributes.providers?.length && (
                    <p className="plugins-disabled-note" role="status">
                      {t("plugins.disabledHint")}
                    </p>
                  )}
                {!!plugin.manifest.contributes.providers?.length && (
                  <Button
                    className="self-start"
                    variant="outline"
                    onClick={() => onManageConnections(plugin.id)}
                  >
                    {t("connections.manage")}
                  </Button>
                )}
              </>
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
