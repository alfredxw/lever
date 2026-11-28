import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type { QuestionSettings } from "@/api/types.gen";

export const defaultQuestionSettings: QuestionSettings = {
  timeoutSeconds: 180,
};

export const questionTimeoutPresets = [0, 60, 180, 300, 600] as const;

export function useQuestionSettings(enabled = true) {
  return useQuery({
    queryKey: ["question-settings"],
    queryFn: () => api<QuestionSettings>("/settings/questions"),
    enabled,
  });
}

export function useSaveQuestionSettings() {
  return useMutation({
    mutationFn: (settings: QuestionSettings) =>
      api<QuestionSettings>("/settings/questions", settings, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(["question-settings"], saved);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}
