import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Ellipsis,
  MessageSquare,
  Plus,
  Send,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  ChannelView,
  FeishuAccessRequestInput,
  FeishuBotAdvanced,
  FeishuBotSettings,
  FeishuBotView,
  FeishuChatOverride,
  Selection,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useModels, useProviders } from "@/features/runtime/queries";
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsControls";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  feishuBotStatus,
  feishuPath,
  feishuQueryKey,
  useFeishuChannel,
} from "./channelQuery";
import {
  FeishuContactPicker,
  FeishuUserAvatar,
} from "./FeishuContactPicker";
import {
  FeishuAddBotDialog,
  FeishuCredsDialog,
  FeishuGroupRuleDialog,
  FeishuScopesDialog,
} from "./FeishuDialogs";
import {
  baseSelectionForAgent,
  botDisplayName,
  buildRuleDiffChips,
  feishuBotDmAccessBlocked,
  feishuBotEffectiveReaction,
  feishuBotWaitingFirstDmBind,
  formatSelectionLabel,
  primaryWorkspaceForAgent,
  shortId,
} from "./feishuBotHelpers";
import { FeishuReactionSetting } from "./feishuReactions";

const HISTORY_LIMIT_OPTIONS = ["0", "10", "20", "50"] as const;

function statusTone(
  status: ReturnType<typeof feishuBotStatus>,
  hasMissingScopes: boolean,
): "positive" | "attention" | "error" | "muted" {
  if (status === "paused" || status === "offline" || !status) return "muted";
  if (status === "error" || status === "credentials_missing") return "error";
  if (
    hasMissingScopes ||
    status === "connecting" ||
    status === "unpaired" ||
    status === "needs_access"
  ) {
    return "attention";
  }
  return "positive";
}

function updateChannelCache(next: ChannelView) {
  queryClient.setQueryData(feishuQueryKey, next);
  void queryClient.invalidateQueries({ queryKey: ["overview"] });
}

export function FeishuChannel({
  agents,
  onOpenChat,
}: {
  agents: Agent[];
  onOpenChat: (chatId: string, agentId: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const query = useFeishuChannel(true, true);
  const providers = useProviders();
  const channel = query.data;
  const bots = channel?.bots ?? [];
  const availableAgents = agents.filter((a) => !a.archived);

  const [selectedBotId, setSelectedBotId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [credsOpen, setCredsOpen] = useState(false);
  const [scopesOpen, setScopesOpen] = useState(false);
  const [adminPickerOpen, setAdminPickerOpen] = useState(false);
  const [whitelistPickerOpen, setWhitelistPickerOpen] = useState(false);
  const adminRowRef = useRef<HTMLDivElement>(null);
  const whitelistRowRef = useRef<HTMLDivElement>(null);
  const [unbindOpen, setUnbindOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<{
    open: boolean;
    rule: FeishuChatOverride | null;
  }>({ open: false, rule: null });

  const prevBotCount = useRef(bots.length);
  useEffect(() => {
    if (bots.length > prevBotCount.current) {
      // Auto-select newly added bot (including QR completion)
      setSelectedBotId(bots[bots.length - 1].id);
      setAddOpen(false);
    } else if (
      bots.length > 0 &&
      !bots.some((b) => b.id === selectedBotId)
    ) {
      setSelectedBotId(bots[0].id);
    }
    prevBotCount.current = bots.length;
  }, [bots, selectedBotId]);

  const bot =
    bots.find((b) => b.id === selectedBotId) ?? bots[0] ?? undefined;

  const saveSettings = useMutation({
    mutationFn: ({
      botId,
      settings,
    }: {
      botId: string;
      settings: FeishuBotSettings;
    }) =>
      api<ChannelView>(
        `${feishuPath}/bots/${botId}/settings`,
        settings,
        "PUT",
      ),
    onSuccess: (next) => updateChannelCache(next),
    onError: (error) => toast.error(error.message),
  });

  const setEnabled = useMutation({
    mutationFn: ({ botId, enabled }: { botId: string; enabled: boolean }) =>
      api<ChannelView>(
        `${feishuPath}/bots/${botId}/enabled`,
        { enabled },
        "PUT",
      ),
    onSuccess: (next, vars) => {
      updateChannelCache(next);
      const updated = next.bots?.find((b) => b.id === vars.botId);
      const name = updated
        ? botDisplayName(updated, t("channels.feishu"))
        : t("channels.feishu");
      toast.success(
        t(
          vars.enabled
            ? "channels.bot.enabledToast"
            : "channels.bot.pausedToast",
          { name },
        ),
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const reconnect = useMutation({
    mutationFn: (botId: string) =>
      api<ChannelView>(`${feishuPath}/bots/${botId}/reconnect`, {}, "POST"),
    onSuccess: updateChannelCache,
    onError: (error) => toast.error(error.message),
  });

  const testBot = useMutation({
    mutationFn: (botId: string) =>
      api(`${feishuPath}/bots/${botId}/test`, {}, "POST"),
    onSuccess: () => toast.success(t("channels.testSent")),
    onError: (error) => toast.error(error.message),
  });

  const resolveAccessRequest = useMutation({
    mutationFn: ({
      botId,
      input,
    }: {
      botId: string;
      input: FeishuAccessRequestInput;
    }) =>
      api<ChannelView>(
        `${feishuPath}/bots/${botId}/access-requests`,
        input,
        "POST",
      ),
    onSuccess: (next, vars) => {
      updateChannelCache(next);
      if (vars.input.action === "grant_admin") {
        toast.success(t("channels.bot.requestGrantedAdminToast"));
      } else if (vars.input.action === "allow_dm") {
        toast.success(t("channels.bot.requestAllowedDmToast"));
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const unbindDm = useMutation({
    mutationFn: (botId: string) =>
      api<ChannelView>(`${feishuPath}/bots/${botId}/binding`, {}, "DELETE"),
    onSuccess: (next) => {
      updateChannelCache(next);
      toast.success(t("channels.bot.unpairedDmToast"));
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteBot = useMutation({
    mutationFn: (botId: string) =>
      api<ChannelView>(`${feishuPath}/bots/${botId}`, {}, "DELETE"),
    onSuccess: (next) => {
      const removedName = bot
        ? botDisplayName(bot, t("channels.feishu"))
        : t("channels.feishu");
      updateChannelCache(next);
      setUnbindOpen(false);
      toast.success(t("channels.bot.unboundToast", { name: removedName }));
    },
    onError: (error) => toast.error(error.message),
  });

  // Local prompt draft for smooth typing with debounced + onBlur save
  const [promptDraft, setPromptDraft] = useState(
    bot?.settings.defaultPrompt ?? "",
  );
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptBotId = useRef(bot?.id);

  useEffect(() => {
    if (bot?.id !== promptBotId.current) {
      promptBotId.current = bot?.id;
      setPromptDraft(bot?.settings.defaultPrompt ?? "");
      if (promptTimer.current) {
        clearTimeout(promptTimer.current);
        promptTimer.current = null;
      }
    }
  }, [bot?.id, bot?.settings.defaultPrompt]);

  useEffect(() => {
    return () => {
      if (promptTimer.current) clearTimeout(promptTimer.current);
    };
  }, []);

  if (!channel) {
    return query.error ? (
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
    ) : (
      <Loading />
    );
  }

  const pluginDisabled = !channel.enabled;

  const patchSettings = (patch: Partial<FeishuBotSettings>) => {
    if (!bot || pluginDisabled) return;
    const next: FeishuBotSettings = {
      ...bot.settings,
      ...patch,
      advanced: {
        ...bot.settings.advanced,
        ...(patch.advanced ?? {}),
      },
    };
    saveSettings.mutate({ botId: bot.id, settings: next });
  };

  const patchAdvanced = (patch: Partial<FeishuBotAdvanced>) => {
    if (!bot || pluginDisabled) return;
    patchSettings({
      advanced: { ...bot.settings.advanced, ...patch },
    });
  };

  const flushPrompt = (value: string) => {
    if (promptTimer.current) {
      clearTimeout(promptTimer.current);
      promptTimer.current = null;
    }
    if (!bot || pluginDisabled) return;
    const trimmed = value.trim();
    if (trimmed === (bot.settings.defaultPrompt ?? "").trim()) return;
    patchSettings({ defaultPrompt: trimmed });
  };

  const schedulePromptSave = (value: string) => {
    setPromptDraft(value);
    if (promptTimer.current) clearTimeout(promptTimer.current);
    promptTimer.current = setTimeout(() => flushPrompt(value), 650);
  };

  const agent = agents.find((a) => a.id === bot?.settings.agentId);
  const botStatus = bot ? feishuBotStatus(bot, channel.enabled) : undefined;
  const missingScopes = bot?.missingScopes ?? [];
  const activeGroupRulesCount = (bot?.settings.chatOverrides ?? []).filter(
    (r) => r.enabled,
  ).length;
  const waitingFirstDmBind = bot ? feishuBotWaitingFirstDmBind(bot) : false;
  const dmAccessBlocked = bot ? feishuBotDmAccessBlocked(bot) : false;
  const pendingRequests = bot?.pendingRequests ?? [];
  const effectiveReaction = bot
    ? feishuBotEffectiveReaction(bot.settings)
    : { reaction: "", reactionDone: "" };
  const tone = statusTone(botStatus, missingScopes.length > 0);
  const busy =
    pluginDisabled ||
    setEnabled.isPending ||
    reconnect.isPending ||
    resolveAccessRequest.isPending ||
    unbindDm.isPending ||
    deleteBot.isPending;

  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label={t("channels.settings")}
    >
      {query.error && (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      )}

      {/* Multi-Bot Switcher Bar + Bind Bot Button */}
      {bots.length > 0 && (
        <div className="feishu-switcher-row">
          <div
            className="feishu-bot-strip"
            role="tablist"
            aria-label={t("channels.feishu")}
          >
            {bots.map((item) => {
              const itemAgent = agents.find(
                (a) => a.id === item.settings.agentId,
              );
              const itemStatus = feishuBotStatus(item, channel.enabled);
              const itemTone = statusTone(
                itemStatus,
                (item.missingScopes?.length ?? 0) > 0,
              );
              const selected = item.id === bot?.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-active={selected}
                  className="feishu-bot-tab"
                  onClick={() => setSelectedBotId(item.id)}
                >
                  <div className="feishu-bot-tab-top">
                    <span
                      className="feishu-status-dot"
                      data-tone={itemTone}
                      aria-hidden="true"
                    />
                    <span className="truncate font-medium">
                      {botDisplayName(item, t("channels.feishu"))}
                    </span>
                  </div>
                  <div className="feishu-bot-tab-sub">
                    {itemAgent ? (
                      <>
                        <AgentAvatar agent={itemAgent} size="xs" />
                        <span className="truncate">{itemAgent.name}</span>
                      </>
                    ) : (
                      <span className="truncate">
                        {t("channels.bot.agentUnbound")}
                      </span>
                    )}
                    <span className="ml-auto shrink-0">
                      {item.brand === "lark"
                        ? "Lark"
                        : t("channels.platformFeishu")}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <Button
            type="button"
            size="sm"
            disabled={pluginDisabled}
            onClick={() => setAddOpen(true)}
            className="shrink-0"
          >
            <Plus data-icon="inline-start" />
            {t("channels.bot.bind")}
          </Button>
        </div>
      )}

      {/* Empty State when no bots configured yet */}
      {!bot ? (
        <div className="panel-surface rounded-xl border border-[var(--surface-border)] py-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Send />
              </EmptyMedia>
              <EmptyTitle>{t("channels.bot.emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("channels.bot.emptyDesc")}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                disabled={pluginDisabled}
                onClick={() => setAddOpen(true)}
              >
                <Plus data-icon="inline-start" />
                {t("channels.bot.bindFirst")}
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      ) : (
        <>
          {/* Selected Bot Summary Bar */}
          <div className="feishu-bot-summary panel-surface">
            <div className="flex min-w-0 items-center gap-3">
              <div className="feishu-bot-monogram" aria-hidden="true">
                {botDisplayName(bot, "F").slice(0, 1).toUpperCase()}
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {botDisplayName(bot, t("channels.feishu"))}
                  </span>
                  {botStatus && (
                    <span className="feishu-status-pill" data-tone={tone}>
                      <span
                        className="feishu-status-dot"
                        data-tone={tone}
                        aria-hidden="true"
                      />
                      {missingScopes.length > 0 && botStatus === "online"
                        ? t("channels.bot.missingScopesBadge")
                        : t(`channels.status.${botStatus}`)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>
                    {bot.brand === "lark"
                      ? "Lark"
                      : t("channels.platformFeishu")}
                  </span>
                  <span>·</span>
                  <span className="font-mono">{shortId(bot.appId)}</span>
                  <span>·</span>
                  <span>
                    {t(
                      `channels.bot.dmAccess.${bot.settings.dmAccess || "admin"}`,
                    )}
                  </span>
                  <span>·</span>
                  <span>
                    {bot.settings.groupEnabled
                      ? bot.settings.groupAccess === "any"
                        ? t("channels.bot.groupAccess.any")
                        : t("channels.bot.groupRulesCount", {
                            count: activeGroupRulesCount,
                          })
                      : t("channels.bot.dmOnly")}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {bot.chatId && bot.settings.agentId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onOpenChat(
                      bot.chatId!,
                      bot.settings.agentId!,
                      `${bot.brand === "lark" ? "Lark" : "Feishu"} · ${botDisplayName(bot, t("channels.feishu"))}`,
                    )
                  }
                >
                  {t("channels.openChat")}
                  <ArrowUpRight data-icon="inline-end" />
                </Button>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || testBot.isPending}
                onClick={() => {
                  if (!bot.enabled) {
                    toast.info(t("channels.bot.testPaused"));
                    return;
                  }
                  testBot.mutate(bot.id);
                }}
              >
                {t("channels.bot.testBtn")}
              </Button>

              <Switch
                aria-label={t("channels.bot.enableAria")}
                checked={bot.enabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setEnabled.mutate({ botId: bot.id, enabled: checked })
                }
              />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("channels.actions")}
                    disabled={pluginDisabled}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setCredsOpen(true)}>
                    {t("channels.bot.editCreds")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setScopesOpen(true)}>
                    {t("channels.bot.viewScopes")}
                  </DropdownMenuItem>
                  {bot.paired && (
                    <DropdownMenuItem
                      onSelect={() => unbindDm.mutate(bot.id)}
                    >
                      {t("channels.bot.unpairDm")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => reconnect.mutate(bot.id)}>
                    {t("channels.reconnect")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setUnbindOpen(true)}
                  >
                    {t("channels.bot.unbindBot")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Direct DM Auto-Bind Guidance (unclaimed admin-only bot; first DM binds automatically) */}
          {bot.enabled && waitingFirstDmBind && (
            <div className="feishu-info-strip" role="status">
              <div className="flex min-w-0 items-center gap-2">
                <MessageSquare
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="text-xs leading-relaxed text-foreground">
                  {t("channels.bot.directBindHint")}
                </span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    adminRowRef.current?.scrollIntoView({
                      behavior: reducedMotion ? "auto" : "smooth",
                      block: "center",
                    });
                    setAdminPickerOpen(true);
                  }}
                >
                  {t("channels.bot.authorizeAdminAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => patchSettings({ dmAccess: "all" })}
                >
                  {t("channels.bot.allowAllDmAction")}
                </Button>
              </div>
            </div>
          )}

          {/* Actionable DM Whitelist Empty Warning */}
          {bot.enabled && dmAccessBlocked && (
            <div className="feishu-scope-alert" role="status">
              <div className="flex min-w-0 items-center gap-2">
                <AlertTriangle
                  className="size-4 shrink-0 text-[var(--status-attention)]"
                  aria-hidden="true"
                />
                <span className="text-xs leading-relaxed">
                  {t("channels.bot.dmWhitelistEmptyWarning")}
                </span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    whitelistRowRef.current?.scrollIntoView({
                      behavior: reducedMotion ? "auto" : "smooth",
                      block: "center",
                    });
                    setWhitelistPickerOpen(true);
                  }}
                >
                  {t("channels.bot.authorizeContactAction")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => patchSettings({ dmAccess: "all" })}
                >
                  {t("channels.bot.allowAllDmAction")}
                </Button>
              </div>
            </div>
          )}

          {/* Inline Scope Warning Strip (only shown when missing scopes detected) */}
          {bot.enabled && missingScopes.length > 0 && (
            <div className="feishu-scope-alert" role="status">
              <div className="flex min-w-0 items-center gap-2">
                <AlertTriangle
                  className="size-4 shrink-0 text-[var(--status-attention)]"
                  aria-hidden="true"
                />
                <span className="text-xs leading-relaxed">
                  {t("channels.bot.scopeWarning", {
                    scopes: missingScopes.join(", "),
                  })}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setScopesOpen(true)}
              >
                {t("channels.bot.checkScopes")}
              </Button>
            </div>
          )}

          {/* Card 1: Binding, Model & Default Identity Prompt */}
          <SettingsGroup title={t("channels.bot.sectionBinding")}>
            <SettingsRow
              title={t("channels.bot.agentLabel")}
              description={
                agent
                  ? t("channels.bot.agentDesc", {
                      workspace: primaryWorkspaceForAgent(agent) || "~",
                      model: formatSelectionLabel(
                        undefined,
                        agent,
                        providers.data,
                        t,
                      ),
                    })
                  : t("channels.bot.agentUnbound")
              }
            >
              <SearchableSelect
                label={t("channels.chooseAgent")}
                placeholder={t("channels.chooseAgent")}
                searchLabel={t("skills.agentFilter")}
                emptyLabel={t("personal.noAgents")}
                className="w-56 max-w-full"
                value={bot.settings.agentId ?? ""}
                currentLabel={
                  agent?.archived
                    ? `${agent.name} (${t("channels.unavailableAgent")})`
                    : undefined
                }
                disabled={busy}
                options={availableAgents.map((item) => ({
                  id: item.id,
                  label: item.name,
                  icon: <AgentAvatar agent={item} size="xs" />,
                  description:
                    item.profile.model || t("profile.defaultModel"),
                }))}
                onChange={(agentId) => patchSettings({ agentId })}
              />
            </SettingsRow>

            <BotModelRow
              agent={agent}
              selection={bot.settings.selection}
              disabled={busy || !agent}
              onChange={(selection) => patchSettings({ selection })}
            />

            <div className="feishu-prompt-row">
              <div className="flex flex-col gap-0.5">
                <label
                  htmlFor={`feishu-default-prompt-${bot.id}`}
                  className="text-sm font-medium"
                >
                  {t("channels.bot.defaultPrompt")}
                </label>
                <span className="text-xs text-muted-foreground">
                  {t("channels.bot.defaultPromptDesc", {
                    agent: agent?.name || t("channels.chooseAgent"),
                  })}
                </span>
              </div>
              <Textarea
                id={`feishu-default-prompt-${bot.id}`}
                rows={2}
                maxLength={4000}
                disabled={busy}
                placeholder={t("channels.bot.defaultPromptPlaceholder")}
                value={promptDraft}
                onChange={(e) => schedulePromptSave(e.target.value)}
                onBlur={(e) => flushPrompt(e.target.value)}
              />
            </div>
          </SettingsGroup>

          {/* Card 2: DM Access, Pending Requests, Reply Style, Configurable Reactions & Admins */}
          <SettingsGroup title={t("channels.bot.sectionDmAndReply")}>
            {pendingRequests.length > 0 && (
              <div className="feishu-pending-requests">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-semibold text-foreground">
                    {t("channels.bot.pendingRequestsTitle", {
                      count: pendingRequests.length,
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("channels.bot.pendingRequestsDesc")}
                  </span>
                </div>
                <div className="feishu-pending-requests-list">
                  {pendingRequests.map((req) => (
                    <div key={req.openId} className="feishu-pending-request-row">
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <FeishuUserAvatar
                          name={req.name}
                          avatarUrl={req.avatarUrl}
                          openId={req.openId}
                          size="sm"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-foreground">
                              {req.name || shortId(req.openId)}
                            </span>
                            {req.name && (
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                {shortId(req.openId)}
                              </span>
                            )}
                          </div>
                          {req.preview && (
                            <span className="truncate text-xs text-muted-foreground">
                              “{req.preview}”
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            resolveAccessRequest.mutate({
                              botId: bot.id,
                              input: {
                                openId: req.openId,
                                action: "allow_dm",
                                name: req.name,
                                avatarUrl: req.avatarUrl,
                              },
                            })
                          }
                        >
                          {t("channels.bot.requestAllowDm")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={busy}
                          onClick={() =>
                            resolveAccessRequest.mutate({
                              botId: bot.id,
                              input: {
                                openId: req.openId,
                                action: "grant_admin",
                                name: req.name,
                                avatarUrl: req.avatarUrl,
                              },
                            })
                          }
                        >
                          {t("channels.bot.requestGrantAdmin")}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          disabled={busy}
                          aria-label={t("channels.bot.requestDismiss")}
                          onClick={() =>
                            resolveAccessRequest.mutate({
                              botId: bot.id,
                              input: {
                                openId: req.openId,
                                action: "dismiss",
                              },
                            })
                          }
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <SettingsChoiceRow
              title={t("channels.bot.dmAccess")}
              description={t(
                `channels.bot.dmAccess.${bot.settings.dmAccess || "admin"}Desc`,
              )}
              value={bot.settings.dmAccess || "admin"}
              disabled={busy}
              options={(["admin", "whitelist", "all"] as const).map((k) => ({
                value: k,
                label: t(`channels.bot.dmAccess.${k}`),
              }))}
              onChange={(dmAccess) => patchSettings({ dmAccess })}
            />

            {bot.settings.dmAccess === "whitelist" && (
              <SettingsRow
                title={t("channels.bot.whitelistLabel")}
                description={t("channels.bot.whitelistDesc")}
              >
                <div ref={whitelistRowRef}>
                  <FeishuContactPicker
                    botId={bot.id}
                    appId={bot.appId}
                    brand={bot.brand}
                    items={bot.settings.dmWhitelist ?? []}
                    knownUsers={bot.knownUsers}
                    triggerLabel={t("channels.bot.searchAuthorizeContact")}
                    searchPlaceholder={t(
                      "channels.bot.contactSearchPlaceholder",
                    )}
                    disabled={busy}
                    open={whitelistPickerOpen}
                    onOpenChange={setWhitelistPickerOpen}
                    onChange={(dmWhitelist) => patchSettings({ dmWhitelist })}
                  />
                </div>
              </SettingsRow>
            )}

            <SettingsChoiceRow
              title={t("channels.bot.dmMode")}
              description={t(
                `channels.bot.dmMode.${bot.settings.dmMode || "continuous"}Desc`,
              )}
              value={bot.settings.dmMode || "continuous"}
              disabled={busy}
              options={[
                {
                  value: "continuous",
                  label: t("channels.bot.dmMode.continuous"),
                },
                { value: "topic", label: t("channels.bot.dmMode.topic") },
              ]}
              onChange={(dmMode) => patchSettings({ dmMode })}
            />

            <SettingsChoiceRow
              title={t("channels.bot.replyStyle")}
              description={t(
                `channels.bot.replyStyle.${bot.settings.replyStyle || "card"}Desc`,
              )}
              value={bot.settings.replyStyle || "card"}
              disabled={busy}
              options={[
                { value: "card", label: t("channels.bot.replyStyle.card") },
                { value: "text", label: t("channels.bot.replyStyle.text") },
              ]}
              onChange={(replyStyle) => patchSettings({ replyStyle })}
            />

            <FeishuReactionSetting
              key={`${bot.id}-reaction`}
              title={t("channels.bot.reactionAck")}
              description={t("channels.bot.reactionAckSelectDesc")}
              emptyLabel={t("personal.receipt.off")}
              value={effectiveReaction.reaction}
              disabled={busy}
              onChange={(nextReaction) => {
                if (!nextReaction) {
                  patchSettings({
                    reaction: "",
                    reactionDone: "",
                    advanced: {
                      ...bot.settings.advanced,
                      reactionAck: false,
                    },
                  });
                  return;
                }
                const nextDone = effectiveReaction.reaction
                  ? effectiveReaction.reactionDone
                  : nextReaction === "OnIt"
                    ? "DONE"
                    : "";
                patchSettings({
                  reaction: nextReaction,
                  reactionDone: nextDone,
                  advanced: {
                    ...bot.settings.advanced,
                    reactionAck: true,
                  },
                });
              }}
            />

            {effectiveReaction.reaction && (
              <FeishuReactionSetting
                key={`${bot.id}-reaction-done`}
                title={t("channels.bot.reactionDone")}
                description={t("channels.bot.reactionDoneDesc")}
                emptyLabel={t("channels.bot.reactionDoneKeep")}
                value={effectiveReaction.reactionDone}
                disabled={busy}
                onChange={(nextDone) =>
                  patchSettings({
                    reaction: effectiveReaction.reaction,
                    reactionDone: nextDone,
                    advanced: {
                      ...bot.settings.advanced,
                      reactionAck: true,
                    },
                  })
                }
              />
            )}

            <SettingsRow
              title={t("channels.bot.admins")}
              description={t("channels.bot.adminsDesc")}
            >
              <div ref={adminRowRef}>
                <FeishuContactPicker
                  botId={bot.id}
                  appId={bot.appId}
                  brand={bot.brand}
                  items={bot.settings.admins ?? []}
                  knownUsers={bot.knownUsers}
                  staticChips={
                    bot.paired && (bot.settings.admins?.length ?? 0) === 0
                      ? [
                          t("channels.bot.pairedOwnerChip", {
                            name: bot.ownerName || "DM",
                          }),
                        ]
                      : undefined
                  }
                  triggerLabel={t("channels.bot.searchAuthorizeAdmin")}
                  searchPlaceholder={t("channels.bot.contactSearchPlaceholder")}
                  disabled={busy}
                  open={adminPickerOpen}
                  onOpenChange={setAdminPickerOpen}
                  onChange={(admins) => patchSettings({ admins })}
                />
              </div>
            </SettingsRow>
          </SettingsGroup>

          {/* Card 3: Unified Group Access, Behavior & Per-Group Rules */}
          <SettingsGroup title={t("channels.bot.sectionGroup")}>
            <SettingsRow
              title={t("channels.bot.groupEnabled")}
              description={t(
                bot.settings.groupEnabled
                  ? "channels.bot.groupEnabledOn"
                  : "channels.bot.groupEnabledOff",
              )}
            >
              <Switch
                checked={bot.settings.groupEnabled}
                disabled={busy}
                aria-label={t("channels.bot.groupEnabled")}
                onCheckedChange={(groupEnabled) =>
                  patchSettings({ groupEnabled })
                }
              />
            </SettingsRow>

            <AnimatePresence initial={false}>
              {bot.settings.groupEnabled && (
                <motion.div
                  key="feishu-group-panel"
                  initial={reducedMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reducedMotion ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.16 }}
                  className="feishu-group-section overflow-hidden"
                >
                  <SettingsChoiceRow
                    title={t("channels.bot.groupAccess")}
                    description={t(
                      `channels.bot.groupAccess.${bot.settings.groupAccess || "whitelist"}Desc`,
                    )}
                    value={bot.settings.groupAccess || "whitelist"}
                    disabled={busy}
                    options={(["whitelist", "any"] as const).map((k) => ({
                      value: k,
                      label: t(`channels.bot.groupAccess.${k}`),
                    }))}
                    onChange={(groupAccess) => patchSettings({ groupAccess })}
                  />

                  <SettingsChoiceRow
                    title={t("channels.bot.groupMention")}
                    description={t(
                      `channels.bot.groupMention.${bot.settings.groupMention || "thread_free"}Desc`,
                    )}
                    value={bot.settings.groupMention || "thread_free"}
                    disabled={busy}
                    options={(
                      ["at_only", "thread_free", "yield", "free"] as const
                    ).map((k) => ({
                      value: k,
                      label: t(`channels.bot.groupMention.${k}`),
                    }))}
                    onChange={(groupMention) => patchSettings({ groupMention })}
                  />

                  <SettingsChoiceRow
                    title={t("channels.bot.groupReplyTarget")}
                    description={t(
                      `channels.bot.groupReplyTarget.${bot.settings.groupReplyTarget || "topic"}Desc`,
                    )}
                    value={bot.settings.groupReplyTarget || "topic"}
                    disabled={busy}
                    options={(["topic", "main", "quote"] as const).map((k) => ({
                      value: k,
                      label: t(`channels.bot.groupReplyTarget.${k}`),
                    }))}
                    onChange={(groupReplyTarget) =>
                      patchSettings({ groupReplyTarget })
                    }
                  />

                  <SettingsChoiceRow
                    title={t("channels.bot.replyMention")}
                    description={t(
                      `channels.bot.replyMention.${bot.settings.replyMention || "requester"}Desc`,
                    )}
                    value={bot.settings.replyMention || "requester"}
                    disabled={busy}
                    options={(["none", "requester", "members"] as const).map(
                      (k) => ({
                        value: k,
                        label: t(`channels.bot.replyMention.${k}`),
                      }),
                    )}
                    onChange={(replyMention) => patchSettings({ replyMention })}
                  />

                  {/* Per-Group Rules Sub-Section */}
                  <div className="feishu-group-rules-block">
                    <div className="feishu-group-rules-header">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          {t("channels.bot.groupRulesTitle")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t("channels.bot.groupRulesDesc")}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={busy}
                        onClick={() =>
                          setEditingRule({ open: true, rule: null })
                        }
                      >
                        <Plus data-icon="inline-start" />
                        {t("channels.bot.addGroupRule")}
                      </Button>
                    </div>

                    {(bot.settings.chatOverrides ?? []).length === 0 ? (
                      <div className="feishu-group-rules-list flex flex-col items-center gap-2.5 px-4 py-5 text-center text-xs text-muted-foreground">
                        <span>
                          {t(
                            bot.settings.groupAccess === "whitelist"
                              ? "channels.bot.groupEmptyWhitelist"
                              : "channels.bot.groupEmptyAny",
                          )}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setEditingRule({ open: true, rule: null })
                          }
                        >
                          <Plus data-icon="inline-start" />
                          {t("channels.bot.addFirstGroupRule")}
                        </Button>
                      </div>
                    ) : (
                      <div className="feishu-group-rules-list">
                        {(bot.settings.chatOverrides ?? []).map((rule) => {
                          const chips = buildRuleDiffChips(
                            rule,
                            agent,
                            providers.data,
                            t,
                          );
                          return (
                            <div
                              key={rule.id}
                              className="feishu-group-rule-row"
                              data-disabled={!rule.enabled || undefined}
                            >
                              <button
                                type="button"
                                className="feishu-group-rule-main"
                                disabled={busy}
                                onClick={() =>
                                  setEditingRule({ open: true, rule })
                                }
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium">
                                    {rule.chatName || shortId(rule.chatId)}
                                  </span>
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {shortId(rule.chatId)}
                                  </span>
                                </div>
                                {rule.prompt?.trim() && (
                                  <span className="feishu-group-rule-prompt">
                                    “{rule.prompt}”
                                  </span>
                                )}
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {chips.map((chip) => (
                                    <span
                                      key={chip}
                                      className="feishu-override-chip"
                                    >
                                      {chip}
                                    </span>
                                  ))}
                                </div>
                              </button>

                              <div className="flex shrink-0 items-center gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    setEditingRule({ open: true, rule })
                                  }
                                >
                                  {t("channels.bot.edit")}
                                </Button>
                                <Switch
                                  checked={rule.enabled}
                                  disabled={busy}
                                  aria-label={rule.chatName || rule.chatId}
                                  onCheckedChange={(enabled) => {
                                    const nextRules = (
                                      bot.settings.chatOverrides ?? []
                                    ).map((item) =>
                                      item.id === rule.id
                                        ? { ...item, enabled }
                                        : item,
                                    );
                                    patchSettings({ chatOverrides: nextRules });
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </SettingsGroup>

          {/* Card 4: Advanced & Safety (Collapsed by default) */}
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="panel-surface overflow-hidden rounded-xl border border-[var(--surface-border)]"
          >
            <CollapsibleTrigger asChild>
              <button type="button" className="feishu-advanced-trigger">
                <div className="flex min-w-0 flex-col gap-0.5 text-left">
                  <span className="text-sm font-semibold">
                    {t("channels.bot.advancedTitle")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("channels.bot.advancedSub")}
                  </span>
                </div>
                <ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </CollapsibleTrigger>

            <CollapsibleContent className="border-t border-[var(--surface-border)]">
              <div className="settings-group">
                <SettingsRow
                  title={t("channels.bot.senderTag")}
                  description={t("channels.bot.senderTagDesc")}
                >
                  <Switch
                    checked={bot.settings.advanced.senderTag}
                    disabled={busy}
                    aria-label={t("channels.bot.senderTag")}
                    onCheckedChange={(senderTag) =>
                      patchAdvanced({ senderTag })
                    }
                  />
                </SettingsRow>

                <SettingsRow
                  title={t("channels.bot.hideLocalAddresses")}
                  description={t("channels.bot.hideLocalAddressesDesc")}
                >
                  <Switch
                    checked={bot.settings.advanced.hideLocalAddresses}
                    disabled={busy}
                    aria-label={t("channels.bot.hideLocalAddresses")}
                    onCheckedChange={(hideLocalAddresses) =>
                      patchAdvanced({ hideLocalAddresses })
                    }
                  />
                </SettingsRow>

                <SettingsChoiceRow
                  title={t("channels.bot.historyLimit")}
                  description={t("channels.bot.historyLimitDesc")}
                  value={String(bot.settings.advanced.historyLimit ?? 0)}
                  disabled={busy}
                  options={HISTORY_LIMIT_OPTIONS.map((v) => ({
                    value: v,
                    label:
                      v === "0"
                        ? t("channels.bot.historyLimitOff")
                        : t("channels.bot.historyLimitCount", {
                            count: Number(v),
                          }),
                  }))}
                  onChange={(v) => patchAdvanced({ historyLimit: Number(v) })}
                />

                <SettingsRow
                  title={t("channels.bot.trustSameOwnerBots")}
                  description={t("channels.bot.trustSameOwnerBotsDesc")}
                >
                  <Switch
                    checked={bot.settings.advanced.trustSameOwnerBots}
                    disabled={busy}
                    aria-label={t("channels.bot.trustSameOwnerBots")}
                    onCheckedChange={(trustSameOwnerBots) =>
                      patchAdvanced({ trustSameOwnerBots })
                    }
                  />
                </SettingsRow>

                <SettingsChoiceRow
                  title={t("channels.bot.sessionMapping")}
                  description={t("channels.bot.sessionMappingDesc")}
                  value={
                    bot.settings.advanced.sessionMapping || "single_chat_topics"
                  }
                  disabled={busy}
                  options={[
                    {
                      value: "single_chat_topics",
                      label: t(
                        "channels.bot.sessionMapping.single_chat_topics",
                      ),
                    },
                    {
                      value: "per_feishu_chat",
                      label: t("channels.bot.sessionMapping.per_feishu_chat"),
                    },
                  ]}
                  onChange={(sessionMapping) =>
                    patchAdvanced({ sessionMapping })
                  }
                />

                <SettingsChoiceRow
                  title={t("channels.bot.approvalMode")}
                  description={t("channels.bot.approvalModeDesc")}
                  value={bot.settings.advanced.approvalMode || "lever"}
                  disabled={busy}
                  options={[
                    {
                      value: "lever",
                      label: t("channels.bot.approvalMode.lever"),
                    },
                    {
                      value: "feishu_card",
                      label: t("channels.bot.approvalMode.feishu_card"),
                    },
                  ]}
                  onChange={(approvalMode) => patchAdvanced({ approvalMode })}
                />

                <SettingsRow
                  title={t("channels.bot.blockedUsers")}
                  description={t("channels.bot.blockedUsersDesc")}
                >
                  <FeishuContactPicker
                    botId={bot.id}
                    appId={bot.appId}
                    brand={bot.brand}
                    items={bot.settings.advanced.blockedUsers ?? []}
                    knownUsers={bot.knownUsers}
                    triggerLabel={t("channels.bot.searchBlockContact")}
                    searchPlaceholder={t("channels.bot.contactSearchPlaceholder")}
                    disabled={busy}
                    onChange={(blockedUsers) =>
                      patchAdvanced({ blockedUsers })
                    }
                  />
                </SettingsRow>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Dialogs scoped to the selected bot */}
          <FeishuGroupRuleDialog
            open={editingRule.open}
            onOpenChange={(open) =>
              setEditingRule((cur) => ({ ...cur, open }))
            }
            bot={bot}
            agent={agent}
            rule={editingRule.rule}
            onSave={(savedRule) => {
              const current = bot.settings.chatOverrides ?? [];
              const exists = current.some((r) => r.id === savedRule.id);
              const nextRules = exists
                ? current.map((r) => (r.id === savedRule.id ? savedRule : r))
                : [...current, savedRule];
              patchSettings({ chatOverrides: nextRules });
              toast.success(
                t("channels.bot.ruleSavedToast", {
                  name: savedRule.chatName || shortId(savedRule.chatId),
                }),
              );
            }}
            onDelete={(ruleId) => {
              const nextRules = (bot.settings.chatOverrides ?? []).filter(
                (r) => r.id !== ruleId,
              );
              patchSettings({ chatOverrides: nextRules });
              toast.success(t("channels.bot.ruleDeletedToast"));
            }}
          />

          <FeishuCredsDialog
            open={credsOpen}
            onOpenChange={setCredsOpen}
            bot={bot}
          />

          <FeishuScopesDialog
            open={scopesOpen}
            onOpenChange={setScopesOpen}
            bot={bot}
          />

          <Dialog open={unbindOpen} onOpenChange={setUnbindOpen}>
            <DialogContent className="sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle>
                  {t("channels.bot.unbindBotTitle", {
                    name: botDisplayName(bot, t("channels.feishu")),
                  })}
                </DialogTitle>
                <DialogDescription>
                  {t("channels.bot.unbindBotDesc")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={deleteBot.isPending}
                  onClick={() => setUnbindOpen(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleteBot.isPending}
                  onClick={() => deleteBot.mutate(bot.id)}
                >
                  {t("channels.bot.unbindBotConfirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Global Add Bot Dialog */}
      <FeishuAddBotDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agents={agents}
        registration={channel.registration}
        onBotCreated={(next) => {
          const added = next.bots?.[next.bots.length - 1];
          if (added) setSelectedBotId(added.id);
        }}
      />
    </section>
  );
}

// =========================================================================
// Bot Model Row (Inherit Agent vs Override with Lever's ModelPicker)
// =========================================================================
function BotModelRow({
  agent,
  selection,
  disabled,
  onChange,
}: {
  agent?: Agent;
  selection?: Selection;
  disabled: boolean;
  onChange: (selection?: Selection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const providers = useProviders();
  const base = baseSelectionForAgent(agent);
  const effective = selection ?? base;
  const cwd = primaryWorkspaceForAgent(agent);
  const catalog = useModels(
    effective.provider,
    cwd,
    !!selection && !!effective.provider,
  );
  const label = formatSelectionLabel(selection, agent, providers.data, t);

  return (
    <>
      <SettingsChoiceRow
        title={t("channels.bot.modelLabel")}
        description={t(
          selection
            ? "channels.bot.modelOverrideDesc"
            : "channels.bot.modelInheritDesc",
          { model: label },
        )}
        value={selection ? "override" : "inherit"}
        disabled={disabled}
        options={[
          { value: "inherit", label: t("channels.bot.modelFollow") },
          { value: "override", label: t("channels.bot.modelOverride") },
        ]}
        onChange={(mode) => onChange(mode === "override" ? base : undefined)}
      />
      {selection && (
        <SettingsRow title={t("profile.model")}>
          <ModelPicker
            providers={providers.data}
            catalog={catalog}
            value={selection}
            cwd={cwd}
            open={open}
            onOpenChange={setOpen}
            onChange={onChange}
            selectionForProvider={(provider, previous) =>
              previous ?? {
                provider,
                model: provider === base.provider ? base.model : "",
                effort: "",
                fast: false,
              }
            }
          />
        </SettingsRow>
      )}
    </>
  );
}
