import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type {
  TaskDeadline,
  TaskDeadlineInput,
  TaskReminderSettings,
} from "@/api/types.gen";

export * from "./taskDeadlineLogic";

export function taskDeadlinesQuery(enabled = true) {
  return {
    queryKey: ["task-deadlines"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<TaskDeadline[]>("/tasks/deadlines", undefined, "GET", signal),
    enabled,
    refetchOnWindowFocus: true,
  };
}

export function taskReminderSettingsQuery(enabled = true) {
  return {
    queryKey: ["task-reminder-settings"] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<TaskReminderSettings>(
        "/settings/task-reminders",
        undefined,
        "GET",
        signal,
      ),
    enabled,
    staleTime: 60_000,
  };
}

export function useTaskDeadlines(enabled = true) {
  return useQuery(taskDeadlinesQuery(enabled));
}

export function useTaskReminderSettings(enabled = true) {
  return useQuery(taskReminderSettingsQuery(enabled));
}

export function useSaveTaskDeadline() {
  return useMutation({
    mutationFn: ({
      taskId,
      input,
    }: {
      taskId: string;
      input: TaskDeadlineInput;
    }) => api<TaskDeadline>(`/tasks/deadlines/${taskId}`, input, "PUT"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-deadlines"] });
    },
  });
}

export function useClearTaskDeadline() {
  return useMutation({
    mutationFn: (taskId: string) =>
      api(`/tasks/deadlines/${taskId}`, undefined, "DELETE"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-deadlines"] });
    },
  });
}

export function useSnoozeTaskDeadline() {
  return useMutation({
    mutationFn: ({ taskId, minutes }: { taskId: string; minutes: number }) =>
      api<TaskDeadline>(
        `/tasks/deadlines/${taskId}/snooze`,
        { minutes },
        "POST",
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["task-deadlines"] });
    },
  });
}

export function useSaveTaskReminderSettings() {
  return useMutation({
    mutationFn: (settings: TaskReminderSettings) =>
      api<TaskReminderSettings>("/settings/task-reminders", settings, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(["task-reminder-settings"], saved);
    },
  });
}
