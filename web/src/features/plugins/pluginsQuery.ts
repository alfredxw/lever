import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Plugin, UpdateSettings } from "@/api/types.gen";

export const pluginsQuery = queryOptions({
  queryKey: ["plugins"],
  queryFn: ({ signal }) => api<Plugin[]>("/plugins", undefined, "GET", signal),
});

export const pluginUpdateSettingsQuery = queryOptions({
  queryKey: ["plugin-update-settings"],
  queryFn: ({ signal }) =>
    api<UpdateSettings>("/plugin-update-settings", undefined, "GET", signal),
});
