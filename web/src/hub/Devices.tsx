import { useState } from "react";
import { call } from "mygo-runtime";
import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import {
  Bell,
  Check,
  Copy,
  Laptop,
  LogOut,
  Monitor,
  Moon,
  QrCode,
  RefreshCw,
  Server,
  Smartphone,
  Sun,
  Terminal,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Device, PushSettings } from "@/api/hub.gen";
import type { Theme } from "@/hooks/useTheme";
import { deviceLink } from "./client";
import { deviceStatus, type Workspace } from "./HubApp";
import { HubDeviceIcon, LeverMark, roleLabel } from "./ui";

export function DevicesPanel({
  ws,
  devices,
  ownDevice,
  spaceName,
  initialPairOpen = false,
}: {
  ws: Workspace;
  devices: Device[];
  ownDevice: string;
  spaceName: string;
  initialPairOpen?: boolean;
}) {
  const [pairOpen, setPairOpen] = useState(initialPairOpen);
  const [role, setRole] = useState("controller");
  const [ticket, setTicket] = useState<{ code: string; expires: number }>();
  const [copiedKey, setCopiedKey] = useState("");
  const [editingId, setEditingId] = useState<string>();

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(""), 1800);
    } catch {
      /* ignore clipboard denial */
    }
  };

  const generateTicket = (nextRole: string) => {
    setPairOpen(true);
    void ws.act(async () =>
      setTicket(
        await ws.transport.request(ws.path + "/tickets", "POST", {
          role: nextRole,
        }),
      ),
    );
  };

  const isDirect = ws.transport.kind === "mobile" && !ws.origin;
  const onlineCount = devices.filter((d) => d.online && !d.revoked).length;
  const activeDevices = [...devices].sort((a, b) => {
    if (a.id === ownDevice) return -1;
    if (b.id === ownDevice) return 1;
    if (a.revoked !== b.revoked) return a.revoked ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const link = ticket ? deviceLink(ws.origin, ticket.code) : "";
  const cliCommand = ticket
    ? `lever remote pair --hub ${ws.origin} --code ${ticket.code} --role ${role}`
    : "";

  return (
    <div className="hub-pane-scroll">
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">设备</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {spaceName} · {isDirect ? "局域网直连（免 Hub）· " : ""}
              {onlineCount} / {devices.filter((d) => !d.revoked).length} 台在线
            </p>
          </div>
          {!isDirect && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!pairOpen) {
                  generateTicket(role);
                } else {
                  setPairOpen(false);
                }
              }}
            >
              <QrCode data-icon="inline-start" />
              {pairOpen ? "收起配对码" : "配对新设备"}
            </Button>
          )}
        </div>

        {isDirect && (
          <section className="hub-card-surface px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            当前已通过同 Wi-Fi 局域网直连此电脑（无需部署 Hub）。如需在电脑端调整可访问的 Agent 范围或移除设备，请前往电脑「设置 → 远程与设备」。
          </section>
        )}

        {/* Pair New Device Card */}
        {!isDirect && pairOpen && (
          <section className="hub-card-surface flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-[14px] font-semibold">添加设备到此空间</h2>
              <p className="text-xs text-muted-foreground">
                选择新设备的角色并生成一次性配对码（10 分钟内有效）。
              </p>
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              className="w-full"
              value={role}
              onValueChange={(v) => {
                if (v) {
                  setRole(v);
                  setTicket(undefined);
                  generateTicket(v);
                }
              }}
            >
              <ToggleGroupItem value="controller" className="flex-1">
                <Smartphone data-icon="inline-start" />
                手机控制端
              </ToggleGroupItem>
              <ToggleGroupItem value="workstation" className="flex-1">
                <Laptop data-icon="inline-start" />
                电脑工作机
              </ToggleGroupItem>
              <ToggleGroupItem value="executor" className="flex-1">
                <Server data-icon="inline-start" />
                服务器执行机
              </ToggleGroupItem>
            </ToggleGroup>

            {ticket ? (
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                {role !== "executor" && (
                  <div className="shrink-0 rounded-xl border border-border bg-white p-3">
                    <QRCodeSVG value={link} size={148} marginSize={1} />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg font-semibold tracking-wider tabular-nums">
                      {ticket.code}
                    </span>
                    <Badge variant="outline" className="tabular-nums">
                      {new Date(ticket.expires * 1000).toLocaleTimeString()} 失效
                    </Badge>
                  </div>
                  {role === "executor" ? (
                    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/60 p-2.5 font-mono text-xs leading-relaxed">
                      {cliCommand}
                    </pre>
                  ) : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {role === "controller"
                        ? "在另一台手机的 Lever 中扫码或粘贴配对链接即可加入。"
                        : "在电脑 Lever「设置 → 远程与设备」直接粘贴配对链接。"}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        void copy(
                          role === "executor" ? cliCommand : link,
                          "ticket",
                        )
                      }
                    >
                      {copiedKey === "ticket" ? (
                        <Check data-icon="inline-start" />
                      ) : role === "executor" ? (
                        <Terminal data-icon="inline-start" />
                      ) : (
                        <Copy data-icon="inline-start" />
                      )}
                      {copiedKey === "ticket"
                        ? "已复制"
                        : role === "executor"
                          ? "复制 CLI 命令"
                          : "复制配对链接"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => generateTicket(role)}
                    >
                      <RefreshCw data-icon="inline-start" />
                      刷新
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>正在生成一次性配对码…</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => generateTicket(role)}
                >
                  生成配对码
                </Button>
              </div>
            )}
          </section>
        )}

        {/* Current Device ID Card */}
        {ownDevice && (
          <section className="hub-card-surface flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">本机设备 ID</div>
              <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                {ownDevice}
              </code>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copy(ownDevice, "own")}
            >
              {copiedKey === "own" ? (
                <Check data-icon="inline-start" />
              ) : (
                <Copy data-icon="inline-start" />
              )}
              {copiedKey === "own" ? "已复制" : "复制 ID"}
            </Button>
          </section>
        )}

        {/* Paired Devices List */}
        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            已配对设备 ({activeDevices.length})
          </h2>
          {activeDevices.length === 0 ? (
            <div className="hub-card-surface px-4 py-8 text-center text-xs text-muted-foreground">
              暂无已配对设备，点击上方「配对新设备」添加第一台电脑或手机。
            </div>
          ) : (
            <div className="hub-card-surface divide-y divide-border overflow-hidden">
              {activeDevices.map((d) => {
                const isSelf = d.id === ownDevice;
                const isEditing = editingId === d.id;
                return (
                  <div key={d.id} className="flex flex-col gap-3 px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/60 text-muted-foreground">
                          <HubDeviceIcon
                            platform={d.platform}
                            role={d.role}
                            className="size-4"
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-[14px] font-medium">
                              {d.name}
                            </span>
                            {isSelf && <Badge variant="secondary">本机</Badge>}
                            <Badge
                              variant={
                                d.revoked
                                  ? "destructive"
                                  : d.online && !d.draining
                                    ? "secondary"
                                    : "outline"
                              }
                            >
                              {d.online && !d.revoked && !d.draining && (
                                <span className="size-1.5 rounded-full bg-emerald-500" />
                              )}
                              {deviceStatus(d)}
                            </Badge>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {roleLabel(d.role)} · {d.platform || "unknown"} ·
                            同步版本 {d.version}
                          </div>
                        </div>
                      </div>

                      {!d.revoked && !isDirect && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setEditingId(isEditing ? undefined : d.id)
                          }
                        >
                          {isEditing ? "收起" : "管理"}
                        </Button>
                      )}
                    </div>

                    {isEditing && !d.revoked && (
                      <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3">
                        <form
                          className="flex items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const name = new FormData(e.currentTarget).get(
                              "name",
                            );
                            void ws.act(async () => {
                              await ws.transport.request(
                                ws.path + "/devices/" + d.id,
                                "PATCH",
                                { name },
                              );
                              setEditingId(undefined);
                            });
                          }}
                        >
                          <Input
                            key={d.name}
                            aria-label="设备名称"
                            name="name"
                            defaultValue={d.name}
                            className="flex-1 bg-background"
                          />
                          <Button type="submit" size="sm" variant="outline">
                            改名
                          </Button>
                        </form>

                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {d.role !== "controller" ? (
                            <label className="flex cursor-pointer items-center gap-2 text-xs">
                              <Switch
                                checked={d.draining}
                                onCheckedChange={(draining) =>
                                  void ws.act(async () => {
                                    await ws.transport.request(
                                      ws.path + "/devices/" + d.id,
                                      "PATCH",
                                      { draining },
                                    );
                                  })
                                }
                              />
                              <span>暂停接单</span>
                            </label>
                          ) : (
                            <span />
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              if (confirm(`撤销「${d.name}」的访问权限？`))
                                void ws.act(async () => {
                                  await ws.transport.request(
                                    ws.path + "/devices/" + d.id,
                                    "DELETE",
                                  );
                                  setEditingId(undefined);
                                });
                            }}
                          >
                            <Trash2 data-icon="inline-start" />
                            撤销设备
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function ProfilePanel({
  ws,
  logout,
  browser,
  ownDevice,
  spaceName,
  theme,
  onThemeChange,
}: {
  ws: Workspace;
  logout: () => void;
  browser: boolean;
  ownDevice: string;
  spaceName: string;
  theme: Theme;
  onThemeChange: (next: Theme) => void;
}) {
  const sessions = useQuery({
    queryKey: [ws.key, "sessions"],
    enabled: browser,
    queryFn: () =>
      ws.transport.request<
        { id: string; agent: string; current: boolean; expires: number }[]
      >("/api/sessions"),
  });
  const push = useQuery({
    queryKey: [ws.key, "push"],
    enabled: ws.transport.kind === "mobile",
    queryFn: () => ws.transport.request<PushSettings>(ws.path + "/push"),
  });

  return (
    <div className="hub-pane-scroll">
      <div className="mx-auto flex w-full max-w-[780px] flex-col gap-5">
        {/* Identity Header Card */}
        <section className="hub-card-surface flex items-center gap-3.5 p-4">
          <LeverMark size={52} />
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-semibold tracking-tight">Lever</h1>
            <p className="truncate text-xs text-muted-foreground">
              {spaceName} · {ws.origin || "局域网直连（免 Hub）"}
            </p>
            {ownDevice && (
              <code className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {ownDevice.slice(0, 12)}…
              </code>
            )}
          </div>
        </section>

        {/* Preferences & Push */}
        <section className="flex flex-col gap-2">
          <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
            偏好与通知
          </h2>
          <div className="hub-card-surface divide-y divide-border overflow-hidden">
            {ws.transport.kind === "mobile" && (
              <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Bell className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium">锁屏通知</div>
                    <p className="text-xs text-muted-foreground">
                      {!ws.origin && ws.transport.kind === "mobile"
                        ? "局域网直连模式不支持锁屏推送，接入 Lever Hub 后可开启"
                        : push.data && !push.data.available
                          ? "请在 Hub 配置此平台的推送服务"
                          : "待审批、运行失败与完成时及时推送"}
                    </p>
                    {push.error && (
                      <p role="alert" className="text-xs text-destructive">
                        {String(push.error)}
                      </p>
                    )}
                  </div>
                </div>
                <Switch
                  aria-label="锁屏通知"
                  checked={push.data?.enabled ?? false}
                  disabled={
                    !push.data || (!push.data.available && !push.data.enabled)
                  }
                  onCheckedChange={(enabled) =>
                    void ws.act(async () => {
                      await call("Mobile.SetPush", enabled);
                      await push.refetch();
                    })
                  }
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div>
                <div className="text-[14px] font-medium">外观主题</div>
                <p className="text-xs text-muted-foreground">
                  切换浅色或深色界面
                </p>
              </div>
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                value={theme}
                aria-label="外观主题"
                onValueChange={(v) => {
                  if (v === "system" || v === "light" || v === "dark") {
                    onThemeChange(v);
                  }
                }}
              >
                <ToggleGroupItem value="system">
                  <Monitor data-icon="inline-start" />
                  系统
                </ToggleGroupItem>
                <ToggleGroupItem value="light">
                  <Sun data-icon="inline-start" />
                  浅色
                </ToggleGroupItem>
                <ToggleGroupItem value="dark">
                  <Moon data-icon="inline-start" />
                  深色
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
        </section>

        {/* Browser Sessions */}
        {browser && (sessions.data?.length ?? 0) > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
              登录会话
            </h2>
            <div className="hub-card-surface divide-y divide-border overflow-hidden">
              {sessions.data!.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">
                      {s.current ? "当前浏览器" : s.agent}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      到期：{new Date(s.expires * 1000).toLocaleDateString()}
                    </div>
                  </div>
                  {!s.current && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void ws.act(async () => {
                          await ws.transport.request(
                            "/api/sessions/" + s.id,
                            "DELETE",
                          );
                        })
                      }
                    >
                      撤销会话
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Logout / Unpair */}
        {ws.transport.kind !== "host" && (
          <Button
            type="button"
            variant="outline"
            className="w-full justify-center text-destructive hover:text-destructive"
            onClick={logout}
          >
            <LogOut data-icon="inline-start" />
            {browser ? "退出登录" : "解除手机配对"}
          </Button>
        )}
      </div>
    </div>
  );
}
