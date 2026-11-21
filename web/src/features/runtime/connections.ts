import type { TFunction } from "i18next";
import type { Provider, ProviderInfo } from "@/api/types.gen";

function hasSibling(p: ProviderInfo, peers: ProviderInfo[]) {
  return peers.some(
    (item) =>
      item.id !== p.id &&
      item.pluginId === p.pluginId &&
      item.contributionId === p.contributionId,
  );
}

export function hasConnectionLabel(p: ProviderInfo, peers: ProviderInfo[]) {
  return (
    !!p.contributionName &&
    (p.name !== p.contributionName || hasSibling(p, peers))
  );
}

export function connectionName(
  p: ProviderInfo,
  peers: ProviderInfo[],
  t: TFunction,
) {
  const brand = p.contributionName;
  if (!brand || !hasSibling(p, peers)) return p.name;
  if (p.name !== brand)
    return p.name.startsWith(brand) ? p.name : `${brand} · ${p.name}`;
  const profile = p.configDir?.split(/[\\/]/).filter(Boolean).at(-1);
  if (!p.configPath && p.type !== "antigravity")
    return `${brand} · ${[p.command || p.type, ...p.args].join(" ")}`;
  return `${brand} · ${profile || t(p.type === "antigravity" && p.auth !== "cli" ? "antigravity.managed" : "connections.localDefault")}`;
}

export function connectionStatus(p: ProviderInfo) {
  if (!p.available) return "plugins.off";
  if (!p.installed) return "settings.notInstalled";
  if (p.error) return "plugins.status.needsSetup";
  if (p.loginStatus === "signedIn") return "connections.signedIn";
  if (p.loginStatus === "signedOut") return "connections.signedOut";
  return "connections.detected";
}

export const providerConfiguration = (p: ProviderInfo): Provider => ({
  pluginId: p.pluginId,
  contributionId: p.contributionId,
  id: p.id,
  type: p.type,
  name: p.name,
  enabled: p.enabled,
  command: p.command,
  args: p.args,
  configDir: p.configDir,
  shadowHome: p.shadowHome,
  autoCompactWindow: p.autoCompactWindow,
  idleCompaction: p.idleCompaction,
  authMethod: p.authMethod,
  gcpProject: p.gcpProject,
  gcpLocation: p.gcpLocation,
});
