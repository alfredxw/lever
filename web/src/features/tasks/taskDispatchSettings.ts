import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type { TaskChatMode, TaskDispatchSettings } from "@/api/types.gen";

export const taskChatModes: readonly TaskChatMode[] = [
  "single",
  "bySource",
  "newChat",
];

export const defaultTaskDispatchSettings: TaskDispatchSettings = {
  chatMode: "single",
};

export function taskDispatchSettingsQuery(enabled = true) {
  return {
    queryKey: ["task-dispatch-settings"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<TaskDispatchSettings>(
        "/settings/task-dispatch",
        undefined,
        "GET",
        signal,
      ),
    enabled,
    staleTime: 60_000,
  };
}

export function useTaskDispatchSettings(enabled = true) {
  return useQuery(taskDispatchSettingsQuery(enabled));
}

export function useSaveTaskDispatchSettings() {
  return useMutation({
    mutationFn: (settings: TaskDispatchSettings) =>
      api<TaskDispatchSettings>("/settings/task-dispatch", settings, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(["task-dispatch-settings"], saved);
    },
  });
}
