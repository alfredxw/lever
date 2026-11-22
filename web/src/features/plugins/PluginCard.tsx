import { ChevronRight, Mail, MessagesSquare, Rss, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import type { ChannelView, Plugin, ProviderInfo } from "@/api/types.gen";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { Button } from "@/components/ui/button";
import { feishuStatus } from "./channelQuery";
import larkMark from "./icons/lark.svg";

function pluginRuntimeStatus(
  plugin: Plugin,
  providers?: ProviderInfo[],
  detectionFailed = false,
) {
  if (!plugin.enabled || !plugin.manifest.contributes.providers?.length) return;
  if (!providers) return detectionFailed ? "detectionFailed" : "checking";
  const configured = providers.filter(
    (provider) => provider.pluginId === plugin.id,
  );
  if (!configured.length) return "notConfigured";
  const enabled = configured.filter((provider) => provider.enabled);
  if (!enabled.length) return "runtimesOff";
  return enabled.some(
    (provider) =>
      !provider.installed ||
      provider.error ||
      provider.loginStatus === "signedOut",
  )
    ? "needsSetup"
    : "detected";
}

export type PluginSignal = {
  label: string;
  tone: "muted" | "positive" | "attention" | "running" | "error";
};

export function pluginSignal(
  plugin: Plugin,
  providers: ProviderInfo[] | undefined,
  detectionFailed: boolean,
  channel: ChannelView | undefined,
  t: TFunction,
): PluginSignal {
  if (!plugin.enabled) return { label: t("plugins.off"), tone: "muted" };
  const status = pluginRuntimeStatus(plugin, providers, detectionFailed);
  if (status) {
    const tones = {
      detected: "positive",
      needsSetup: "attention",
      notConfigured: "attention",
      runtimesOff: "muted",
      checking: "muted",
      detectionFailed: "error",
    } as const;
    return { label: t(`plugins.status.${status}`), tone: tones[status] };
  }
  if (channel) {
    const state = feishuStatus(channel);
    if (!state) return { label: t("plugins.channelOff"), tone: "muted" };
    return {
      label: t(`channels.status.${state}`),
      tone:
        state === "online"
          ? "positive"
          : state === "connecting"
            ? "running"
            : state === "error"
              ? "error"
              : "attention",
    };
  }
  return { label: t("plugins.filter.enabled"), tone: "muted" };
}

export function pluginDescription(plugin: Plugin, t: TFunction) {
  const capability =
    plugin.manifest.contributes.providers?.[0]?.id ??
    plugin.manifest.contributes.taskSources?.[0]?.id ??
    plugin.manifest.contributes.channels?.[0]?.id ??
    plugin.manifest.contributes.eventSources?.[0]?.id;
  return (
    plugin.manifest.description ||
    t(
      plugin.builtin && capability
        ? `plugins.description.${capability}`
        : "plugins.description.local",
    )
  );
}

export const isFeishuPlugin = (plugin: Plugin) => plugin.id === "lever.feishu";
export const isPersonalChannelPlugin = (plugin: Plugin) =>
  !!plugin.manifest.contributes.channels?.some(
    (channel) => channel.driver === "personal-stdio-v1",
  );

export function pluginName(plugin: Plugin, t: TFunction) {
  if (isFeishuPlugin(plugin)) return t("channels.feishu");
  if (plugin.id === "lever.lark-todos") return t("tasks.source.lark-todos");
  if (plugin.id === "lever.imap-mail") return t("plugins.name.imap-mail");
  return plugin.manifest.name;
}

export function PluginIcon({ plugin, size }: { plugin: Plugin; size: number }) {
  if (plugin.id === "lever.github") {
    return (
      <span
        aria-hidden="true"
        className="plugin-github-icon"
        style={{ width: size, height: size }}
      />
    );
  }
  if (
    plugin.id === "lever.feishu" ||
    plugin.id === "lever.lark-todos" ||
    isPersonalChannelPlugin(plugin)
  ) {
    return (
      <img
        src={larkMark}
        alt=""
        width={size}
        height={size}
        className="shrink-0"
      />
    );
  }
  const driver = plugin.manifest.contributes.providers?.[0]?.driver;
  const eventSource = plugin.manifest.contributes.eventSources?.[0];
  const EventIcon =
    plugin.id === "lever.imap-mail" && eventSource?.id === "new-email"
      ? Mail
      : Zap;
  return driver ? (
    <RuntimeIcon provider={{ pluginId: plugin.id, type: driver }} size={size} />
  ) : plugin.manifest.contributes.channels?.length ? (
    <MessagesSquare width={size} height={size} aria-hidden="true" />
  ) : eventSource ? (
    <EventIcon width={size} height={size} aria-hidden="true" />
  ) : (
    <Rss width={size} height={size} aria-hidden="true" />
  );
}

export function PluginCard({
  plugin,
  providers,
  signal,
  updateAvailable,
  checkFailed,
  channel,
  channelAgentName,
  taskSourceCount,
  eventConsumerCount,
  enableControl,
  onOpen,
}: {
  plugin: Plugin;
  providers?: ProviderInfo[];
  signal: PluginSignal;
  updateAvailable?: boolean;
  checkFailed?: boolean;
  channel?: ChannelView;
  channelAgentName?: string;
  taskSourceCount?: number;
  eventConsumerCount?: number;
  enableControl: ReactNode;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  const description = pluginDescription(plugin, t);
  const name = pluginName(plugin, t);
  const route =
    channel?.ownerName &&
    [channel.ownerName, channelAgentName].filter(Boolean).join(" → ");
  const connections = providers?.filter((p) => p.pluginId === plugin.id);
  const signedOut = connections?.filter(
    (p) => p.enabled && p.loginStatus === "signedOut",
  ).length;
  const needsSetup = connections?.filter(
    (p) => p.enabled && (!p.installed || p.error),
  ).length;
  const originKey = plugin.builtin
    ? "plugins.builtin"
    : plugin.current
      ? "plugins.git"
      : "plugins.local";
  const hasTaskSources = !!plugin.manifest.contributes.taskSources?.length;
  const hasEventSources = !!plugin.manifest.contributes.eventSources?.length;

  const metric = [
    plugin.manifest.contributes.providers?.length && connections
      ? t("connections.count", { count: connections.length })
      : undefined,
    plugin.enabled && signedOut
      ? t("connections.signedOutCount", { count: signedOut })
      : undefined,
    plugin.enabled && needsSetup
      ? t("connections.setupCount", { count: needsSetup })
      : undefined,
    hasTaskSources && taskSourceCount !== undefined
      ? t("plugins.taskSource.count", { count: taskSourceCount })
      : undefined,
    hasEventSources && eventConsumerCount !== undefined
      ? t("plugins.eventSource.count", { count: eventConsumerCount })
      : undefined,
    route,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="plugin-card"
      data-enabled={plugin.enabled}
      role="group"
      aria-label={name}
    >
      <div className="plugin-card-top">
        <span className="plugin-card-mark">
          <PluginIcon plugin={plugin} size={18} />
        </span>
        <div className="plugin-card-copy">
          <div className="plugin-card-title">
            <Button
              variant="ghost"
              className="plugin-card-open"
              title={name}
              aria-label={t("plugins.configure", { name })}
              aria-describedby={`plugin-summary-${plugin.id}`}
              onClick={(event) => onOpen(event.currentTarget)}
            >
              <span className="truncate">{name}</span>
            </Button>
            <span className="plugin-origin-pill">{t(originKey)}</span>
          </div>
          <p
            id={`plugin-summary-${plugin.id}`}
            className="plugin-card-description line-clamp-2"
            title={description}
          >
            {description}
          </p>
        </div>
        <div className="plugin-card-switch">{enableControl}</div>
      </div>
      <div className="plugin-card-strip">
        <div
          className="plugin-card-meta"
          title={[signal.label, metric].filter(Boolean).join(" · ")}
        >
          <span
            className="plugins-status-dot"
            data-tone={signal.tone}
            aria-hidden="true"
          />
          <span className="plugin-signal-label" data-tone={signal.tone}>
            {signal.label}
          </span>
          {metric && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{metric}</span>
            </>
          )}
        </div>
        {updateAvailable && !checkFailed && (
          <span className="plugins-pill" data-tone="running">
            {t("plugins.updateAvailable")}
          </span>
        )}
        {checkFailed && (
          <span className="plugins-pill" data-tone="attention">
            {t("plugins.checkFailed")}
          </span>
        )}
        <span className="plugin-card-cta" aria-hidden="true">
          {t("plugins.configureAction")}
          <ChevronRight className="size-3" />
        </span>
      </div>
    </div>
  );
}
