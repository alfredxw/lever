import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { ChannelRegistration, ChannelView } from "@/api/types.gen";

export const feishuPath = "/channels/feishu";
export const feishuQueryKey = ["channel", "feishu"] as const;

export function registrationInProgress(registration?: ChannelRegistration) {
  return (
    !!registration &&
    ["starting", "waiting", "cancelling"].includes(registration.phase)
  );
}

export function feishuStatus(channel: ChannelView) {
  if (!channel.enabled) return;
  if (!channel.configured) return "notConfigured";
  if (channel.connection !== "online") return channel.connection;
  if (!channel.agentId) return "unpaired";
  if (channel.paused) return "paused";
  return "online";
}

export function useFeishuChannel(enabled: boolean, poll = false) {
  return useQuery({
    queryKey: feishuQueryKey,
    enabled,
    queryFn: ({ signal }) =>
      api<ChannelView>(feishuPath, undefined, "GET", signal),
    refetchInterval: (query) => {
      const channel = query.state.data;
      if (!poll || !channel?.enabled) return false;
      if (registrationInProgress(channel.registration)) return 1000;
      if (!channel.configured) return false;
      return channel.agentId ? 5000 : 1500;
    },
  });
}
