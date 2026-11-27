import type { TFunction } from "i18next";
import type {
  Agent,
  FeishuBotSettings,
  FeishuBotView,
  FeishuChatOverride,
  ProviderInfo,
  Selection,
} from "@/api/types.gen";
import { connectionName } from "@/features/runtime/connections";

export interface FeishuInitialConfig {
  dmAccess: "admin" | "whitelist" | "all";
  dmWhitelist: string[];
  dmMode: "continuous" | "topic";
  replyStyle: "card" | "text";
  groupEnabled: boolean;
  groupAccess: "whitelist" | "any";
  groupMention: "at_only" | "thread_free" | "yield" | "free";
  groupReplyTarget: "topic" | "main" | "quote";
}

export function defaultFeishuInitialConfig(): FeishuInitialConfig {
  return {
    dmAccess: "admin",
    dmWhitelist: [],
    dmMode: "continuous",
    replyStyle: "card",
    groupEnabled: false,
    groupAccess: "whitelist",
    groupMention: "thread_free",
    groupReplyTarget: "topic",
  };
}

export function buildInitialBotSettings(
  config: FeishuInitialConfig,
  displayName: string,
  agentId: string,
): FeishuBotSettings {
  return {
    displayName: displayName.trim(),
    agentId,
    dmMode: config.dmMode,
    replyStyle: config.replyStyle,
    reaction: "OnIt",
    reactionDone: "DONE",
    groupEnabled: config.groupEnabled,
    groupMention: config.groupMention,
    groupReplyTarget: config.groupReplyTarget,
    dmAccess: config.dmAccess,
    dmWhitelist: config.dmAccess === "whitelist" ? config.dmWhitelist : [],
    groupAccess: config.groupAccess,
    replyMention: "requester",
    admins: [],
    defaultPrompt: "",
    chatOverrides: [],
    advanced: {
      reactionAck: true,
      senderTag: true,
      hideLocalAddresses: true,
      historyLimit: 20,
      trustSameOwnerBots: false,
      sessionMapping: "single_chat_topics",
      approvalMode: "lever",
      blockedUsers: [],
    },
  };
}

export function feishuBotEffectiveReaction(settings: FeishuBotSettings) {
  const reaction =
    settings.reaction !== undefined
      ? settings.reaction.trim()
      : settings.advanced?.reactionAck
        ? "OnIt"
        : "";
  const reactionDone =
    settings.reactionDone !== undefined
      ? settings.reactionDone.trim()
      : settings.reaction === undefined && settings.advanced?.reactionAck
        ? "DONE"
        : "";
  return { reaction, reactionDone };
}

export function feishuBotWaitingFirstDmBind(bot: FeishuBotView): boolean {
  const dmAccess = bot.settings.dmAccess || "admin";
  if (dmAccess !== "admin") return false;
  return !bot.paired && (bot.settings.admins?.length ?? 0) === 0;
}

export function feishuBotDmAccessBlocked(bot: FeishuBotView): boolean {
  const dmAccess = bot.settings.dmAccess || "admin";
  if (dmAccess !== "whitelist") return false;
  if (bot.paired) return false;
  if ((bot.settings.admins?.length ?? 0) > 0) return false;
  return (bot.settings.dmWhitelist?.length ?? 0) === 0;
}

export function feishuBotGroupWhitelistEmpty(bot: FeishuBotView): boolean {
  if (!bot.settings.groupEnabled) return false;
  if ((bot.settings.groupAccess || "whitelist") !== "whitelist") return false;
  return !(bot.settings.chatOverrides ?? []).some((rule) => rule.enabled);
}

export function shortId(id: string | undefined) {
  if (!id || id.length <= 14) return id ?? "";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function botDisplayName(bot: FeishuBotView, fallback: string) {
  return (
    bot.settings.displayName?.trim() ||
    bot.botName?.trim() ||
    shortId(bot.appId) ||
    fallback
  );
}

export function baseSelectionForAgent(agent?: Agent): Selection {
  return {
    provider: agent?.profile.provider ?? "",
    model: agent?.profile.model ?? "",
    effort: agent?.profile.effort ?? "",
    fast: Boolean(agent?.profile.fast),
  };
}

export function primaryWorkspaceForAgent(agent?: Agent) {
  if (!agent) return "";
  return (
    agent.profile.roots.find((r) => r.id === agent.profile.primaryRootId)
      ?.path ??
    agent.profile.roots[0]?.path ??
    ""
  );
}

export function formatSelectionLabel(
  selection: Selection | undefined,
  agent: Agent | undefined,
  providers: ProviderInfo[] | undefined,
  t: TFunction,
) {
  const effective = selection ?? baseSelectionForAgent(agent);
  const runtime = providers?.find((p) => p.id === effective.provider);
  const providerName = runtime
    ? connectionName(runtime, providers ?? [], t)
    : effective.provider;
  const modelName = effective.model || t("profile.defaultModel");
  const parts = [providerName, modelName].filter(Boolean);
  if (effective.effort) parts.push(effective.effort);
  return parts.join(" · ") || t("profile.defaultModel");
}

export function countRuleOverrides(rule: FeishuChatOverride) {
  let count = 0;
  if (rule.prompt?.trim()) count++;
  if (rule.selection) count++;
  if (rule.groupMention) count++;
  if (rule.groupReplyTarget) count++;
  if (rule.replyStyle) count++;
  return count;
}

export function buildRuleDiffChips(
  rule: FeishuChatOverride,
  agent: Agent | undefined,
  providers: ProviderInfo[] | undefined,
  t: TFunction,
): string[] {
  const chips: string[] = [];
  if (rule.prompt?.trim()) {
    chips.push(
      t(
        rule.promptMode === "replace"
          ? "channels.bot.rulePromptReplace"
          : "channels.bot.rulePromptAppend",
      ),
    );
  }
  if (rule.selection) {
    chips.push(
      t("channels.bot.ruleModelChip", {
        model: formatSelectionLabel(rule.selection, agent, providers, t),
      }),
    );
  }
  if (rule.groupMention) {
    chips.push(
      t("channels.bot.ruleTriggerChip", {
        value: t(`channels.bot.groupMention.${rule.groupMention}`),
      }),
    );
  }
  if (rule.groupReplyTarget) {
    chips.push(
      t("channels.bot.ruleTargetChip", {
        value: t(`channels.bot.groupReplyTarget.${rule.groupReplyTarget}`),
      }),
    );
  }
  if (rule.replyStyle) {
    chips.push(
      t("channels.bot.ruleStyleChip", {
        value: t(`channels.bot.replyStyle.${rule.replyStyle}`),
      }),
    );
  }
  if (chips.length === 0) {
    chips.push(t("channels.bot.ruleAllInherit"));
  }
  return chips;
}
