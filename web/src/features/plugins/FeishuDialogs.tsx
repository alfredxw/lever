import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, Copy, RefreshCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
  FeishuRegistrationInput,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useModels, useProviders } from "@/features/runtime/queries";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
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
  buildInitialBotSettings,
  countRuleOverrides,
  defaultFeishuInitialConfig,
  type FeishuInitialConfig,
  formatSelectionLabel,
  primaryWorkspaceForAgent,
  shortId,
} from "./feishuBotHelpers";

function syncChannelCache(next: ChannelView) {
  queryClient.setQueryData(feishuQueryKey, next);
  void queryClient.invalidateQueries({ queryKey: ["overview"] });
}

// =========================================================================
// Shared Chip List Input (Admins / Whitelist / Blocklist)
// =========================================================================
export function ChipListInput({
  items,
  staticChips,
  placeholder,
  disabled,
  align = "end",
  onChange,
}: {
  items: string[];
  staticChips?: string[];
  placeholder: string;
  disabled?: boolean;
  align?: "start" | "end";
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!items.includes(value)) {
      onChange([...items, value]);
    }
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="feishu-chip-list" data-align={align}>
      {staticChips?.map((label) => (
        <span key={label} className="feishu-chip">
          {label}
        </span>
      ))}
      {items.map((item) => (
        <span key={item} className="feishu-chip font-mono">
          {item}
          <button
            type="button"
            className="feishu-chip-remove"
            disabled={disabled}
            aria-label={t("channels.bot.removeItem", { item })}
            onClick={() => onChange(items.filter((x) => x !== item))}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Input
        className="h-7 w-36 px-2 text-xs"
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </div>
  );
}

// =========================================================================
// 1. Add / Bind New Bot Dialog (QR Scan by default + Direct Initial Settings)
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
  const reducedMotion = usePrefersReducedMotion();
  const available = agents.filter((a) => !a.archived);
  const [mode, setMode] = useState<"qr" | "manual">("qr");
  const [brand, setBrand] = useState<"feishu" | "lark">("feishu");
  const [displayName, setDisplayName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [agentId, setAgentId] = useState(available[0]?.id ?? "");
  const [config, setConfig] = useState<FeishuInitialConfig>(() =>
    defaultFeishuInitialConfig(),
  );

  const wasQrActiveRef = useRef(false);
  const userCancelledRef = useRef(false);
  const lastSyncedDraftRef = useRef("");

  const buildDraftInput = (
    nextDisplayName: string,
    nextAgentId: string,
    nextConfig: FeishuInitialConfig,
  ): FeishuRegistrationInput => ({
    displayName: nextDisplayName.trim(),
    agentId: nextAgentId,
    settings: buildInitialBotSettings(nextConfig, nextDisplayName, nextAgentId),
  });

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
    mutationFn: (payload: FeishuRegistrationInput) =>
      api<ChannelView>(`${feishuPath}/bots/registration`, payload, "POST"),
    onSuccess: (next) => syncChannelCache(next),
  });

  const updateQrDraft = useMutation({
    mutationFn: (payload: FeishuRegistrationInput) =>
      api<ChannelView>(`${feishuPath}/bots/registration`, payload, "PUT"),
  });

  const cancelQr = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${feishuPath}/registration`, {}, "DELETE"),
    onSuccess: (next) => syncChannelCache(next),
  });

  const qrRunning = registrationInProgress(registration);
  const qrActive =
    registration?.phase === "starting" || registration?.phase === "waiting";
  const manualBusy = createBot.isPending;

  // Reset to QR default and auto-start QR generation each time dialog opens
  useEffect(() => {
    if (!open) {
      wasQrActiveRef.current = false;
      userCancelledRef.current = false;
      lastSyncedDraftRef.current = "";
      return;
    }
    const nextAgentId = available.some((a) => a.id === agentId)
      ? agentId
      : (available[0]?.id ?? "");
    const nextConfig = defaultFeishuInitialConfig();
    setMode("qr");
    setBrand("feishu");
    setDisplayName("");
    setAppId("");
    setAppSecret("");
    setAgentId(nextAgentId);
    setConfig(nextConfig);
    createBot.reset();
    startQr.reset();
    updateQrDraft.reset();
    userCancelledRef.current = false;
    wasQrActiveRef.current = false;

    const payload = buildDraftInput("", nextAgentId, nextConfig);
    lastSyncedDraftRef.current = JSON.stringify(payload);
    if (
      registration?.phase === "starting" ||
      registration?.phase === "waiting"
    ) {
      updateQrDraft.mutate(payload);
    } else {
      startQr.mutate(payload);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep backend QR registration draft in sync as user adjusts Agent/name/options
  useEffect(() => {
    if (!open || mode !== "qr" || !qrActive) return;
    const payload = buildDraftInput(displayName, agentId, config);
    const serialized = JSON.stringify(payload);
    if (serialized === lastSyncedDraftRef.current) return;
    const timer = setTimeout(() => {
      lastSyncedDraftRef.current = serialized;
      updateQrDraft.mutate(payload);
    }, 180);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, qrActive, displayName, agentId, config]);

  // Detect successful QR completion (covers both new bot & re-authorizing an existing bot)
  useEffect(() => {
    if (!open || mode !== "qr") return;
    if (qrActive) {
      wasQrActiveRef.current = true;
      userCancelledRef.current = false;
      return;
    }
    if (
      wasQrActiveRef.current &&
      !userCancelledRef.current &&
      !registration &&
      !startQr.isPending &&
      !cancelQr.isPending
    ) {
      wasQrActiveRef.current = false;
      toast.success(t("channels.bot.qrBoundToast"));
      onOpenChange(false);
    }
  }, [
    open,
    mode,
    qrActive,
    registration,
    startQr.isPending,
    cancelQr.isPending,
    onOpenChange,
    t,
  ]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      userCancelledRef.current = true;
      wasQrActiveRef.current = false;
      if (qrRunning || startQr.isPending) {
        cancelQr.mutate();
      }
    }
    onOpenChange(nextOpen);
  };

  const switchMode = (nextMode: "qr" | "manual") => {
    if (nextMode === mode) return;
    setMode(nextMode);
    if (nextMode === "manual") {
      userCancelledRef.current = true;
      wasQrActiveRef.current = false;
      if (qrRunning || startQr.isPending) {
        cancelQr.mutate();
      }
    } else {
      userCancelledRef.current = false;
      wasQrActiveRef.current = false;
      startQr.reset();
      const payload = buildDraftInput(displayName, agentId, config);
      lastSyncedDraftRef.current = JSON.stringify(payload);
      startQr.mutate(payload);
    }
  };

  const handleRegenerateQr = async () => {
    startQr.reset();
    userCancelledRef.current = true;
    wasQrActiveRef.current = false;
    if (qrRunning) {
      try {
        await cancelQr.mutateAsync();
      } catch {
        // Proceed with starting a fresh registration even if cancel raced with expiry.
      }
    }
    userCancelledRef.current = false;
    const payload = buildDraftInput(displayName, agentId, config);
    lastSyncedDraftRef.current = JSON.stringify(payload);
    startQr.mutate(payload);
  };

  const qrLoading =
    startQr.isPending ||
    cancelQr.isPending ||
    registration?.phase === "starting" ||
    registration?.phase === "cancelling";
  const qrReady =
    !qrLoading &&
    registration?.phase === "waiting" &&
    !!registration.url &&
    registration.url.length <= 2500;
  const registrationDomain =
    registration?.brand === "lark" ? "larksuite.com" : "feishu.cn";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[580px]">
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
            if (mode !== "manual") return;
            createBot.mutate({
              appId: appId.trim(),
              appSecret: appSecret.trim(),
              brand,
              displayName: displayName.trim(),
              agentId,
              settings: buildInitialBotSettings(config, displayName, agentId),
            });
          }}
        >
          {/* Connection Mode Toggle (QR Scan is default; stays pinned above scroll area) */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={1}
              value={mode}
              disabled={manualBusy}
              onValueChange={(v) => {
                if (v === "qr" || v === "manual") switchMode(v);
              }}
            >
              <ToggleGroupItem value="qr">
                {t("channels.bot.modeQr")}
              </ToggleGroupItem>
              <ToggleGroupItem value="manual">
                {t("channels.bot.modeManual")}
              </ToggleGroupItem>
            </ToggleGroup>

            {mode === "manual" && (
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={1}
                value={brand}
                disabled={manualBusy}
                onValueChange={(v) => {
                  if (v === "feishu" || v === "lark") setBrand(v);
                }}
              >
                <ToggleGroupItem value="feishu">
                  {t("channels.platformFeishu")}
                </ToggleGroupItem>
                <ToggleGroupItem value="lark">Lark</ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>

          <div className="flex max-h-[min(70vh,680px)] flex-col gap-4 overflow-y-auto pr-1">
            {/* Connection Panel: QR Scan (Default) or Manual Credentials */}
            {mode === "qr" ? (
              <div className="feishu-qr-card">
                {qrReady && registration?.url ? (
                  <>
                    <div className="feishu-qr-box">
                      <QRCodeSVG
                        value={registration.url}
                        size={112}
                        level="M"
                        title={t("channels.registration.qrCode")}
                      />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("channels.registration.waiting")}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
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
                          onClick={() => void handleRegenerateQr()}
                        >
                          <RefreshCw data-icon="inline-start" />
                          {t("channels.registration.refresh")}
                        </Button>
                      </div>
                    </div>
                  </>
                ) : qrLoading ? (
                  <>
                    <div
                      className="feishu-qr-box feishu-qr-placeholder"
                      aria-hidden="true"
                    >
                      <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <p className="text-sm font-medium">
                        {t("channels.registration.starting")}
                      </p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t("channels.registration.waiting")}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="flex w-full flex-col gap-2.5">
                    {startQr.error ? (
                      <ErrorNotice error={startQr.error} />
                    ) : (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {registration?.phase
                          ? t(`channels.registration.${registration.phase}`)
                          : t("channels.registration.waiting")}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleRegenerateQr()}
                      >
                        <RefreshCw data-icon="inline-start" />
                        {t("channels.registration.regenerate")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => switchMode("manual")}
                      >
                        {t("channels.bot.switchToManual")}
                      </Button>
                      {registration?.appId && (
                        <Button asChild size="sm" variant="ghost">
                          <a
                            href={`https://open.${registrationDomain}/app/${encodeURIComponent(registration.appId)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("channels.openDeveloperConsole")}
                            <ArrowUpRight data-icon="inline-end" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="feishu-add-appid">App ID</FieldLabel>
                  <Input
                    id="feishu-add-appid"
                    className="font-mono text-xs"
                    placeholder="cli_xxxxxxxxxxxx"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    disabled={manualBusy}
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
                    disabled={manualBusy}
                    autoComplete="off"
                    required
                  />
                </Field>
              </div>
            )}

            {/* Target Agent & Optional Display Name */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                  disabled={manualBusy}
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
                <FieldLabel htmlFor="feishu-add-name">
                  {t("channels.bot.displayNameOptionalLabel")}
                </FieldLabel>
                <Input
                  id="feishu-add-name"
                  placeholder={t("channels.bot.displayNameOptionalPlaceholder")}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={manualBusy}
                />
              </Field>
            </div>

            {/* Direct Initial Settings (replaces opaque scene presets) */}
            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel>{t("channels.bot.initialSettings")}</FieldLabel>
                <span className="text-xs text-muted-foreground">
                  {t("channels.bot.initialSettingsHint")}
                </span>
              </div>
              <div className="feishu-override-box">
                {/* DM Access */}
                <div className="feishu-override-item">
                  <div className="feishu-override-row">
                    <span className="text-xs font-medium">
                      {t("channels.bot.dmAccess")}
                    </span>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      spacing={1}
                      className="flex-wrap"
                      value={config.dmAccess}
                      disabled={manualBusy}
                      onValueChange={(v) => {
                        if (v === "admin" || v === "whitelist" || v === "all") {
                          setConfig((cur) => ({ ...cur, dmAccess: v }));
                        }
                      }}
                    >
                      {(["admin", "whitelist", "all"] as const).map((k) => (
                        <ToggleGroupItem key={k} value={k}>
                          {t(`channels.bot.dmAccess.${k}`)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  {config.dmAccess === "whitelist" && (
                    <div className="pt-1">
                      <ChipListInput
                        items={config.dmWhitelist}
                        placeholder={t("channels.bot.whitelistPlaceholder")}
                        disabled={manualBusy}
                        align="start"
                        onChange={(dmWhitelist) =>
                          setConfig((cur) => ({ ...cur, dmWhitelist }))
                        }
                      />
                    </div>
                  )}
                </div>

                {/* DM Style */}
                <div className="feishu-override-item">
                  <div className="feishu-override-row">
                    <span className="text-xs font-medium">
                      {t("channels.bot.dmMode")}
                    </span>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      spacing={1}
                      value={config.dmMode}
                      disabled={manualBusy}
                      onValueChange={(v) => {
                        if (v === "continuous" || v === "topic") {
                          setConfig((cur) => ({ ...cur, dmMode: v }));
                        }
                      }}
                    >
                      <ToggleGroupItem value="continuous">
                        {t("channels.bot.dmMode.continuous")}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="topic">
                        {t("channels.bot.dmMode.topic")}
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                </div>

                {/* Reply Style */}
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
                      value={config.replyStyle}
                      disabled={manualBusy}
                      onValueChange={(v) => {
                        if (v === "card" || v === "text") {
                          setConfig((cur) => ({ ...cur, replyStyle: v }));
                        }
                      }}
                    >
                      <ToggleGroupItem value="card">
                        {t("channels.bot.replyStyle.card")}
                      </ToggleGroupItem>
                      <ToggleGroupItem value="text">
                        {t("channels.bot.replyStyle.text")}
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                </div>

                {/* Allow Group Chats */}
                <div className="feishu-override-item">
                  <div className="feishu-override-row">
                    <span className="text-xs font-medium">
                      {t("channels.bot.groupEnabled")}
                    </span>
                    <Switch
                      checked={config.groupEnabled}
                      disabled={manualBusy}
                      aria-label={t("channels.bot.groupEnabled")}
                      onCheckedChange={(groupEnabled) =>
                        setConfig((cur) => ({ ...cur, groupEnabled }))
                      }
                    />
                  </div>
                </div>

                {/* Group Chat Options (revealed when groupEnabled is on) */}
                <AnimatePresence initial={false}>
                  {config.groupEnabled && (
                    <motion.div
                      key="group-options"
                      initial={
                        reducedMotion ? false : { height: 0, opacity: 0 }
                      }
                      animate={{ height: "auto", opacity: 1 }}
                      exit={reducedMotion ? undefined : { height: 0, opacity: 0 }}
                      transition={{ duration: reducedMotion ? 0 : 0.16 }}
                      className="feishu-override-group overflow-hidden"
                    >
                      {/* Group Access */}
                      <div className="feishu-override-item">
                        <div className="feishu-override-row">
                          <span className="text-xs font-medium">
                            {t("channels.bot.groupAccess")}
                          </span>
                          <ToggleGroup
                            type="single"
                            variant="outline"
                            size="sm"
                            spacing={1}
                            value={config.groupAccess}
                            disabled={manualBusy}
                            onValueChange={(v) => {
                              if (v === "whitelist" || v === "any") {
                                setConfig((cur) => ({ ...cur, groupAccess: v }));
                              }
                            }}
                          >
                            {(["whitelist", "any"] as const).map((k) => (
                              <ToggleGroupItem key={k} value={k}>
                                {t(`channels.bot.groupAccess.${k}`)}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                        </div>
                      </div>

                      {/* Group Default Trigger */}
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
                            value={config.groupMention}
                            disabled={manualBusy}
                            onValueChange={(v) => {
                              if (
                                v === "at_only" ||
                                v === "thread_free" ||
                                v === "yield" ||
                                v === "free"
                              ) {
                                setConfig((cur) => ({
                                  ...cur,
                                  groupMention: v,
                                }));
                              }
                            }}
                          >
                            {(
                              [
                                "at_only",
                                "thread_free",
                                "yield",
                                "free",
                              ] as const
                            ).map((k) => (
                              <ToggleGroupItem key={k} value={k}>
                                {t(`channels.bot.groupMention.${k}`)}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                        </div>
                      </div>

                      {/* Group Reply Target */}
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
                            value={config.groupReplyTarget}
                            disabled={manualBusy}
                            onValueChange={(v) => {
                              if (
                                v === "topic" ||
                                v === "main" ||
                                v === "quote"
                              ) {
                                setConfig((cur) => ({
                                  ...cur,
                                  groupReplyTarget: v,
                                }));
                              }
                            }}
                          >
                            {(["topic", "main", "quote"] as const).map((k) => (
                              <ToggleGroupItem key={k} value={k}>
                                {t(`channels.bot.groupReplyTarget.${k}`)}
                              </ToggleGroupItem>
                            ))}
                          </ToggleGroup>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </Field>

            {mode === "manual" && createBot.error && (
              <ErrorNotice error={createBot.error} />
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={manualBusy}
              onClick={() => handleOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            {mode === "manual" && (
              <Button
                type="submit"
                disabled={manualBusy || !appId.trim() || !appSecret.trim()}
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
