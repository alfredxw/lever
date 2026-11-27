import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { api, queryClient } from "@/api/client";
import type {
  Agent,
  PersonalChannelChatMode,
  PersonalChannelReceipt,
  PersonalChannelRoute,
  PersonalChannelSettings,
  PersonalChannelView,
  Plugin,
  Selection,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { connectionName } from "@/features/runtime/connections";
import { useModels, useProviders } from "@/features/runtime/queries";
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsRow,
} from "@/features/settings/SettingsControls";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { AutoSaveMode } from "@/lib/autoSave";

const commandPattern = /^\/[\p{L}\p{N}_-]{1,48}$/u;
const reactionPattern = /^[A-Za-z0-9_+-]{1,64}$/;
const chatIdPattern = /^[1-9][0-9]{0,30}$/;
const personalChatModes: readonly PersonalChannelChatMode[] = [
  "single",
  "byChat",
];

function words(value: string) {
  return value.split(/[\s,，]+/u).filter(Boolean);
}

const reactionIcons = new Map([
  ["OnIt", "🛠️"],
  ["Get", "📩"],
  ["OK", "👌"],
  ["THUMBSUP", "👍"],
  ["DONE", "✅"],
  ["OneSecond", "☝️"],
  ["THINKING", "🤔"],
  ["SALUTE", "🫡"],
  ["THANKS", "🙏"],
  ["HEART", "❤️"],
  ["APPLAUSE", "👏"],
  ["MUSCLE", "💪"],
  ["SMILE", "🙂"],
  ["LAUGH", "😄"],
  ["PARTY", "🎉"],
]);
const customReactionOption = ":custom";

function reactionOption(key: string, t: TFunction) {
  const icon = reactionIcons.get(key);
  return {
    id: key,
    label: icon ? t(`personal.reaction.${key}`) : key,
    icon: icon && <span aria-hidden="true">{icon}</span>,
    keywords: icon ? [key, icon] : [key],
  };
}

type RouteDraft = PersonalChannelRoute & { input: string };

type PersonalChannelPayload = Omit<
  PersonalChannelSettings,
  "prompt" | "chatMode"
> & {
  prompt?: string;
  chatMode?: PersonalChannelChatMode;
};

type PersonalDraft = {
  settings: PersonalChannelSettings;
  routes: RouteDraft[];
  restricted: boolean;
  chats: string;
  contextLimit: string;
  customReaction: boolean;
};

function draftFromSettings(initial: PersonalChannelSettings): PersonalDraft {
  return {
    settings: initial,
    routes: (initial.routes ?? []).map((route) => ({
      ...route,
      input: route.commands.join(" "),
    })),
    restricted: !!initial.chatIds?.length,
    chats: initial.chatIds?.join(" ") ?? "",
    contextLimit: String(initial.contextLimit || 20),
    customReaction: !!initial.reaction && !reactionIcons.has(initial.reaction),
  };
}

function normalizePayload(
  settings: PersonalChannelPayload,
  supportsChannelModel: boolean,
  supportsChatMode: boolean,
): PersonalChannelPayload {
  const { prompt, chatMode, ...rest } = settings;
  return {
    threadReply: !!rest.threadReply,
    signature: rest.signature ?? "",
    contextLimit: rest.contextLimit || 0,
    reaction: (rest.reaction ?? "").trim(),
    chatIds: rest.chatIds ?? [],
    routes: (rest.routes ?? []).map(
      ({ agentId, enabled, commands, selection }) => ({
        agentId,
        enabled,
        commands,
        ...(supportsChannelModel && selection ? { selection } : {}),
      }),
    ),
    ...(supportsChannelModel ? { prompt: (prompt ?? "").trim() } : {}),
    ...(supportsChatMode ? { chatMode: chatMode || "single" } : {}),
  };
}

function settingsSignature(
  settings: PersonalChannelPayload,
  supportsChannelModel: boolean,
  supportsChatMode: boolean,
) {
  return JSON.stringify(
    normalizePayload(settings, supportsChannelModel, supportsChatMode),
  );
}

function validateDraft(draft: PersonalDraft) {
  const invalidRoutes = new Set<string>();
  const seenCommands = new Map<string, string>();
  for (const route of draft.routes) {
    const commands = words(route.input);
    if (
      commands.length === 0 ||
      commands.length > 24 ||
      commands.some((cmd) => !commandPattern.test(cmd))
    ) {
      invalidRoutes.add(route.agentId);
      continue;
    }
    for (const cmd of commands) {
      const lower = cmd.toLowerCase();
      const existingOwner = seenCommands.get(lower);
      if (existingOwner !== undefined) {
        invalidRoutes.add(existingOwner);
        invalidRoutes.add(route.agentId);
      } else {
        seenCommands.set(lower, route.agentId);
      }
    }
  }
  const reaction = draft.settings.reaction.trim();
  const emojiEmpty = draft.customReaction && !reaction;
  const emojiInvalid = draft.customReaction && !reactionPattern.test(reaction);
  const chatIds = words(draft.chats);
  const chatsEmpty = draft.restricted && chatIds.length === 0;
  const chatsInvalid =
    draft.restricted &&
    (chatIds.length === 0 ||
      chatIds.length > 256 ||
      chatIds.some((id) => !chatIdPattern.test(id)));
  const limitText = draft.contextLimit.trim();
  const limitNum = Number(limitText);
  const limitInvalid =
    !!draft.settings.contextLimit &&
    (!/^\d+$/.test(limitText) || limitNum < 1 || limitNum > 50);
  const valid =
    invalidRoutes.size === 0 && !emojiInvalid && !chatsInvalid && !limitInvalid;
  return {
    valid,
    invalidRoutes,
    emojiEmpty,
    emojiInvalid,
    chatsEmpty,
    chatsInvalid,
    limitInvalid,
  };
}

function buildPayload(
  draft: PersonalDraft,
  supportsChannelModel: boolean,
  supportsChatMode: boolean,
): PersonalChannelPayload {
  const { prompt, chatMode, ...replySettings } = draft.settings;
  return normalizePayload(
    {
      ...replySettings,
      ...(supportsChannelModel ? { prompt } : {}),
      ...(supportsChatMode ? { chatMode } : {}),
      chatIds: draft.restricted ? words(draft.chats) : [],
      contextLimit: draft.settings.contextLimit
        ? Number(draft.contextLimit.trim())
        : 0,
      reaction: draft.settings.reaction.trim(),
      routes: draft.routes.map(({ agentId, enabled, input, selection }) => ({
        agentId,
        enabled,
        ...(supportsChannelModel && selection ? { selection } : {}),
        commands: words(input),
      })),
    },
    supportsChannelModel,
    supportsChatMode,
  );
}

function uniqueRouteCommand(name: string, routes: RouteDraft[]) {
  const base =
    name
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .slice(0, 48) || "agent";
  const taken = new Set(
    routes.flatMap((route) =>
      words(route.input).map((cmd) => cmd.toLowerCase()),
    ),
  );
  if (!taken.has(`/${base.toLowerCase()}`)) return `/${base}`;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const candidate = `/${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `/${base}`;
}

function RouteModel({
  agent,
  choice,
  change,
}: {
  agent: Agent;
  choice?: Selection;
  change: (choice?: Selection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const providers = useProviders();
  const profile = agent.profile;
  const base = {
    provider: profile.provider,
    model: profile.model,
    effort: profile.effort ?? "",
    fast: Boolean(profile.fast),
  };
  const selected = choice ?? base;
  const cwd =
    profile.roots.find(({ id }) => id === profile.primaryRootId)?.path ?? "";
  const catalog = useModels(
    selected.provider,
    cwd,
    !!choice && !!selected.provider,
  );
  const runtime = providers.data?.find(({ id }) => id === selected.provider);
  const name = runtime
    ? connectionName(runtime, providers.data ?? [], t)
    : selected.provider;
  return (
    <>
      <SettingsChoiceRow
        title={t("personal.routeModel", { name: agent.name })}
        description={
          choice
            ? undefined
            : [name, profile.model || t("profile.defaultModel")]
                .filter(Boolean)
                .join(" · ")
        }
        value={choice ? "override" : "inherit"}
        onChange={(value) => change(value === "override" ? base : undefined)}
        options={[
          { value: "inherit", label: t("personal.inheritModel") },
          { value: "override", label: t("personal.overrideModel") },
        ]}
      />
      {choice && (
        <SettingsRow title={t("profile.model")} description={name}>
          <ModelPicker
            providers={providers.data}
            catalog={catalog}
            value={choice}
            cwd={cwd}
            open={open}
            onOpenChange={setOpen}
            onChange={change}
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

export function PersonalChannel({
  plugin,
  agents,
  onOpenChat,
  onOpenReceipt,
}: {
  plugin: Plugin;
  agents: Agent[];
  onOpenChat: (chat: string, agent: string, title: string) => void;
  onOpenReceipt?: (receipt: PersonalChannelReceipt, title: string) => void;
}) {
  const { t } = useTranslation();
  const path = `/plugins/${plugin.id}/channel`;
  const providers = useProviders();
  const query = useQuery({
    queryKey: ["channel", plugin.id],
    queryFn: ({ signal }) =>
      api<PersonalChannelView>(path, undefined, "GET", signal),
    refetchInterval: plugin.enabled ? 1500 : false,
  });
  const [region, setRegion] = useState("feishu");
  const action = useMutation({
    mutationFn: (name: string) => api(path + "/" + name, { region }),
    onSuccess: () => query.refetch(),
  });
  const view = query.data;
  if (!view)
    return query.error ? <ErrorNotice error={query.error} /> : <Loading />;
  const busy = action.isPending || !plugin.enabled;
  const connecting = view.state === "preparing" || view.state === "connecting";
  const pairing = !view.account && (view.state === "pairing" || connecting);
  const last = view.last;
  const lastReaction = last?.reaction && reactionOption(last.reaction, t);
  const lastRuntime = providers.data?.find(
    ({ id }) => id === last?.selection?.provider,
  );
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SettingsGroup title={t("personal.account")}>
        <SettingsRow
          title={
            view.account
              ? `${view.region === "lark" ? "Lark" : t("channels.platformFeishu")} · ${view.account}`
              : t("personal.ownerOnly")
          }
          description={t("personal.consent")}
        >
          <span role="status" className="text-control text-muted-foreground">
            {t(`personal.state.${plugin.enabled ? view.state : "disabled"}`)}
          </span>
        </SettingsRow>
        {!view.account && !pairing && (
          <SettingsChoiceRow
            title={t("channels.platform")}
            value={region}
            onChange={setRegion}
            options={[
              { value: "feishu", label: t("channels.platformFeishu") },
              { value: "lark", label: "Lark" },
            ]}
          />
        )}
        <div className="flex flex-wrap items-center gap-2 p-3">
          {view.qr && plugin.enabled && (
            <QRCodeSVG
              value={view.qr}
              size={176}
              marginSize={4}
              title={t("personal.scan")}
            />
          )}
          {!view.account ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action.mutate(pairing ? "logout" : "login")}
            >
              {t(pairing ? "common.cancel" : "personal.scan")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  action.mutate(
                    view.state === "online" || connecting ? "pause" : "connect",
                  )
                }
              >
                {t(
                  view.state === "online" || connecting
                    ? "channels.pause"
                    : "channels.reconnect",
                )}
              </Button>
              <Button
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate("logout")}
              >
                {t("personal.logout")}
              </Button>
            </>
          )}
          {action.error && <ErrorNotice error={action.error} />}
        </div>
      </SettingsGroup>
      {last && (
        <SettingsGroup title={t("personal.last")}>
          <SettingsRow
            title={
              <>
                <code>{last.command}</code> →{" "}
                {agents.find((agent) => agent.id === last.agentId)?.name ??
                  t("channels.targetAgent")}
              </>
            }
            description={[
              last.chatName,
              last.contextReady === false && last.runStatus === "queued"
                ? t("personal.preparing")
                : last.runStatus && t(`status.${last.runStatus}`),
              lastRuntime
                ? connectionName(lastRuntime, providers.data ?? [], t)
                : last.selection?.provider,
              last.selection &&
                (last.selection.model || t("profile.defaultModel")),
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <Button
              variant="outline"
              onClick={() => {
                const title = last.chatName
                  ? `${plugin.manifest.name} · ${last.chatName}`
                  : plugin.manifest.name;
                if (onOpenReceipt) onOpenReceipt(last, title);
                else onOpenChat(last.chatId, last.agentId, title);
              }}
            >
              {t("channels.openChat")}
            </Button>
          </SettingsRow>
          <SettingsRow title={t("personal.ack")}>
            <span role="status" className="text-control">
              {lastReaction && (
                <>
                  {lastReaction.icon} {lastReaction.label} ·{" "}
                </>
              )}
              {t(`personal.receipt.${last.reactionStatus || "unrecorded"}`)}
            </span>
          </SettingsRow>
          <SettingsRow title={t("personal.delivery")}>
            <span className="text-control">
              {t(
                last.runStatus === "failed" && last.status === "sent"
                  ? "personal.failureDelivered"
                  : `channels.reply.${last.status}`,
              )}
            </span>
          </SettingsRow>
        </SettingsGroup>
      )}
      <PersonalSettings
        key={plugin.id}
        pluginId={plugin.id}
        initial={view.settings}
        path={path}
        agents={agents}
        refresh={() => query.refetch()}
      />
    </div>
  );
}

function PersonalSettings({
  pluginId,
  initial,
  path,
  agents,
  refresh,
}: {
  pluginId: string;
  initial: PersonalChannelSettings;
  path: string;
  agents: Agent[];
  refresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const key = useId();
  // A new desktop window can reattach to an older backend that owns active runs.
  const supportsChannelModel = typeof initial.prompt === "string";
  const supportsChatMode =
    typeof initial.chatMode === "string" && initial.chatMode !== "";
  const [draft, setDraft] = useState<PersonalDraft>(() =>
    draftFromSettings(initial),
  );
  const [touchedEmoji, setTouchedEmoji] = useState(false);
  const [touchedChats, setTouchedChats] = useState(false);
  const initialSig = settingsSignature(
    initial,
    supportsChannelModel,
    supportsChatMode,
  );
  const prevInitialSig = useRef(initialSig);
  const pendingOwnEchoes = useRef<string[]>([]);

  const autoSave = useAutoSave<PersonalChannelPayload, unknown>({
    initialSignature: initialSig,
    save: (payload) => api(path, payload, "PUT"),
    onSaved: (_result, sent, sentSig) => {
      if (sentSig !== prevInitialSig.current)
        pendingOwnEchoes.current.push(sentSig);
      queryClient.setQueryData<PersonalChannelView>(
        ["channel", pluginId],
        (current) =>
          current
            ? { ...current, settings: { ...current.settings, ...sent } }
            : current,
      );
      void refresh();
    },
  });

  useEffect(() => {
    if (initialSig === prevInitialSig.current) return;
    prevInitialSig.current = initialSig;
    const echoIndex = pendingOwnEchoes.current.indexOf(initialSig);
    if (echoIndex !== -1) {
      pendingOwnEchoes.current.splice(0, echoIndex + 1);
      return;
    }
    pendingOwnEchoes.current = [];
    autoSave.syncSaved(initialSig);
    if (
      !autoSave.saving &&
      !autoSave.pending &&
      !autoSave.error &&
      validateDraft(draft).valid
    ) {
      setDraft(draftFromSettings(initial));
    }
  }, [
    initial,
    initialSig,
    draft,
    autoSave.saving,
    autoSave.pending,
    autoSave.error,
    autoSave.syncSaved,
  ]);

  function updateDraft(next: PersonalDraft, mode: AutoSaveMode) {
    setDraft(next);
    const check = validateDraft(next);
    if (!check.valid) {
      autoSave.cancelPending();
      return;
    }
    const payload = buildPayload(next, supportsChannelModel, supportsChatMode);
    autoSave.schedule(payload, JSON.stringify(payload), mode);
  }

  const set = (change: Partial<PersonalChannelSettings>, mode: AutoSaveMode) =>
    updateDraft({ ...draft, settings: { ...draft.settings, ...change } }, mode);

  const routeChange = (
    id: string,
    patch: Partial<RouteDraft>,
    mode: AutoSaveMode,
  ) =>
    updateDraft(
      {
        ...draft,
        routes: draft.routes.map((route) =>
          route.agentId === id ? { ...route, ...patch } : route,
        ),
      },
      mode,
    );

  function flushOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      autoSave.flush();
    }
  }

  const { settings, routes, restricted, chats, contextLimit, customReaction } =
    draft;
  const validation = validateDraft(draft);
  const showEmojiError =
    validation.emojiInvalid && (!validation.emojiEmpty || touchedEmoji);
  const showChatsError =
    validation.chatsInvalid && (!validation.chatsEmpty || touchedChats);

  const available = agents.filter(
    (agent) =>
      !agent.archived && !routes.some((route) => route.agentId === agent.id),
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {(!supportsChannelModel || !supportsChatMode) && (
        <p role="status" className="text-control text-muted-foreground">
          {t("personal.restartForModel")}
        </p>
      )}
      <SettingsGroup title={t("personal.routes")}>
        {routes.map((route) => {
          const agent = agents.find((agent) => agent.id === route.agentId);
          const name = agent?.name ?? t("channels.unavailableAgent");
          const routeInvalid = validation.invalidRoutes.has(route.agentId);
          return (
            <Fragment key={route.agentId}>
              <SettingsRow id={key + route.agentId} title={name}>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={key + route.agentId}
                      className="min-w-0 font-mono"
                      required
                      placeholder="/agent /ai"
                      value={route.input}
                      aria-invalid={routeInvalid || undefined}
                      aria-describedby={
                        routeInvalid
                          ? `${key}${route.agentId}-error`
                          : undefined
                      }
                      onChange={(event) =>
                        routeChange(
                          route.agentId,
                          { input: event.target.value },
                          "debounced",
                        )
                      }
                      onBlur={() => autoSave.flush()}
                      onKeyDown={flushOnEnter}
                    />
                    <Switch
                      aria-label={t("plugins.enabled", { name })}
                      checked={route.enabled}
                      onCheckedChange={(enabled) =>
                        routeChange(route.agentId, { enabled }, "immediate")
                      }
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("personal.remove", { name })}
                      onClick={() =>
                        updateDraft(
                          {
                            ...draft,
                            routes: routes.filter((item) => item !== route),
                          },
                          "immediate",
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {routeInvalid && (
                    <FieldError
                      id={`${key}${route.agentId}-error`}
                      className="text-xs"
                    >
                      {t("personal.invalidCommands")}
                    </FieldError>
                  )}
                </div>
              </SettingsRow>
              {agent && supportsChannelModel && (
                <RouteModel
                  agent={agent}
                  choice={route.selection}
                  change={(selection) =>
                    routeChange(route.agentId, { selection }, "immediate")
                  }
                />
              )}
            </Fragment>
          );
        })}
        <SettingsRow
          title={t("personal.add")}
          description={t("personal.commandsHint")}
        >
          <SearchableSelect
            label={t("channels.chooseAgent")}
            placeholder={t("channels.chooseAgent")}
            searchLabel={t("skills.agentFilter")}
            emptyLabel={t("personal.noAgents")}
            options={available.map((agent) => ({
              id: agent.id,
              label: agent.name,
            }))}
            onChange={(agentId) => {
              const name = available.find(
                (agent) => agent.id === agentId,
              )!.name;
              const command = uniqueRouteCommand(name, routes);
              updateDraft(
                {
                  ...draft,
                  routes: [
                    ...routes,
                    { agentId, commands: [], input: command, enabled: true },
                  ],
                },
                "immediate",
              );
            }}
          />
        </SettingsRow>
        {supportsChatMode && (
          <SettingsChoiceRow
            title={t("personal.chatMode")}
            description={t(
              settings.chatMode === "byChat"
                ? "personal.chatModeHint.byChat"
                : "personal.chatModeHint.single",
            )}
            value={settings.chatMode === "byChat" ? "byChat" : "single"}
            options={personalChatModes.map((value) => ({
              value,
              label: t(`personal.chatMode.${value}`),
            }))}
            onChange={(value) => set({ chatMode: value }, "immediate")}
          />
        )}
      </SettingsGroup>
      <SettingsGroup title={t("personal.receipts")}>
        <SettingsRow
          id={key + "reaction"}
          title={t("personal.ack")}
          description={t("personal.ackHint")}
        >
          <SearchableSelect
            id={key + "reaction"}
            label={t("personal.ack")}
            placeholder={t("personal.receipt.off")}
            searchLabel={t("personal.searchReactions")}
            emptyLabel={t("personal.noReactions")}
            className="w-44 max-w-full"
            value={customReaction ? customReactionOption : settings.reaction}
            options={[
              { id: "", label: t("personal.receipt.off") },
              ...Array.from(reactionIcons.keys(), (id) =>
                reactionOption(id, t),
              ),
              {
                id: customReactionOption,
                label: t("personal.customReaction"),
              },
            ]}
            onChange={(choice) => {
              const custom = choice === customReactionOption;
              setTouchedEmoji(false);
              updateDraft(
                {
                  ...draft,
                  customReaction: custom,
                  settings: { ...settings, reaction: custom ? "" : choice },
                },
                "immediate",
              );
            }}
          />
        </SettingsRow>
        {customReaction && (
          <SettingsRow
            title={t("personal.emoji")}
            description={t("personal.emojiHint")}
            id={key + "emoji"}
          >
            <div className="flex w-full flex-col gap-1">
              <Input
                id={key + "emoji"}
                required
                maxLength={64}
                pattern="[A-Za-z0-9_+\-]{1,64}"
                placeholder="FINGERHEART"
                value={settings.reaction}
                aria-invalid={showEmojiError || undefined}
                aria-describedby={
                  showEmojiError
                    ? `${key}emoji-description ${key}emoji-error`
                    : `${key}emoji-description`
                }
                onChange={(event) =>
                  set({ reaction: event.target.value }, "debounced")
                }
                onBlur={() => {
                  setTouchedEmoji(true);
                  autoSave.flush();
                }}
                onKeyDown={flushOnEnter}
              />
              {showEmojiError && (
                <FieldError id={key + "emoji-error"} className="text-xs">
                  {t("personal.invalidEmoji")}
                </FieldError>
              )}
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup title={t("personal.scope")}>
        <SettingsChoiceRow
          title={t("personal.chats")}
          value={restricted ? "some" : "all"}
          options={[
            { value: "all", label: t("personal.all") },
            { value: "some", label: t("personal.selected") },
          ]}
          onChange={(value) => {
            const nextRestricted = value === "some";
            setTouchedChats(false);
            updateDraft({ ...draft, restricted: nextRestricted }, "immediate");
          }}
        />
        {restricted && (
          <SettingsRow title={t("personal.chatIds")} id={key + "chats"}>
            <div className="flex w-full flex-col gap-1">
              <Input
                id={key + "chats"}
                required
                value={chats}
                aria-invalid={showChatsError || undefined}
                aria-describedby={
                  showChatsError ? `${key}chats-error` : undefined
                }
                onChange={(event) =>
                  updateDraft(
                    { ...draft, chats: event.target.value },
                    "debounced",
                  )
                }
                onBlur={() => {
                  setTouchedChats(true);
                  autoSave.flush();
                }}
                onKeyDown={flushOnEnter}
              />
              {showChatsError && (
                <FieldError id={key + "chats-error"} className="text-xs">
                  {t("personal.invalidChatIds")}
                </FieldError>
              )}
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup title={t("personal.reply")}>
        <SettingsChoiceRow
          title={t("personal.where")}
          description={t("personal.threadHint")}
          value={settings.threadReply ? "thread" : "direct"}
          options={[
            { value: "thread", label: t("personal.thread") },
            { value: "direct", label: t("personal.direct") },
          ]}
          onChange={(value) =>
            set({ threadReply: value === "thread" }, "immediate")
          }
        />
        <SettingsRow title={t("personal.signature")} id={key + "sign"}>
          <Input
            id={key + "sign"}
            placeholder="AI · {agent}"
            maxLength={120}
            value={settings.signature}
            onChange={(event) =>
              set({ signature: event.target.value }, "debounced")
            }
            onBlur={() => autoSave.flush()}
            onKeyDown={flushOnEnter}
          />
        </SettingsRow>
        {supportsChannelModel && (
          <SettingsRow
            title={t("personal.prompt")}
            description={t("personal.promptHint")}
            id={key + "prompt"}
          >
            <Textarea
              id={key + "prompt"}
              rows={3}
              maxLength={4000}
              className="w-full sm:w-72"
              placeholder={t("personal.promptExample")}
              value={settings.prompt ?? ""}
              onChange={(event) =>
                set({ prompt: event.target.value }, "debounced")
              }
              onBlur={() => autoSave.flush()}
            />
          </SettingsRow>
        )}
        <SettingsChoiceRow
          title={t("personal.context")}
          value={settings.contextLimit ? "recent" : "quoted"}
          options={[
            { value: "quoted", label: t("personal.quoted") },
            { value: "recent", label: t("personal.recent") },
          ]}
          onChange={(value) => {
            const limit = value === "recent" ? 20 : 0;
            const nextLimitText =
              limit && validation.limitInvalid ? "20" : contextLimit;
            updateDraft(
              {
                ...draft,
                contextLimit: nextLimitText,
                settings: { ...settings, contextLimit: limit },
              },
              "immediate",
            );
          }}
        />
        {!!settings.contextLimit && (
          <SettingsRow title={t("personal.limit")} id={key + "limit"}>
            <div className="flex flex-col gap-1">
              <Input
                id={key + "limit"}
                type="number"
                className="w-20"
                min={1}
                max={50}
                required
                value={contextLimit}
                aria-invalid={validation.limitInvalid || undefined}
                aria-describedby={
                  validation.limitInvalid ? `${key}limit-error` : undefined
                }
                onChange={(event) =>
                  updateDraft(
                    { ...draft, contextLimit: event.target.value },
                    "debounced",
                  )
                }
                onBlur={() => autoSave.flush()}
                onKeyDown={flushOnEnter}
              />
              {validation.limitInvalid && (
                <FieldError id={key + "limit-error"} className="text-xs">
                  {t("personal.invalidContextLimit")}
                </FieldError>
              )}
            </div>
          </SettingsRow>
        )}
      </SettingsGroup>
      {autoSave.saving && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("common.saving")}
        </p>
      )}
      {!!autoSave.error && (
        <ErrorNotice error={autoSave.error} retry={autoSave.retry} />
      )}
    </div>
  );
}
