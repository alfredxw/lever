import { lazy, Suspense, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Agent, Chat, SharedScope } from "@/api/types.gen";
import type { InboxItem, Role } from "@/api/hub.gen";
import type { Transport } from "@/hub/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SettingsGroup, SettingsRow } from "./SettingsControls";

const Workspace = lazy(() =>
  import("@/hub/HubApp").then((v) => ({ default: v.HubApp })),
);
export interface Binding extends SharedScope {
  login: boolean;
  loginSupported: boolean;
  lan: boolean;
  lanError?: string;
  origin: string;
  deviceId: string;
  role: Role;
  online: boolean;
  error?: string;
  agents: string[];
  acked: number;
  version: number;
}
export function useRemoteBindings() {
  return useQuery({
    queryKey: ["remote", "bindings"],
    queryFn: () => api<Binding[]>("/remote", { action: "status" }),
    refetchInterval: 8000,
  });
}
export function RemoteDevices({
  agents,
  chats,
}: {
  agents: Agent[];
  chats: Chat[];
}) {
  const bindings = useRemoteBindings();
  const qc = useQueryClient();
  const [role, setRole] = useState("workstation");
  const [link, setLink] = useState("");
  const [origin, setOrigin] = useState("");
  const [opened, setOpened] = useState<Binding>();
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: (input: unknown) => api("/remote", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["remote"] });
    },
  });
  const control = useMemo<Transport>(
    () => ({
      kind: "host",
      request: <T,>(path: string, method = "GET", body?: unknown) =>
        api<T>("/remote", {
          action: "control",
          scope: opened && { hubId: opened.hubId, spaceId: opened.spaceId },
          method,
          path,
          body,
        }),
    }),
    [opened],
  );
  return (
    <>
      <SettingsGroup title="配对 Hub">
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError("");
            let hub = origin,
              code = link.trim();
            if (code.includes("://")) {
              try {
                const u = new URL(code);
                if (u.protocol !== "leverdevice:" || u.hostname !== "pair")
                  throw Error();
                hub = u.searchParams.get("hub") ?? "";
                code = u.searchParams.get("code") ?? "";
              } catch {
                setError("请输入有效的配对链接");
                return;
              }
            }
            mutation.mutate(
              { action: "pair", pair: { hub, code, role } },
              {
                onSuccess: () => {
                  setLink("");
                  setOrigin("");
                },
              },
            );
          }}
        >
          <Input
            aria-label="配对链接或短码"
            placeholder="配对链接或短码"
            autoComplete="off"
            required
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
          {!link.includes("://") && (
            <Input
              aria-label="Hub 地址"
              placeholder="https://hub.example.com"
              type="url"
              required
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            />
          )}
          <ToggleGroup
            type="single"
            value={role}
            onValueChange={(v) => {
              if (v) setRole(v);
            }}
          >
            {[
              ["workstation", "工作机"],
              ["executor", "仅执行"],
              ["controller", "仅控制"],
            ].map(([v, n]) => (
              <ToggleGroupItem value={v} key={v}>
                {n}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button className="w-fit" disabled={mutation.isPending}>
            配对
          </Button>
        </form>
      </SettingsGroup>
      {(error || mutation.error || bindings.error) && (
        <p role="alert">{error || String(mutation.error ?? bindings.error)}</p>
      )}
      {bindings.data?.map((b) => (
        <BindingPanel
          key={b.hubId + b.spaceId}
          b={b}
          agents={agents}
          chats={chats}
          mutate={(input) => mutation.mutate(input)}
          open={() => setOpened(b)}
        />
      ))}
      <Dialog
        open={!!opened}
        onOpenChange={(open) => {
          if (!open) setOpened(undefined);
        }}
      >
        <DialogContent className="h-[92dvh] w-[96vw] max-w-none overflow-hidden p-0 sm:max-w-[96vw]">
          <DialogTitle className="sr-only">共享空间</DialogTitle>
          {opened && (
            <Suspense fallback={<p>正在连接…</p>}>
              <Workspace transport={control} origin={opened.origin} />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
function BindingPanel({
  b,
  agents,
  chats,
  mutate,
  open,
}: {
  b: Binding;
  agents: Agent[];
  chats: Chat[];
  mutate: (i: unknown) => void;
  open: () => void;
}) {
  const scope = { hubId: b.hubId, spaceId: b.spaceId };
  const [controller, setController] = useState("");
  const [chat, setChat] = useState("");
  const trusted = useQuery({
    queryKey: ["remote", "trusted", b.hubId, b.spaceId],
    enabled: b.role !== "controller",
    queryFn: () =>
      api<
        {
          id: string;
          name: string;
          permissions: { agentId: string; action: string }[];
        }[]
      >("/remote", { action: "trusted", scope }),
  });
  const selected = trusted.data?.find((d) => d.id === controller);
  const grants = useQuery({
    queryKey: ["remote", "private-grants", b.hubId, b.spaceId],
    enabled: b.lan,
    queryFn: () =>
      api<{ chatId: string; controllerId: string; title: string }[]>(
        "/remote",
        { action: "private_grants", scope },
      ),
  });
  const devices = useQuery({
    queryKey: ["remote", "controllers", b.hubId, b.spaceId],
    enabled: b.online && b.role === "workstation",
    queryFn: () =>
      api<{ id: string; name: string; role: Role; revoked: boolean }[]>(
        "/remote",
        { action: "devices", scope },
      ),
  });
  const inbox = useQuery({
    queryKey: ["remote", "inbox", b.hubId, b.spaceId],
    enabled: b.role !== "controller",
    queryFn: () => api<InboxItem[]>("/remote", { action: "inbox", scope }),
    refetchInterval: 4000,
  });
  return (
    <SettingsGroup title={b.origin}>
      <SettingsRow
        title={b.online ? "在线" : "离线"}
        description={b.error || `同步进度 ${b.acked} / ${b.version}`}
      >
        {b.role !== "executor" && (
          <Button variant="outline" onClick={open}>
            打开共享空间
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            if (confirm("解除与此空间的配对？"))
              mutate({ action: "unpair", scope });
          }}
        >
          解除配对
        </Button>
      </SettingsRow>
      {b.loginSupported && (
        <SettingsRow title="登录时启动 Host">
          <Switch
            aria-label="登录时启动 Host"
            checked={b.login}
            onCheckedChange={(enabled) =>
              mutate({ action: "login", scope, enabled })
            }
          />
        </SettingsRow>
      )}
      {b.role !== "controller" && (
        <SettingsRow
          title="局域网直连"
          description={
            b.lanError || "允许同空间的配对控制端在局域网读取会话和提交操作。"
          }
        >
          <Switch
            aria-label="局域网直连"
            checked={b.lan}
            onCheckedChange={(enabled) =>
              mutate({ action: "lan", scope, enabled })
            }
          />
        </SettingsRow>
      )}
      {b.role !== "controller" &&
        agents
          .filter((a) => !a.archived)
          .map((a) => (
            <SettingsRow key={a.id} title={a.name} description="向此空间开放">
              <Switch
                aria-label={"开放 " + a.name}
                checked={b.agents.includes(a.id)}
                onCheckedChange={(v) =>
                  mutate({
                    action: v ? "expose" : "hide",
                    scope,
                    agentId: a.id,
                  })
                }
              />
            </SettingsRow>
          ))}
      {b.role !== "controller" && (
        <>
          <SettingsRow
            title="个人控制端"
            description="开启信任后，这台设备在 Hub 离线时也能直连。按 Agent 选择可以直接执行的操作。"
          >
            {devices.data ? (
              <select
                aria-label="控制端"
                value={controller}
                onChange={(e) => setController(e.target.value)}
              >
                <option value="">选择已配对设备</option>
                {devices.data
                  .filter(
                    (d) =>
                      d.id !== b.deviceId &&
                      d.role !== "executor" &&
                      (!d.revoked || trusted.data?.some((t) => t.id === d.id)),
                  )
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            ) : (
              <Input
                list={"controllers-" + b.spaceId}
                aria-label="控制端设备 ID"
                placeholder="控制端设备 ID"
                value={controller}
                onChange={(e) => setController(e.target.value)}
              />
            )}
            <datalist id={"controllers-" + b.spaceId}>
              {trusted.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </datalist>
            <Switch
              aria-label="信任此控制端"
              checked={!!selected}
              disabled={!controller || (!b.online && !selected)}
              onCheckedChange={(v) =>
                mutate({
                  action: v ? "trust" : "untrust",
                  scope,
                  controllerId: controller,
                })
              }
            />
          </SettingsRow>
          {selected &&
            agents
              .filter((a) => !a.archived && b.agents.includes(a.id))
              .map((a) => {
                const actions = selected.permissions
                  .filter((p) => p.agentId === a.id)
                  .map((p) => p.action);
                return (
                  <SettingsRow
                    key={a.id}
                    title={a.name}
                    description={selected.name + " 可直接执行"}
                  >
                    <ToggleGroup
                      type="multiple"
                      value={actions}
                      aria-label={a.name + " 的控制权限"}
                      onValueChange={(next) => {
                        const operation = [...actions, ...next].find(
                          (v) => actions.includes(v) !== next.includes(v),
                        );
                        if (operation)
                          mutate({
                            action: "permission",
                            scope,
                            controllerId: controller,
                            agentId: a.id,
                            operation,
                            enabled: next.includes(operation),
                          });
                      }}
                    >
                      {[
                        ["send", "发消息"],
                        ["answer", "回答与审批"],
                        ["stop", "停止"],
                        ["dispatch_task", "接收派发"],
                      ].map(([v, title]) => (
                        <ToggleGroupItem key={v} value={v}>
                          {title}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </SettingsRow>
                );
              })}
        </>
      )}
      {b.lan && b.role !== "controller" && (
        <>
          <SettingsRow
            title="授权仅设备对话"
            description="标题和内容仅在直连时提供给所选控制端。"
          >
            <select
              aria-label="仅设备对话"
              value={chat}
              onChange={(e) => setChat(e.target.value)}
            >
              <option value="">选择对话</option>
              {chats
                .filter((c) => !c.sharedScope)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
            </select>
            <Button
              disabled={!chat || !controller}
              onClick={() =>
                mutate({
                  action: "grant_private",
                  scope,
                  id: chat,
                  controllerId: controller,
                })
              }
            >
              授权
            </Button>
          </SettingsRow>
          {grants.data?.map((g) => (
            <SettingsRow
              key={g.controllerId + g.chatId}
              title={g.title}
              description={
                devices.data?.find((d) => d.id === g.controllerId)?.name ??
                g.controllerId
              }
            >
              <Button
                variant="ghost"
                onClick={() =>
                  mutate({
                    action: "revoke_private",
                    scope,
                    id: g.chatId,
                    controllerId: g.controllerId,
                  })
                }
              >
                收回授权
              </Button>
            </SettingsRow>
          ))}
        </>
      )}
      {inbox.data?.map((item) => (
        <SettingsRow
          key={item.intent.id}
          title={item.intent.kind + " · " + item.intent.actorUserId}
          description={
            item.intent.text ||
            JSON.stringify({
              chatId: item.intent.chatId,
              runId: item.intent.runId,
              requestId: item.intent.requestId,
              answer: item.intent.answer,
            })
          }
        >
          <Button
            onClick={() =>
              mutate({ action: "accept", scope, id: item.intent.id })
            }
          >
            确认执行
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              mutate({ action: "decline", scope, id: item.intent.id })
            }
          >
            拒绝
          </Button>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
