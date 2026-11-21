import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Automation } from "@/api/types.gen";

export const automationPath = "/tasks/automations";
export const automationsQuery = queryOptions({
  queryKey: ["automations"],
  queryFn: ({ signal }) =>
    api<Automation[]>(automationPath, undefined, "GET", signal),
});
