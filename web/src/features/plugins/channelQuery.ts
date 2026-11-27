import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type {
  ChannelRegistration,
  ChannelView,
  FeishuBotView,
  FeishuKnownChat,
} from "@/api/types.gen";
import {
  feishuBotDmAccessBlocked,
  feishuBotGroupWhitelistEmpty,
} from "./feishuBotHelpers";

export const feishuPath = "/channels/feishu";
export const feishuQueryKey = ["channel", "feishu"] as const;

export function registrationInProgress(registration?: ChannelRegistration) {
  return (
    !!registration &&
    ["starting", "waiting", "cancelling"].includes(registration.phase)
  );
}

export function feishuBotStatus(
  bot: FeishuBotView,
  pluginEnabled: boolean,
):
  | "offline"
  | "connecting"
  | "error"
  | "credentials_missing"
  | "paused"
  | "unpaired"
  | "needs_access"
  | "online"
  | undefined {
  if (!pluginEnabled) return;
  if (!bot.enabled) return "paused";
  if (bot.connection !== "online") {
    return bot.connection as
      | "offline"
      | "connecting"
      | "error"
      | "credentials_missing";
  }
  if (!bot.settings.agentId && !bot.paired) return "unpaired";
  if (
    feishuBotDmAccessBlocked(bot) &&
    (!bot.settings.groupEnabled || feishuBotGroupWhitelistEmpty(bot))
  ) {
    return "needs_access";
  }
  return "online";
}

export function feishuStatus(channel: ChannelView) {
  if (!channel.enabled) return;
  const bots = channel.bots ?? [];
  if (bots.length === 0) {
    if (!channel.configured) return "notConfigured";
    if (channel.connection !== "online") return channel.connection;
    if (!channel.agentId) return "unpaired";
    if (channel.paused) return "paused";
    return "online";
  }
  const statuses = bots.map((b) => feishuBotStatus(b, channel.enabled));
  if (statuses.includes("online")) return "online";
  if (statuses.includes("connecting")) return "connecting";
  if (statuses.includes("credentials_missing")) return "credentials_missing";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("unpaired")) return "unpaired";
  if (statuses.includes("needs_access")) return "needs_access";
  if (statuses.includes("paused")) return "paused";
  return "offline";
}

export function feishuBotForChat(
  channel: ChannelView | undefined,
  chatId: string,
) {
  if (!channel) return undefined;
  const bots = channel.bots ?? [];
  if (bots.length > 0) {
    return bots.find((b) => b.chatId === chatId);
  }
  return channel.chatId === chatId ? channel : undefined;
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
      const bots = channel.bots ?? [];
      if (bots.length === 0 && !channel.configured) return false;
      const pairing =
        bots.some((b) => !!b.pairCode || !!b.pairCandidate) ||
        (!bots.length && !channel.agentId);
      return pairing ? 1500 : 5000;
    },
  });
}

export function useFeishuBotChats(botId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["channel", "feishu", "chats", botId],
    enabled: !!botId && enabled,
    queryFn: ({ signal }) =>
      api<FeishuKnownChat[]>(
        `${feishuPath}/bots/${botId}/chats`,
        undefined,
        "GET",
        signal,
      ),
    staleTime: 30_000,
  });
}
