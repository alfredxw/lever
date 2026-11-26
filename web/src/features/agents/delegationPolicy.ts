import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "@/api/client";
import type { DelegationSettings, RemoteAgentTarget } from "@/api/types.gen";

export {
  allowsRemoteDelegation,
  canAcceptDelegations,
  defaultDelegationSettings,
  effectiveDelegationPolicy,
} from "./delegationPolicyModel";

export function useDelegationSettings(enabled = true) {
  return useQuery({
    queryKey: ["delegation-settings"],
    queryFn: () => api<DelegationSettings>("/settings/delegation"),
    enabled,
  });
}

export function useSaveDelegationSettings() {
  return useMutation({
    mutationFn: (settings: DelegationSettings) =>
      api<DelegationSettings>("/settings/delegation", settings, "PUT"),
    onSuccess: (saved) => {
      queryClient.setQueryData(["delegation-settings"], saved);
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

export function useRemoteDelegationTargets({
  chatId,
  agentId,
  enabled = true,
}: {
  chatId?: string;
  agentId?: string;
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: ["remote-delegation-targets", chatId ?? "", agentId ?? ""],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (chatId) params.set("chatId", chatId);
      if (agentId) params.set("agentId", agentId);
      const query = params.toString();
      return api<RemoteAgentTarget[]>(
        `/delegation/remote-targets${query ? `?${query}` : ""}`,
        undefined,
        "GET",
        signal,
      );
    },
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}
