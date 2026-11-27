import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type { PermissionSettings } from "@/api/types.gen";

export type DefaultPermissionPreset = PermissionSettings["defaultMode"];

export const defaultPermissionSettings: PermissionSettings = {
  defaultMode: "auto",
};

export function usePermissionSettings(enabled = true) {
  return useQuery({
    queryKey: ["permission-settings"],
    queryFn: () => api<PermissionSettings>("/settings/permissions"),
    enabled,
  });
}

export function useSavePermissionSettings() {
  return useMutation({
    mutationFn: (settings: Pick<PermissionSettings, "defaultMode">) =>
      api<PermissionSettings>("/settings/permissions", settings, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(["permission-settings"], saved);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}
