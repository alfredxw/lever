import { Fragment, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type {
  Agent,
  PersonalChannelRoute,
  PersonalChannelSettings,
  PersonalChannelView,
  Plugin,
  Selection,
} from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
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
    effort: "",
    fast: false,
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
}: {
  plugin: Plugin;
  agents: Agent[];
  onOpenChat: (chat: string, agent: string, title: string) => void;
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
              onClick={() =>
                onOpenChat(last.chatId, last.agentId, plugin.manifest.name)
              }
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
        initial={view.settings}
        path={path}
        agents={agents}
        refresh={() => query.refetch()}
      />
    </div>
  );
}

function PersonalSettings({
  initial,
  path,
  agents,
  refresh,
}: {
  initial: PersonalChannelSettings;
  path: string;
  agents: Agent[];
  refresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const key = useId();
  // A new desktop window can reattach to an older backend that owns active runs.
  const supportsChannelModel = typeof initial.prompt === "string";
  const [settings, setSettings] = useState(initial);
  const [routes, setRoutes] = useState(() =>
    (initial.routes ?? []).map((route) => ({
      ...route,
      input: route.commands.join(" "),
    })),
  );
  const [restricted, setRestricted] = useState(!!initial.chatIds?.length);
  const [chats, setChats] = useState(initial.chatIds?.join(" ") ?? "");
  const [contextLimit, setContextLimit] = useState(
    String(initial.contextLimit || 20),
  );
  const [customReaction, setCustomReaction] = useState(
    !!initial.reaction && !reactionIcons.has(initial.reaction),
  );
  const [dirty, setDirty] = useState(false);
  const set = (change: Partial<PersonalChannelSettings>) => {
    setSettings({ ...settings, ...change });
    setDirty(true);
  };
  const routeChange = (
    id: string,
    patch: Partial<PersonalChannelRoute & { input: string }>,
  ) => {
    setRoutes(
      routes.map((route) =>
        route.agentId === id ? { ...route, ...patch } : route,
      ),
    );
    setDirty(true);
  };
  const { prompt, ...replySettings } = settings;
  const save = useMutation({
    mutationFn: () =>
      api(
        path,
        {
          ...replySettings,
          ...(supportsChannelModel && { prompt }),
          chatIds: restricted ? words(chats) : [],
          contextLimit: settings.contextLimit ? Number(contextLimit) : 0,
          reaction: settings.reaction.trim(),
          routes: routes.map(({ agentId, enabled, input, selection }) => ({
            agentId,
            enabled,
            ...(supportsChannelModel && { selection }),
            commands: words(input),
          })),
        },
        "PUT",
      ),
    onSuccess: async () => {
      await refresh();
      setDirty(false);
    },
  });
  const available = agents.filter(
    (agent) =>
      !agent.archived && !routes.some((route) => route.agentId === agent.id),
  );
  return (
    <form
      className="flex min-w-0 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <fieldset
        disabled={save.isPending}
        className="flex min-w-0 flex-col gap-6"
      >
        {!supportsChannelModel && (
          <p role="status" className="text-control text-muted-foreground">
            {t("personal.restartForModel")}
          </p>
        )}
        <SettingsGroup title={t("personal.routes")}>
          {routes.map((route) => {
            const agent = agents.find((agent) => agent.id === route.agentId);
            const name = agent?.name ?? t("channels.unavailableAgent");
            return (
              <Fragment key={route.agentId}>
                <SettingsRow id={key + route.agentId} title={name}>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={key + route.agentId}
                      className="min-w-0 font-mono"
                      required
                      placeholder="/agent /ai"
                      value={route.input}
                      onChange={(event) =>
                        routeChange(route.agentId, {
                          input: event.target.value,
                        })
                      }
                    />
                    <Switch
                      aria-label={t("plugins.enabled", { name })}
                      checked={route.enabled}
                      onCheckedChange={(enabled) =>
                        routeChange(route.agentId, { enabled })
                      }
                    />
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("personal.remove", { name })}
                      onClick={() => {
                        setRoutes(routes.filter((item) => item !== route));
                        setDirty(true);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </SettingsRow>
                {agent && supportsChannelModel && (
                  <RouteModel
                    agent={agent}
                    choice={route.selection}
                    change={(selection) =>
                      routeChange(route.agentId, { selection })
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
                const command =
                  "/" +
                  (name
                    .trim()
                    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
                    .slice(0, 48) || "agent");
                setRoutes([
                  ...routes,
                  { agentId, commands: [], input: command, enabled: true },
                ]);
                setDirty(true);
              }}
            />
          </SettingsRow>
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
                setCustomReaction(custom);
                set({ reaction: custom ? "" : choice });
              }}
            />
          </SettingsRow>
          {customReaction && (
            <SettingsRow
              title={t("personal.emoji")}
              description={t("personal.emojiHint")}
              id={key + "emoji"}
            >
              <Input
                id={key + "emoji"}
                required
                maxLength={64}
                pattern="[A-Za-z0-9_+\-]{1,64}"
                placeholder="FINGERHEART"
                value={settings.reaction}
                onChange={(event) => set({ reaction: event.target.value })}
              />
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
              setRestricted(value === "some");
              setDirty(true);
            }}
          />
          {restricted && (
            <SettingsRow title={t("personal.chatIds")} id={key + "chats"}>
              <Input
                id={key + "chats"}
                required
                value={chats}
                onChange={(event) => {
                  setChats(event.target.value);
                  setDirty(true);
                }}
              />
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
            onChange={(value) => set({ threadReply: value === "thread" })}
          />
          <SettingsRow title={t("personal.signature")} id={key + "sign"}>
            <Input
              id={key + "sign"}
              placeholder="AI · {agent}"
              maxLength={120}
              value={settings.signature}
              onChange={(event) => set({ signature: event.target.value })}
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
                onChange={(event) => set({ prompt: event.target.value })}
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
            onChange={(value) =>
              set({ contextLimit: value === "recent" ? 20 : 0 })
            }
          />
          {!!settings.contextLimit && (
            <SettingsRow title={t("personal.limit")} id={key + "limit"}>
              <Input
                id={key + "limit"}
                type="number"
                className="w-20"
                min={1}
                max={50}
                required
                value={contextLimit}
                onChange={(event) => {
                  setContextLimit(event.target.value);
                  setDirty(true);
                }}
              />
            </SettingsRow>
          )}
        </SettingsGroup>
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background py-2">
          <Button
            type="submit"
            disabled={
              !dirty ||
              save.isPending ||
              (restricted && !words(chats).length) ||
              (customReaction && !settings.reaction.trim())
            }
          >
            {t("common.save")}
          </Button>
          {dirty && (
            <span className="text-xs text-muted-foreground">
              {t("tasks.unsaved")}
            </span>
          )}
          {save.error && <ErrorNotice error={save.error} />}
        </div>
      </fieldset>
    </form>
  );
}
