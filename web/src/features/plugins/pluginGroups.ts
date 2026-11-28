import { Bot, MessagesSquare, Puzzle, Rss, Zap } from "lucide-react";
import type { TFunction } from "i18next";
import type { Plugin, PluginContributions } from "@/api/types.gen";
import { pluginDescription, pluginName } from "./PluginCard";

const kinds = {
  providers: { label: "plugins.kind.providers", icon: Bot },
  taskSources: { label: "plugins.kind.taskSources", icon: Rss },
  channels: { label: "plugins.kind.channels", icon: MessagesSquare },
  eventSources: { label: "plugins.kind.eventSources", icon: Zap },
} as const satisfies Record<
  keyof PluginContributions,
  { label: string; icon: typeof Bot }
>;

const kindIds = Object.keys(kinds) as (keyof typeof kinds)[];

export function pluginKindLabel(plugin: Plugin) {
  const id = kindIds.find((kind) => plugin.manifest.contributes[kind]?.length);
  return id ? kinds[id].label : "plugins.kind.other";
}

export function groupPlugins(
  plugins: Plugin[],
  search: string,
  t: TFunction,
  locale?: string,
) {
  const groups = kindIds.map((id) => ({
    id,
    ...kinds[id],
    entries: [] as Plugin[],
  }));
  const other = {
    id: "other",
    label: "plugins.kind.other",
    icon: Puzzle,
    entries: [] as Plugin[],
  };
  const term = search.trim().toLocaleLowerCase(locale);
  for (const plugin of plugins) {
    // A package has a single settings page, even if it contributes to several groups.
    const offered = groups.filter(
      ({ id }) => plugin.manifest.contributes[id]?.length,
    );
    const group = offered[0] ?? other;
    if (term) {
      const terms = [
        pluginName(plugin, t),
        plugin.manifest.name,
        plugin.manifest.id,
        plugin.id,
        pluginDescription(plugin, t),
        ...offered.map(({ label }) => t(label)),
      ];
      if (
        !terms.some((value) => value.toLocaleLowerCase(locale).includes(term))
      )
        continue;
    }
    group.entries.push(plugin);
  }
  return [...groups, other]
    .filter(({ entries }) => entries.length)
    .map((group) => ({
      ...group,
      entries: group.entries.sort((a, b) =>
        pluginName(a, t).localeCompare(pluginName(b, t), locale),
      ),
    }));
}

export type PluginGroup = ReturnType<typeof groupPlugins>[number];
