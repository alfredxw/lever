import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Copy, Ellipsis, Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, queryClient } from "@/api/client";
import type { Agent, ChannelView } from "@/api/types.gen";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AgentSelect, FeishuPairForm } from "./FeishuPairForm";
import {
  feishuPath as path,
  feishuQueryKey as queryKey,
  feishuStatus,
  registrationInProgress,
  useFeishuChannel,
} from "./channelQuery";

type ChannelAction = {
  path: string;
  method?: "PUT" | "DELETE";
  body?: object;
};

export function FeishuChannel({
  agents,
  onOpenChat,
}: {
  agents: Agent[];
  onOpenChat: (chatId: string, agentId: string, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const query = useFeishuChannel(true, true);
  const channel = query.data;
  const [editingBot, setEditingBot] = useState(false);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [brand, setBrand] = useState("feishu");
  const [target, setTarget] = useState("");
  const [dialog, setDialog] = useState<"agent" | "unbind">();
  const update = useMutation({
    mutationFn: (action: ChannelAction) =>
      api<ChannelView>(path + action.path, action.body ?? {}, action.method),
    onSuccess: async (next, action) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, next);
      if (action.path === "/bot") {
        setSecret("");
        setEditingBot(false);
      }
      if (action.path === "/binding" || action.path === "/agent") {
        setDialog(undefined);
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
        void queryClient.invalidateQueries({ queryKey: ["chat"] });
      }
    },
  });
  const test = useMutation({
    mutationFn: () => api(path + "/test", {}),
    onSuccess: () => toast.success(t("channels.testSent")),
  });
  if (!channel) {
    return query.error ? (
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
    ) : (
      <Loading />
    );
  }
  const busy = update.isPending || test.isPending;
  const available = agents.filter((agent) => !agent.archived);
  const agent = agents.find((agent) => agent.id === channel.agentId);
  const registration = channel.registration;
  const registering = registrationInProgress(registration);
  const status = registering ? undefined : feishuStatus(channel);
  const online = channel.connection === "online";
  const bound = !!channel.chatId && !!channel.agentId;
  const platform = channel.brand === "lark" ? "Lark" : "Feishu";
  const chatTitle = `${platform} · ${channel.ownerName}`;
  const domain =
    (channel.appId ? channel.brand : registration?.brand) === "lark"
      ? "larksuite.com"
      : "feishu.cn";
  const editBot = () => {
    update.reset();
    setAppId(channel.appId ?? registration?.appId ?? "");
    setBrand((channel.appId ? channel.brand : registration?.brand) ?? "feishu");
    setSecret("");
    setEditingBot(true);
  };
  const pair = () => update.mutate({ path: "/pair" });

  return (
    <section className="channel-settings" aria-label={t("channels.settings")}>
      {query.error && (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      )}
      <div className="channel-heading">
        <div className="flex flex-col gap-1">
          {status && (
            <span
              className="plugin-status channel-status"
              data-status={status}
              role="status"
            >
              <span aria-hidden="true" />
              {t(`channels.status.${status}`)}
            </span>
          )}
          {channel.botName && (
            <span className="text-xs text-muted-foreground">
              {channel.botName}
            </span>
          )}
        </div>
        {bound && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                onOpenChat(channel.chatId!, channel.agentId!, chatTitle)
              }
            >
              <ArrowUpRight data-icon="inline-start" />
              {t("channels.openChat")}
            </Button>
            {channel.enabled && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("channels.actions")}
                    disabled={busy}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      update.reset();
                      setTarget(agent?.archived ? "" : channel.agentId!);
                      setDialog("agent");
                    }}
                  >
                    {t("channels.changeAgent")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      update.mutate({
                        path: "/pause",
                        method: "PUT",
                        body: { paused: !channel.paused },
                      })
                    }
                  >
                    {t(channel.paused ? "channels.resume" : "channels.pause")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={editBot}>
                    {t("channels.editBot")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      update.reset();
                      setDialog("unbind");
                    }}
                  >
                    {t("channels.unbind")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {bound && (
        <section className="channel-section">
          <h3>{t("channels.route")}</h3>
          <dl className="channel-route">
            <div>
              <dt>{t("channels.privateChat")}</dt>
              <dd>{channel.ownerName}</dd>
            </div>
            <ArrowRight aria-hidden="true" />
            <div>
              <dt>Agent</dt>
              <dd>{agent?.name ?? t("channels.unavailableAgent")}</dd>
            </div>
            <ArrowRight aria-hidden="true" />
            <div>
              <dt>Lever Chat</dt>
              <dd>{chatTitle}</dd>
            </div>
          </dl>
          {agent?.archived && (
            <p className="text-sm text-destructive">
              {t("channels.archivedAgent")}
            </p>
          )}
          {channel.enabled && channel.paused && (
            <p className="text-xs text-muted-foreground">
              {t("channels.pausedHint")}
            </p>
          )}
        </section>
      )}

      {channel.enabled && !channel.configured && !editingBot && (
        <section className="channel-section channel-form">
          <h3>{t("channels.connectBot")}</h3>
          {registration && (
            <p role="status" className="text-sm text-muted-foreground">
              {t(`channels.registration.${registration.phase}`)}
            </p>
          )}
          {registration?.url && registration.url.length <= 2500 && (
            <QRCodeSVG
              value={registration.url}
              size={240}
              marginSize={4}
              title={t("channels.registration.qrCode")}
              className="h-auto max-w-full rounded-md"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {registering ? (
              <>
                {registration?.url && (
                  <Button asChild variant="outline">
                    <a href={registration.url} target="_blank" rel="noreferrer">
                      {t("channels.registration.openLink")}
                      <ArrowUpRight data-icon="inline-end" />
                    </a>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy || registration?.phase === "cancelling"}
                  onClick={() =>
                    update.mutate({ path: "/registration", method: "DELETE" })
                  }
                >
                  {t("common.cancel")}
                </Button>
              </>
            ) : (
              <>
                {!registration?.appId && (
                  <Button
                    disabled={busy}
                    onClick={() => update.mutate({ path: "/registration" })}
                  >
                    {t("channels.registration.start")}
                  </Button>
                )}
                <Button variant="outline" disabled={busy} onClick={editBot}>
                  {t("channels.enterCredentials")}
                </Button>
                {registration?.appId && (
                  <Button asChild variant="ghost">
                    <a
                      href={`https://open.${domain}/app/${encodeURIComponent(registration.appId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("channels.openDeveloperConsole")}
                      <ArrowUpRight data-icon="inline-end" />
                    </a>
                  </Button>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {channel.enabled && editingBot ? (
        <form
          className="channel-section channel-form"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({
              path: "/bot",
              method: "PUT",
              body: { appId: appId.trim(), appSecret: secret.trim(), brand },
            });
          }}
        >
          <h3>{t("channels.connectBot")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("channels.setupHint")}{" "}
            <a
              className="underline underline-offset-4"
              href={`https://open.${brand === "lark" ? "larksuite.com" : "feishu.cn"}/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-`}
              target="_blank"
              rel="noreferrer"
            >
              {t("channels.setupGuide")}
            </a>
          </p>
          <Field>
            <FieldLabel id="lark-bot-platform">
              {t("channels.platform")}
            </FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              aria-labelledby="lark-bot-platform"
              value={brand}
              disabled={busy}
              onValueChange={(value) => {
                if (value) setBrand(value);
              }}
            >
              <ToggleGroupItem value="feishu">
                {t("channels.platformFeishu")}
              </ToggleGroupItem>
              <ToggleGroupItem value="lark">Lark</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="feishu-app-id">App ID</FieldLabel>
            <Input
              id="feishu-app-id"
              autoComplete="off"
              required
              maxLength={128}
              value={appId}
              disabled={busy}
              onChange={(e) => setAppId(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="feishu-app-secret">App Secret</FieldLabel>
            <Input
              id="feishu-app-secret"
              type="password"
              autoComplete="off"
              required
              maxLength={512}
              value={secret}
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              disabled={busy || !appId.trim() || !secret.trim()}
            >
              {t("channels.verifyBot")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEditingBot(false);
                setSecret("");
                update.reset();
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        channel.enabled &&
        channel.configured && (
          <section className="channel-section">
            <div className="channel-heading">
              <div className="flex min-w-0 flex-col gap-1">
                <h3>{t("channels.botConnection")}</h3>
                <code className="break-all text-xs text-muted-foreground">
                  {channel.appId}
                </code>
              </div>
              <div className="flex flex-wrap gap-2">
                {channel.appId && (!bound || !online) && (
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={`https://open.${domain}/app/${encodeURIComponent(channel.appId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("channels.openDeveloperConsole")}
                      <ArrowUpRight data-icon="inline-end" />
                    </a>
                  </Button>
                )}
                {!bound && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={editBot}
                  >
                    {t("channels.editBot")}
                  </Button>
                )}
                {!online && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => update.mutate({ path: "/reconnect" })}
                  >
                    {t("channels.reconnect")}
                  </Button>
                )}
                {bound && online && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => test.mutate()}
                  >
                    <Send data-icon="inline-start" />
                    {t("channels.test")}
                  </Button>
                )}
              </div>
            </div>
            {channel.connection === "error" && (
              <p className="text-xs text-muted-foreground">
                {t("channels.connectionHint")}
              </p>
            )}
          </section>
        )
      )}

      {channel.enabled && channel.configured && !bound && !editingBot && (
        <section className="channel-section">
          <h3>{t("channels.bindChat")}</h3>
          {channel.pairCandidate ? (
            <FeishuPairForm
              key={channel.pairCandidate}
              candidate={channel.pairCandidate}
              botName={channel.botName || t("channels.feishu")}
              agents={available}
              busy={busy}
              online={online}
              onRenew={pair}
              onConfirm={(body) => update.mutate({ path: "/binding", body })}
            />
          ) : (
            <>
              {online && channel.pairCode && (
                <>
                  <p className="text-sm">
                    {t("channels.pairHint", {
                      name: channel.botName || t("channels.feishu"),
                      platform:
                        channel.brand === "lark"
                          ? "Lark"
                          : t("channels.platformFeishu"),
                    })}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded-md bg-muted px-2 py-1 text-sm tabular-nums">
                      /pair {channel.pairCode}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("chat.copy")}
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(`/pair ${channel.pairCode}`)
                          .then(
                            () => toast.success(t("chat.copied")),
                            () => toast.error(t("chat.copyFailed")),
                          )
                      }
                    >
                      <Copy />
                    </Button>
                    {channel.appId && (
                      <Button asChild variant="outline" size="sm">
                        <a
                          href={`https://applink.${domain}/client/bot/open?appId=${encodeURIComponent(channel.appId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t("channels.openBotChat")}
                          <ArrowUpRight data-icon="inline-end" />
                        </a>
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("channels.pairExpiry")}
                  </p>
                </>
              )}
              {channel.pairLocked && (
                <p className="text-sm text-destructive">
                  {t("channels.pairLocked")}
                </p>
              )}
              <div>
                <Button
                  variant={channel.pairCode ? "ghost" : "default"}
                  size="sm"
                  onClick={pair}
                  disabled={!online || busy}
                >
                  {t(
                    channel.pairCode || channel.pairLocked
                      ? "channels.newPairCode"
                      : "channels.generatePair",
                  )}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {bound && (
        <section className="channel-section">
          <h3>{t("channels.lastMessage")}</h3>
          <p className="text-xs text-muted-foreground">
            {channel.lastMessageAt
              ? new Date(channel.lastMessageAt).toLocaleString(i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : t("channels.firstMessage")}
          </p>
        </section>
      )}
      {update.error && !dialog && <ErrorNotice error={update.error} />}
      {test.error && <ErrorNotice error={test.error} />}

      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !update.isPending) setDialog(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                dialog === "agent" ? "channels.changeAgent" : "channels.unbind",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                dialog === "agent"
                  ? "channels.changeAgentHint"
                  : "channels.unbindHint",
              )}
            </DialogDescription>
          </DialogHeader>
          {dialog === "agent" && (
            <AgentSelect
              id="feishu-change-agent"
              agents={available}
              value={target}
              onChange={setTarget}
              disabled={busy}
            />
          )}
          {update.error && <ErrorNotice error={update.error} />}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDialog(undefined)}
            >
              {t("common.cancel")}
            </Button>
            {dialog === "agent" ? (
              <Button
                disabled={busy || !target || target === channel.agentId}
                onClick={() =>
                  update.mutate({
                    path: "/agent",
                    method: "PUT",
                    body: { agentId: target },
                  })
                }
              >
                {t("common.save")}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  update.mutate({ path: "/binding", method: "DELETE" })
                }
              >
                {t("channels.unbind")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
