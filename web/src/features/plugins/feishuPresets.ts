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

export type FeishuPresetKey = "personal" | "dev" | "oncall";

export const FEISHU_PRESET_KEYS: readonly FeishuPresetKey[] = [
  "personal",
  "dev",
  "oncall",
];

export const FEISHU_PRESET_PATCHES: Record<
  FeishuPresetKey,
  Partial<FeishuBotSettings>
> = {
  personal: {
    dmMode: "continuous",
    replyStyle: "card",
    groupEnabled: false,
    groupMention: "at_only",
    groupReplyTarget: "topic",
    dmAccess: "admin",
    groupAccess: "whitelist",
    replyMention: "none",
  },
  dev: {
    dmMode: "continuous",
    replyStyle: "card",
    groupEnabled: true,
    groupMention: "thread_free",
    groupReplyTarget: "topic",
    dmAccess: "all",
    groupAccess: "whitelist",
    replyMention: "requester",
  },
  oncall: {
    dmMode: "topic",
    replyStyle: "text",
    groupEnabled: true,
    groupMention: "yield",
    groupReplyTarget: "main",
    dmAccess: "whitelist",
    groupAccess: "whitelist",
    replyMention: "members",
  },
};

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
    effort: "",
    fast: false,
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
