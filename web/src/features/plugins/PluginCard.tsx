import { Mail, MessagesSquare, Rss, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import type { ChannelView, Plugin, ProviderInfo } from "@/api/types.gen";
import { RuntimeIcon } from "@/components/RuntimeIcon";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { feishuStatus } from "./channelQuery";
import larkMark from "./icons/lark.svg";

export function pluginRuntimeStatus(
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
  return isFeishuPlugin(plugin) ? t("channels.feishu") : plugin.manifest.name;
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
  const EventIcon = eventSource?.id === "new-email" ? Mail : Zap;
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
  detectionFailed,
  updateAvailable,
  checkFailed,
  channel,
  channelAgentName,
  enableControl,
  onOpen,
}: {
  plugin: Plugin;
  providers?: ProviderInfo[];
  detectionFailed?: boolean;
  updateAvailable?: boolean;
  checkFailed?: boolean;
  channel?: ChannelView;
  channelAgentName?: string;
  enableControl: ReactNode;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation();
  const description = pluginDescription(plugin, t);
  const name = pluginName(plugin, t);
  const runtimeStatus = pluginRuntimeStatus(plugin, providers, detectionFailed);
  const channelStatus =
    plugin.enabled && channel ? feishuStatus(channel) : undefined;
  const status = runtimeStatus ?? channelStatus;
  const route =
    channel?.ownerName &&
    [channel.ownerName, channelAgentName].filter(Boolean).join(" → ");
  const connections = providers?.filter((p) => p.pluginId === plugin.id);
  const signedOut = connections?.filter(
    (p) => p.available && p.loginStatus === "signedOut",
  ).length;
  const needsSetup = connections?.filter(
    (p) => p.available && (!p.installed || p.error),
  ).length;
  return (
    <Card size="sm" className="plugin-card" role="group" aria-label={name}>
      <CardHeader>
        <CardTitle className="min-w-0">
          <Button
            variant="ghost"
            className="plugin-card-open"
            title={`${name}\n${description}`}
            aria-label={t("plugins.configure", { name })}
            aria-describedby={`plugin-summary-${plugin.id}`}
            onClick={(event) => onOpen(event.currentTarget)}
          >
            <PluginIcon plugin={plugin} size={24} />
            <span className="truncate">{name}</span>
          </Button>
        </CardTitle>
        <CardAction>{enableControl}</CardAction>
      </CardHeader>
      <CardContent>
        <CardDescription
          id={`plugin-summary-${plugin.id}`}
          className="line-clamp-2"
        >
          {description}
        </CardDescription>
        <div className="plugin-card-meta">
          {updateAvailable && <span>{t("plugins.updateAvailable")}</span>}
          {checkFailed && <span>{t("plugins.checkFailed")}</span>}
          {!plugin.enabled ? (
            <span>{t("plugins.off")}</span>
          ) : runtimeStatus && connections ? (
            <span>{t("connections.count", { count: connections.length })}</span>
          ) : (
            status && (
              <span
                className={
                  runtimeStatus
                    ? "plugin-status"
                    : "plugin-status channel-status"
                }
                data-status={status}
              >
                <span aria-hidden="true" />
                {t(
                  runtimeStatus
                    ? `plugins.status.${status}`
                    : `channels.status.${status}`,
                )}
              </span>
            )
          )}
          {plugin.enabled && !!signedOut && (
            <span>{t("connections.signedOutCount", { count: signedOut })}</span>
          )}
          {plugin.enabled && !!needsSetup && (
            <span>{t("connections.setupCount", { count: needsSetup })}</span>
          )}
          {runtimeStatus === "runtimesOff" && (
            <span>{t("plugins.status.runtimesOff")}</span>
          )}
          {route && <span>{route}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
