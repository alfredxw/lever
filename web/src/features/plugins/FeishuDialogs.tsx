import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, Copy, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  ChannelPairInput,
  ChannelRegistration,
  ChannelView,
  FeishuBotCreateInput,
  FeishuBotCredentialsInput,
  FeishuBotView,
  FeishuChatOverride,
  Selection,
} from "@/api/types.gen";
import { ErrorNotice } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useModels, useProviders } from "@/features/runtime/queries";
import {
  feishuPath,
  feishuQueryKey,
  registrationInProgress,
  useFeishuBotChats,
} from "./channelQuery";
import { FeishuPairForm } from "./FeishuPairForm";
import {
  baseSelectionForAgent,
  botDisplayName,
  countRuleOverrides,
  FEISHU_PRESET_KEYS,
  type FeishuPresetKey,
  formatSelectionLabel,
  primaryWorkspaceForAgent,
  shortId,
} from "./feishuPresets";

function syncChannelCache(next: ChannelView) {
  queryClient.setQueryData(feishuQueryKey, next);
  void queryClient.invalidateQueries({ queryKey: ["overview"] });
}

// =========================================================================
// 1. Add / Bind New Bot Dialog (Existing Credentials or QR Scan + Preset)
// =========================================================================
export function FeishuAddBotDialog({
  open,
  onOpenChange,
  agents,
  registration,
  onBotCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  registration?: ChannelRegistration;
  onBotCreated: (next: ChannelView) => void;
}) {
  const { t } = useTranslation();
  const available = agents.filter((a) => !a.archived);
  const [mode, setMode] = useState<"existing" | "qr">("existing");
  const [brand, setBrand] = useState<"feishu" | "lark">("feishu");
  const [displayName, setDisplayName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [agentId, setAgentId] = useState(available[0]?.id ?? "");
  const [preset, setPreset] = useState<FeishuPresetKey>("dev");

  const createBot = useMutation({
    mutationFn: (payload: FeishuBotCreateInput) =>
      api<ChannelView>(`${feishuPath}/bots`, payload, "POST"),
    onSuccess: (next) => {
      syncChannelCache(next);
      const created = next.bots?.[next.bots.length - 1];
      toast.success(
        t("channels.bot.addedToast", {
          name: created ? botDisplayName(created, t("channels.feishu")) : appId,
        }),
      );
      onBotCreated(next);
      onOpenChange(false);
    },
  });

  const startQr = useMutation({
    mutationFn: () =>
      api<ChannelView>(
        `${feishuPath}/bots/registration`,
        {
          displayName: displayName.trim(),
          agentId,
          preset,
          brand,
        },
        "POST",
      ),
    onSuccess: (next) => syncChannelCache(next),
  });

  const cancelQr = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${feishuPath}/registration`, {}, "DELETE"),
    onSuccess: (next) => syncChannelCache(next),
  });

  const qrRunning = registrationInProgress(registration);

  // Reset fields cleanly each time dialog opens
  useEffect(() => {
    if (!open) return;
    createBot.reset();
    startQr.reset();
    setDisplayName("");
    setAppId("");
    setAppSecret("");
    setAgentId((current) =>
      available.some((a) => a.id === current)
        ? current
        : (available[0]?.id ?? ""),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const busy = createBot.isPending || startQr.isPending || cancelQr.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && qrRunning) {
          cancelQr.mutate();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("channels.bot.addDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("channels.bot.addDialogDesc")}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode !== "existing") return;
            createBot.mutate({
              appId: appId.trim(),
              appSecret: appSecret.trim(),
              brand,
              displayName: displayName.trim(),
              agentId,
              preset,
            });
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              value={mode}
              disabled={busy}
              onValueChange={(v) => {
                if (v === "existing" || v === "qr") setMode(v);
              }}
            >
              <ToggleGroupItem value="existing">
                {t("channels.bot.modeExisting")}
              </ToggleGroupItem>
              <ToggleGroupItem value="qr">
                {t("channels.bot.modeQr")}
              </ToggleGroupItem>
            </ToggleGroup>

            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              value={brand}
              disabled={busy}
              onValueChange={(v) => {
                if (v === "feishu" || v === "lark") setBrand(v);
              }}
            >
              <ToggleGroupItem value="feishu">
                {t("channels.platformFeishu")}
              </ToggleGroupItem>
              <ToggleGroupItem value="lark">Lark</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {mode === "existing" ? (
            <>
              <Field>
                <FieldLabel htmlFor="feishu-add-name">
                  {t("channels.bot.displayName")}
                </FieldLabel>
                <Input
                  id="feishu-add-name"
                  placeholder={t("channels.bot.displayNamePlaceholder")}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="feishu-add-appid">App ID</FieldLabel>
                  <Input
                    id="feishu-add-appid"
                    className="font-mono text-xs"
                    placeholder="cli_xxxxxxxxxxxx"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="feishu-add-secret">
                    App Secret
                  </FieldLabel>
                  <Input
                    id="feishu-add-secret"
                    type="password"
                    className="font-mono text-xs"
                    placeholder="••••••••••••"
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    required
                  />
                </Field>
              </div>
            </>
          ) : (
            <div className="feishu-qr-card">
              {registration?.phase === "waiting" && registration.url ? (
                <>
                  <div className="feishu-qr-box">
                    <QRCodeSVG
                      value={registration.url}
                      size={112}
                      level="M"
                      title={t("channels.registration.qrCode")}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t("channels.registration.waiting")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <a
                          href={registration.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("channels.registration.openLink")}
                          <ArrowUpRight data-icon="inline-end" />
                        </a>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={cancelQr.isPending}
                        onClick={() => cancelQr.mutate()}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex w-full flex-col gap-2.5">
                  <p className="text-xs text-muted-foreground">
                    {registration && registration.phase !== "cancelled"
                      ? t(`channels.registration.${registration.phase}`)
                      : t("channels.registration.waiting")}
                  </p>
                  <Input
                    placeholder={t("channels.bot.displayNameOptional")}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={busy}
                  />
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => startQr.mutate()}
                    >
                      {t("channels.registration.start")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <Field>
            <FieldLabel>{t("channels.targetAgent")}</FieldLabel>
            <SearchableSelect
              label={t("channels.chooseAgent")}
              placeholder={t("channels.chooseAgent")}
              searchLabel={t("skills.agentFilter")}
              emptyLabel={t("personal.noAgents")}
              align="start"
              className="w-full"
              value={agentId}
              disabled={busy}
              options={available.map((agent) => ({
                id: agent.id,
                label: agent.name,
                icon: <AgentAvatar agent={agent} size="xs" />,
                description:
                  agent.profile.model || t("profile.defaultModel"),
              }))}
              onChange={setAgentId}
            />
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>{t("channels.bot.initialPreset")}</FieldLabel>
              <span className="text-xs text-muted-foreground">
                {t("channels.bot.initialPresetHint")}
              </span>
            </div>
            <div className="feishu-preset-grid">
              {FEISHU_PRESET_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  data-selected={preset === key}
                  className="feishu-preset-card"
                  disabled={busy}
                  onClick={() => setPreset(key)}
                >
                  <span className="feishu-preset-title">
                    {t(`channels.bot.preset.${key}`)}
                  </span>
                  <span className="feishu-preset-desc">
                    {t(`channels.bot.preset.${key}Desc`)}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          {(createBot.error || startQr.error) && (
            <ErrorNotice error={createBot.error ?? startQr.error} />
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            {mode === "existing" && (
              <Button
                type="submit"
                disabled={busy || !appId.trim() || !appSecret.trim()}
              >
                {t("channels.bot.verifyAndBind")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================================
// 2. Unified 5-in-1 Per-Group Rule Override Dialog
// =========================================================================
export function FeishuGroupRuleDialog({
  open,
  onOpenChange,
  bot,
  agent,
  rule,
  onSave,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: FeishuBotView;
  agent: Agent | undefined;
  rule: FeishuChatOverride | null;
  onSave: (next: FeishuChatOverride) => void;
  onDelete?: (ruleId: string) => void;
}) {
  const { t } = useTranslation();
  const providers = useProviders();
  const knownChats = useFeishuBotChats(bot.id, open);
  const [modelOpen, setModelOpen] = useState(false);

  const [draft, setDraft] = useState<FeishuChatOverride>(() =>
    makeEmptyRule(rule),
  );

  useEffect(() => {
    if (open) {
      setDraft(makeEmptyRule(rule));
      setModelOpen(false);
    }
  }, [open, rule]);

  const inheritedSelection =
    bot.settings.selection ?? baseSelectionForAgent(agent);
  const inheritedModelLabel = formatSelectionLabel(
    bot.settings.selection,
    agent,
    providers.data,
    t,
  );
  const effectiveSelection = draft.selection ?? inheritedSelection;
  const cwd = primaryWorkspaceForAgent(agent);
  const catalog = useModels(
    effectiveSelection.provider,
    cwd,
    open && !!draft.selection && !!effectiveSelection.provider,
  );

  const overrideCount = countRuleOverrides(draft);
  const chatOptions = [
    { id: "", label: t("channels.bot.ruleManualChat") },
    ...(knownChats.data ?? []).map((c) => ({
      id: c.chatId,
      label: c.name,
      description: shortId(c.chatId),
      keywords: [c.chatId, c.name],
    })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[580px]">
        <DialogHeader>
          <DialogTitle>
            {rule
              ? t("channels.bot.ruleDialogEditTitle")
              : t("channels.bot.ruleDialogAddTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("channels.bot.ruleDialogDesc", {
              bot: botDisplayName(bot, t("channels.feishu")),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[68vh] flex-col gap-4 overflow-y-auto pr-1">
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>{t("channels.bot.ruleSelectChat")}</FieldLabel>
              <span className="text-xs text-muted-foreground">
                {t("channels.bot.ruleSelectChatHint")}
              </span>
            </div>
            {(knownChats.data?.length ?? 0) > 0 && (
              <SearchableSelect
                label={t("channels.bot.ruleSelectChat")}
                placeholder={t("channels.bot.ruleManualChat")}
                searchLabel={t("channels.bot.ruleSelectChat")}
                emptyLabel={t("channels.bot.ruleManualChat")}
                align="start"
                className="w-full"
                value={
                  knownChats.data?.some((c) => c.chatId === draft.chatId)
                    ? draft.chatId
                    : ""
                }
                options={chatOptions}
                onChange={(chatId) => {
                  const found = knownChats.data?.find(
                    (c) => c.chatId === chatId,
                  );
                  if (found) {
                    setDraft((cur) => ({
                      ...cur,
                      chatId: found.chatId,
                      chatName: found.name,
                    }));
                  }
                }}
              />
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                placeholder={t("channels.bot.ruleChatNamePlaceholder")}
                value={draft.chatName ?? ""}
                onChange={(e) =>
                  setDraft((cur) => ({ ...cur, chatName: e.target.value }))
                }
              />
              <Input
                className="font-mono text-xs"
                placeholder={t("channels.bot.ruleChatIdPlaceholder")}
                value={draft.chatId}
                onChange={(e) =>
                  setDraft((cur) => ({ ...cur, chatId: e.target.value }))
                }
              />
            </div>
          </Field>

          <Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel htmlFor="feishu-rule-prompt">
                {t("channels.bot.rulePrompt")}
              </FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={1}
                value={draft.promptMode || "append"}
                onValueChange={(v) => {
                  if (v === "append" || v === "replace") {
                    setDraft((cur) => ({ ...cur, promptMode: v }));
                  }
                }}
              >
                <ToggleGroupItem value="append">
                  {t("channels.bot.rulePromptModeAppend")}
                </ToggleGroupItem>
                <ToggleGroupItem value="replace">
                  {t("channels.bot.rulePromptModeReplace")}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <Textarea
              id="feishu-rule-prompt"
              rows={3}
              maxLength={4000}
              placeholder={t("channels.bot.rulePromptPlaceholder")}
              value={draft.prompt ?? ""}
              onChange={(e) =>
                setDraft((cur) => ({ ...cur, prompt: e.target.value }))
              }
            />
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>{t("channels.bot.ruleOverrides")}</FieldLabel>
              <Badge variant="secondary">
                {t("channels.bot.ruleOverrideCount", { count: overrideCount })}
              </Badge>
            </div>
            <div className="feishu-override-box">
              {/* Group Model Override */}
              <div className="feishu-override-item">
                <div className="feishu-override-row">
                  <span className="text-xs font-medium">
                    {t("channels.bot.ruleGroupModel")}
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    spacing={1}
                    value={draft.selection ? "override" : "inherit"}
                    onValueChange={(v) => {
                      if (!v) return;
                      setDraft((cur) => ({
                        ...cur,
                        selection:
                          v === "override"
                            ? { ...inheritedSelection }
                            : undefined,
                      }));
                    }}
                  >
                    <ToggleGroupItem value="inherit">
                      {t("channels.bot.ruleFollowDefaultModel", {
                        model: inheritedModelLabel,
                      })}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="override">
                      {t("channels.bot.modelOverride")}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {draft.selection && (
                  <div className="pt-1">
                    <ModelPicker
                      providers={providers.data}
                      catalog={catalog}
                      value={draft.selection}
                      cwd={cwd}
                      open={modelOpen}
                      onOpenChange={setModelOpen}
                      onChange={(selection: Selection) =>
                        setDraft((cur) => ({ ...cur, selection }))
                      }
                      selectionForProvider={(provider, previous) =>
                        previous ?? {
                          provider,
                          model:
                            provider === inheritedSelection.provider
                              ? inheritedSelection.model
                              : "",
                          effort: "",
                          fast: false,
                        }
                      }
                    />
                  </div>
                )}
              </div>

              {/* Group Trigger Override */}
              <div className="feishu-override-item">
                <div className="feishu-override-row">
                  <span className="text-xs font-medium">
                    {t("channels.bot.groupMention")}
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    spacing={1}
                    className="flex-wrap"
                    value={draft.groupMention || "inherit"}
                    onValueChange={(v) => {
                      if (!v) return;
                      setDraft((cur) => ({
                        ...cur,
                        groupMention: v === "inherit" ? "" : v,
                      }));
                    }}
                  >
                    <ToggleGroupItem value="inherit">
                      {t("channels.bot.ruleFollowDefault")}
                    </ToggleGroupItem>
                    {(["at_only", "thread_free", "yield", "free"] as const).map(
                      (k) => (
                        <ToggleGroupItem key={k} value={k}>
                          {t(`channels.bot.groupMention.${k}`)}
                        </ToggleGroupItem>
                      ),
                    )}
                  </ToggleGroup>
                </div>
              </div>

              {/* Group Reply Target Override (includes dm_first) */}
              <div className="feishu-override-item">
                <div className="feishu-override-row">
                  <span className="text-xs font-medium">
                    {t("channels.bot.groupReplyTarget")}
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    spacing={1}
                    className="flex-wrap"
                    value={draft.groupReplyTarget || "inherit"}
                    onValueChange={(v) => {
                      if (!v) return;
                      setDraft((cur) => ({
                        ...cur,
                        groupReplyTarget: v === "inherit" ? "" : v,
                      }));
                    }}
                  >
                    <ToggleGroupItem value="inherit">
                      {t("channels.bot.ruleFollowDefault")}
                    </ToggleGroupItem>
                    {(["topic", "main", "quote", "dm_first"] as const).map(
                      (k) => (
                        <ToggleGroupItem key={k} value={k}>
                          {t(`channels.bot.groupReplyTarget.${k}`)}
                        </ToggleGroupItem>
                      ),
                    )}
                  </ToggleGroup>
                </div>
              </div>

              {/* Group Reply Style Override */}
              <div className="feishu-override-item">
                <div className="feishu-override-row">
                  <span className="text-xs font-medium">
                    {t("channels.bot.replyStyle")}
                  </span>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    spacing={1}
                    value={draft.replyStyle || "inherit"}
                    onValueChange={(v) => {
                      if (!v) return;
                      setDraft((cur) => ({
                        ...cur,
                        replyStyle: v === "inherit" ? "" : v,
                      }));
                    }}
                  >
                    <ToggleGroupItem value="inherit">
                      {t("channels.bot.ruleFollowDefault")}
                    </ToggleGroupItem>
                    {(["card", "text"] as const).map((k) => (
                      <ToggleGroupItem key={k} value={k}>
                        {t(`channels.bot.replyStyle.${k}`)}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
            </div>
          </Field>
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {rule && onDelete && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  onDelete(rule.id);
                  onOpenChange(false);
                }}
              >
                {t("channels.bot.ruleDelete")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!draft.chatId.trim()}
              onClick={() => {
                const cleaned: FeishuChatOverride = {
                  ...draft,
                  id: draft.id || crypto.randomUUID(),
                  chatId: draft.chatId.trim(),
                  chatName:
                    draft.chatName?.trim() || shortId(draft.chatId.trim()),
                  prompt: draft.prompt?.trim() || "",
                };
                onSave(cleaned);
                onOpenChange(false);
              }}
            >
              {t("channels.bot.ruleSave")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function makeEmptyRule(rule: FeishuChatOverride | null): FeishuChatOverride {
  if (rule) {
    return {
      ...rule,
      selection: rule.selection ? { ...rule.selection } : undefined,
    };
  }
  return {
    id: "",
    chatId: "",
    chatName: "",
    enabled: true,
    promptMode: "append",
    prompt: "",
    selection: undefined,
    groupMention: "",
    groupReplyTarget: "",
    replyStyle: "",
  };
}

// =========================================================================
// 3. Edit Bot Credentials Dialog
// =========================================================================
export function FeishuCredsDialog({
  open,
  onOpenChange,
  bot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: FeishuBotView;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(
    bot.settings.displayName ?? bot.botName ?? "",
  );
  const [brand, setBrand] = useState(bot.brand || "feishu");
  const [appId, setAppId] = useState(bot.appId);
  const [appSecret, setAppSecret] = useState("");

  useEffect(() => {
    if (!open) return;
    setDisplayName(bot.settings.displayName ?? bot.botName ?? "");
    setBrand(bot.brand || "feishu");
    setAppId(bot.appId);
    setAppSecret("");
  }, [open, bot]);

  const save = useMutation({
    mutationFn: (payload: FeishuBotCredentialsInput) =>
      api<ChannelView>(`${feishuPath}/bots/${bot.id}/credentials`, payload, "PUT"),
    onSuccess: (next) => {
      syncChannelCache(next);
      toast.success(t("channels.bot.credsSavedToast"));
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("channels.bot.credsDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("channels.bot.credsDialogDesc")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              displayName: displayName.trim(),
              brand,
              appId: appId.trim(),
              appSecret: appSecret.trim() || undefined,
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor="feishu-cred-name">
              {t("channels.bot.displayName")}
            </FieldLabel>
            <Input
              id="feishu-cred-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={save.isPending}
            />
          </Field>
          <Field>
            <FieldLabel>{t("channels.platform")}</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              value={brand}
              disabled={save.isPending}
              onValueChange={(v) => {
                if (v) setBrand(v);
              }}
            >
              <ToggleGroupItem value="feishu">
                {t("channels.platformFeishu")}
              </ToggleGroupItem>
              <ToggleGroupItem value="lark">Lark</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="feishu-cred-appid">App ID</FieldLabel>
              <Input
                id="feishu-cred-appid"
                className="font-mono text-xs"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                disabled={save.isPending}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="feishu-cred-secret">App Secret</FieldLabel>
              <Input
                id="feishu-cred-secret"
                type="password"
                className="font-mono text-xs"
                placeholder={t("channels.bot.keepSecretPlaceholder")}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                disabled={save.isPending}
              />
            </Field>
          </div>
          {save.error && <ErrorNotice error={save.error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !appId.trim()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================================
// 4. Feishu Scope Diagnosis Dialog
// =========================================================================
const FEISHU_SCOPE_ITEMS = [
  { key: "im:message:send_as_bot", descKey: "channels.bot.scope.sendAsBot" },
  { key: "im:message.p2p_msg:readonly", descKey: "channels.bot.scope.p2p" },
  {
    key: "im:message.group_at_msg:readonly",
    descKey: "channels.bot.scope.groupAt",
  },
  { key: "im:message.group_msg", descKey: "channels.bot.scope.groupMsg" },
  { key: "im:chat:readonly", descKey: "channels.bot.scope.chatRead" },
  {
    key: "im:message.reactions:write_only",
    descKey: "channels.bot.scope.reactions",
  },
] as const;

export function FeishuScopesDialog({
  open,
  onOpenChange,
  bot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: FeishuBotView;
}) {
  const { t } = useTranslation();
  const missing = new Set(bot.missingScopes ?? []);
  const recheck = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${feishuPath}/bots/${bot.id}/check-scopes`, {}, "POST"),
    onSuccess: (next) => {
      syncChannelCache(next);
      toast.success(t("channels.bot.scopeRechecked"));
    },
  });
  const domain = bot.brand === "lark" ? "larksuite.com" : "feishu.cn";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("channels.bot.scopesDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("channels.bot.scopesDialogDesc", {
              bot: botDisplayName(bot, t("channels.feishu")),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="feishu-scope-list">
          {FEISHU_SCOPE_ITEMS.map((item) => {
            const isMissing = missing.has(item.key);
            return (
              <div key={item.key} className="feishu-scope-row">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-xs font-medium">
                    {item.key}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(item.descKey)}
                  </span>
                </div>
                <span
                  className="feishu-status-pill shrink-0"
                  data-tone={isMissing ? "attention" : "positive"}
                >
                  {t(
                    isMissing
                      ? "channels.bot.scopeMissing"
                      : "channels.bot.scopeReady",
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {recheck.error && <ErrorNotice error={recheck.error} />}

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              <RefreshCw
                data-icon="inline-start"
                className={recheck.isPending ? "animate-spin" : undefined}
              />
              {t("channels.bot.scopeRecheck")}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a
                href={`https://open.${domain}/app/${encodeURIComponent(bot.appId)}/auth`}
                target="_blank"
                rel="noreferrer"
              >
                {t("channels.openDeveloperConsole")}
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </Button>
          </div>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =========================================================================
// 5. Optional Owner DM Pairing Dialog (per-bot /pair code + confirmation)
// =========================================================================
export function FeishuPairDialog({
  open,
  onOpenChange,
  bot,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: FeishuBotView;
  agents: Agent[];
}) {
  const { t } = useTranslation();
  const available = agents.filter((a) => !a.archived);
  const startPair = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${feishuPath}/bots/${bot.id}/pair`, {}, "POST"),
    onSuccess: syncChannelCache,
  });
  const confirmPair = useMutation({
    mutationFn: (input: ChannelPairInput) =>
      api<ChannelView>(`${feishuPath}/bots/${bot.id}/binding`, input, "POST"),
    onSuccess: (next) => {
      syncChannelCache(next);
      onOpenChange(false);
    },
  });

  useEffect(() => {
    if (
      open &&
      !bot.paired &&
      !bot.pairCode &&
      !bot.pairCandidate &&
      bot.connection === "online" &&
      !startPair.isPending
    ) {
      startPair.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot.id]);

  const busy = startPair.isPending || confirmPair.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("channels.bot.dmPairTitle")}</DialogTitle>
          <DialogDescription>{t("channels.bot.dmPairDesc")}</DialogDescription>
        </DialogHeader>

        {bot.pairCandidate ? (
          <FeishuPairForm
            candidate={bot.pairCandidate}
            botName={botDisplayName(bot, t("channels.feishu"))}
            agents={available}
            busy={busy}
            online={bot.connection === "online"}
            onRenew={() => startPair.mutate()}
            onConfirm={(input) => confirmPair.mutate(input)}
          />
        ) : bot.pairCode ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t("channels.pairHint", {
                name: botDisplayName(bot, t("channels.feishu")),
                platform:
                  bot.brand === "lark" ? "Lark" : t("channels.platformFeishu"),
              })}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs select-all">
                /pair {bot.pairCode}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t("channels.bot.copy")}
                onClick={() => {
                  void navigator.clipboard.writeText(`/pair ${bot.pairCode}`);
                  toast.success(t("channels.bot.copied"));
                }}
              >
                <Copy />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("channels.pairExpiry")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {bot.pairLocked && (
              <p className="text-xs text-muted-foreground">
                {t("channels.pairLocked")}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy || bot.connection !== "online"}
              onClick={() => startPair.mutate()}
            >
              {t("channels.generatePair")}
            </Button>
          </div>
        )}

        {(startPair.error || confirmPair.error) && (
          <ErrorNotice error={startPair.error ?? confirmPair.error} />
        )}
      </DialogContent>
    </Dialog>
  );
}
