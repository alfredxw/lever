import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Plugin } from "@/api/types.gen";

export const pluginsQuery = queryOptions({
  queryKey: ["plugins"],
  queryFn: ({ signal }) => api<Plugin[]>("/plugins", undefined, "GET", signal),
});
