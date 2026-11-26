import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Laptop,
  Link2,
  Plus,
  QrCode,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Terminal,
  Trash2,
  Unlink,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { Agent, Chat, SharedScope } from "@/api/types.gen";
import type { Device, InboxItem, Role } from "@/api/hub.gen";
import { deviceLink, type Transport } from "@/hub/client";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SettingsGroup, SettingsRow } from "./SettingsControls";

const Workspace = lazy(() =>
  import("@/hub/HubApp").then((v) => ({ default: v.HubApp })),
);

export interface Binding extends SharedScope {
  login: boolean;
  loginSupported: boolean;
  lan: boolean;
  lanAddr?: string;
  lanError?: string;
  direct?: boolean;
  origin: string;
  deviceId: string;
  role: Role;
  online: boolean;
  error?: string;
  exposeAll: boolean;
  agents: string[];
  acked: number;
  version: number;
}

interface LocalInfo {
  deviceId: string;
  hostName: string;
  platform: string;
  login: boolean;
  loginSupported: boolean;
  lanAddr?: string;
  lanError?: string;
}

interface LANTicketResult {
  code: string;
  expires: number;
  hostId: string;
  hostName: string;
  lan: string;
  link: string;
  scope: SharedScope;
}

interface TrustedController {
  id: string;
  name: string;
  permissions: { agentId: string; action: string }[];
}

interface PrivateGrant {
  chatId: string;
  controllerId: string;
  title: string;
}

interface EditableDevice {
  id: string;
  name: string;
  role: Role;
  platform: string;
  online: boolean;
  draining: boolean;
  revoked: boolean;
  isDirect: boolean;
  scope: SharedScope;
  spaceId: string;
  canControl: boolean;
  canExecute: boolean;
  hostOnline: boolean;
  lanEnabled: boolean;
  exposedAgents: Agent[];
}

const OPERATIONS = [
  ["send", "发消息"],
  ["answer", "回答与审批"],
  ["stop", "停止"],
  ["dispatch_task", "接收派发"],
] as const;

const ROLE_LABELS: Record<string, string> = {
  workstation: "工作机",
  executor: "仅执行",
  controller: "仅控制",
};

function parsePairingInput(raw: string, fallbackOrigin: string) {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false as const, error: "请输入配对链接或短码" };
  if (trimmed.includes("://")) {
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "leverdevice:" || u.hostname !== "pair")
        throw new Error();
      const hub = (u.searchParams.get("hub") ?? "").trim();
      const code = (u.searchParams.get("code") ?? "").trim();
      if (!hub || !code) throw new Error();
      return { ok: true as const, hub, code, parsedLink: true };
    } catch {
      return {
        ok: false as const,
        error: "配对链接格式无效，请粘贴 leverdevice://pair?hub=...&code=...",
      };
    }
  }
  const hub = fallbackOrigin.trim();
  if (!hub)
    return {
      ok: false as const,
      error: "使用短码配对时请填写 Hub 地址（或直接粘贴完整配对链接）",
    };
  return { ok: true as const, hub, code: trimmed, parsedLink: false };
}

function DeviceIcon({ platform, role }: { platform?: string; role?: string }) {
  const p = (platform ?? "").toLowerCase();
  if (p === "ios" || p === "android" || role === "controller") {
    return <Smartphone className="size-4 text-muted-foreground" />;
  }
  if (p === "linux" && role === "executor") {
    return <Server className="size-4 text-muted-foreground" />;
  }
  return <Laptop className="size-4 text-muted-foreground" />;
}

function summarizeControllerScope(
  entry: TrustedController | undefined,
  exposedAgentIds: Set<string>,
) {
  if (!entry) return { label: "需本机确认", variant: "outline" as const };
  const perms = entry.permissions ?? [];
  const wildcardOps = perms.filter((p) => p.agentId === "*");
  if (wildcardOps.length > 0) {
    return {
      label: `全部开放 Agent（含新增）· ${wildcardOps.length} 项权限`,
      variant: "secondary" as const,
    };
  }
  const scopedAgents = new Set(
    perms
      .filter((p) => p.agentId !== "*" && exposedAgentIds.has(p.agentId))
      .map((p) => p.agentId),
  );
  if (scopedAgents.size > 0) {
    return {
      label: `仅限 ${scopedAgents.size} 个 Agent`,
      variant: "secondary" as const,
    };
  }
  return { label: "仅局域网直连", variant: "outline" as const };
}

export function useRemoteBindings() {
  return useQuery({
    queryKey: ["remote", "bindings"],
    queryFn: () => api<Binding[]>("/remote", { action: "status" }),
    refetchInterval: 8000,
  });
}

export function RemoteDevices({
  title = "远程与设备",
  titleId = "settings-section-remoteDevices",
  agents,
  chats,
}: {
  title?: string;
  titleId?: string;
  agents: Agent[];
  chats: Chat[];
}) {
  const bindings = useRemoteBindings();
  const localInfo = useQuery({
    queryKey: ["remote", "local-info"],
    queryFn: () => api<LocalInfo>("/remote", { action: "local_info" }),
    refetchInterval: 10000,
  });
  const qc = useQueryClient();
  const [opened, setOpened] = useState<Binding>();
  const [addingHub, setAddingHub] = useState(false);
  const [pairModalOpen, setPairModalOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<EditableDevice>();

  const list = bindings.data ?? [];
  const directBinding = useMemo(
    () => list.find((b) => b.direct || !b.origin),
    [list],
  );
  const hubBindings = useMemo(
    () => list.filter((b) => !b.direct && !!b.origin),
    [list],
  );
  const primaryHubBinding = useMemo(
    () =>
      hubBindings.find((b) => b.role !== "executor" && b.online) ??
      hubBindings.find((b) => b.role !== "executor") ??
      hubBindings[0],
    [hubBindings],
  );

  // Primary local execution scope used for the standalone "Agent Scope" & "LAN Direct" sections when no Hub is connected.
  const activeAgents = useMemo(
    () => agents.filter((a) => !a.archived),
    [agents],
  );
  const directScope = useMemo(
    () =>
      directBinding
        ? { hubId: directBinding.hubId, spaceId: directBinding.spaceId }
        : undefined,
    [directBinding],
  );

  const directTrusted = useQuery({
    queryKey: ["remote", "trusted", directScope?.hubId, directScope?.spaceId],
    enabled: !!directScope,
    queryFn: () =>
      api<TrustedController[]>("/remote", {
        action: "trusted",
        scope: directScope,
      }),
    refetchInterval: pairModalOpen ? 2500 : 10000,
  });

  const directInbox = useQuery({
    queryKey: ["remote", "inbox", directScope?.hubId, directScope?.spaceId],
    enabled: !!directScope,
    queryFn: () =>
      api<InboxItem[]>("/remote", { action: "inbox", scope: directScope }),
    refetchInterval: 4000,
  });

  const mutation = useMutation({
    mutationFn: (input: unknown) => api("/remote", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["remote"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  const pairHub = async (pair: { hub: string; code: string; role: string }) => {
    const scope = await api<SharedScope>("/remote", { action: "pair", pair });
    if (pair.role !== "controller") {
      // Carry over current local expose_all preference (defaults to all agents incl. future).
      const exposeAll = directBinding ? directBinding.exposeAll : true;
      try {
        if (exposeAll) {
          await api("/remote", { action: "expose_all", scope, enabled: true });
        } else if (directBinding) {
          for (const agentId of directBinding.agents) {
            await api("/remote", { action: "expose", scope, agentId });
          }
        }
      } catch {
        /* Pairing already succeeded. */
      }
    }
    await qc.invalidateQueries({ queryKey: ["remote"] });
  };

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

  const directExposedAgents = useMemo(() => {
    if (!directBinding || directBinding.exposeAll) return activeAgents;
    return activeAgents.filter((a) => directBinding.agents.includes(a.id));
  }, [activeAgents, directBinding]);
  const directExposedIds = useMemo(
    () => new Set(directExposedAgents.map((a) => a.id)),
    [directExposedAgents],
  );

  const loginSupported =
    localInfo.data?.loginSupported ?? list[0]?.loginSupported ?? false;
  const loginEnabled = localInfo.data?.login ?? list[0]?.login ?? false;
  const hostName = localInfo.data?.hostName || "本机电脑";
  const hostPlatform = localInfo.data?.platform || "darwin";
  const directLANEnabled = directBinding?.lan ?? false;
  const directLANAddr = directBinding?.lanAddr || localInfo.data?.lanAddr;
  const directLANError = directBinding?.lanError || localInfo.data?.lanError;

  const copyText = async (text: string, msg: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(msg);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header with Always-Visible Primary CTA (Works WITHOUT a Hub!) */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="text-[length:var(--page-title-size)] leading-[1.4] font-semibold tracking-[-0.025em]"
          >
            {title}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            支持免 Hub 局域网扫码直连手机，也可按需接入自托管 Lever Hub 实现公网远程访问与锁屏推送。
          </p>
        </div>
        <Button onClick={() => setPairModalOpen(true)}>
          <QrCode data-icon="inline-start" />
          配对新设备
        </Button>
      </div>

      {bindings.error && (
        <p role="alert" className="text-xs text-destructive">
          {String(bindings.error)}
        </p>
      )}

      {/* 1. Lever Hub 连接（默认展开，清晰标注为可选） */}
      {hubBindings.length === 0 ? (
        <SettingsGroup title="Lever Hub 连接">
          <div className="flex flex-col gap-3.5 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
                <Globe className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
                  <span>连接自托管 Lever Hub</span>
                  <Badge variant="outline">可选 · 当前仅局域网可用</Badge>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  不连接 Hub 也可直接点击右上角「配对新设备」在同 Wi-Fi 下扫码连接手机；连接 Hub 后可支持公网跨网访问、多机共享任务与系统锁屏推送。
                </p>
              </div>
            </div>
            <PairHubForm
              inline
              submitLabel="连接 Hub"
              onPair={async (pair) => {
                await pairHub(pair);
                toast.success("已连接到 Lever Hub");
              }}
            />
          </div>
        </SettingsGroup>
      ) : (
        hubBindings.map((b) => (
          <HubBindingPanel
            key={b.hubId + ":" + b.spaceId}
            b={b}
            agents={agents}
            chats={chats}
            isPending={mutation.isPending}
            mutate={(input, onSuccess) =>
              mutation.mutate(input, onSuccess ? { onSuccess } : undefined)
            }
            openWorkspace={() => setOpened(b)}
            onOpenPair={() => setPairModalOpen(true)}
            onEditDevice={(dev) => setEditingDevice(dev)}
          />
        ))
      )}

      {/* 2. 局域网直连设备与本机配置（免 Hub 即完整可用；接入 Hub 后若有局域网直连设备同样展示） */}
      {(hubBindings.length === 0 || (directTrusted.data?.length ?? 0) > 0) && (
        <SettingsGroup
          title={
            hubBindings.length === 0 ? "已连接设备" : "局域网免 Hub 直连设备"
          }
        >
          {hubBindings.length === 0 && (
            <SettingsRow
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60">
                    <DeviceIcon platform={hostPlatform} role="workstation" />
                  </span>
                  <span className="font-medium">{hostName}</span>
                  <Badge variant="secondary">本机</Badge>
                  {directLANEnabled && directLANAddr ? (
                    <Badge variant="secondary">
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                      局域网就绪
                    </Badge>
                  ) : (
                    <Badge variant="outline">局域网未开启</Badge>
                  )}
                </span>
              }
              description={
                directLANEnabled && directLANAddr
                  ? `局域网地址 ${directLANAddr} · 共 ${activeAgents.length} 个本机 Agent`
                  : `共 ${activeAgents.length} 个本机 Agent · 点击右侧「配对新设备」立即生成局域网扫码二维码`
              }
            >
              <div className="flex items-center gap-2">
                {localInfo.data?.deviceId && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="复制设备 ID"
                    title="复制设备 ID"
                    onClick={() =>
                      void copyText(localInfo.data!.deviceId, "已复制设备 ID")
                    }
                  >
                    <Copy />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPairModalOpen(true)}
                >
                  <QrCode data-icon="inline-start" />
                  配对新设备
                </Button>
              </div>
            </SettingsRow>
          )}

          {(directTrusted.data ?? []).map((t) => {
            const summary = summarizeControllerScope(t, directExposedIds);
            return (
              <SettingsRow
                key={t.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60">
                      <Smartphone className="size-4 text-muted-foreground" />
                    </span>
                    <span className="font-medium">{t.name}</span>
                    <Badge variant="secondary">
                      <Wifi className="size-3" />
                      局域网直连
                    </Badge>
                    <Badge variant={summary.variant}>{summary.label}</Badge>
                  </span>
                }
                description="控制端 · 免 Hub 同 Wi-Fi 直连本机"
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    directScope &&
                    setEditingDevice({
                      id: t.id,
                      name: t.name,
                      role: "controller",
                      platform: "mobile",
                      online: true,
                      draining: false,
                      revoked: false,
                      isDirect: true,
                      scope: directScope,
                      spaceId: directScope.spaceId,
                      canControl: false,
                      canExecute: true,
                      hostOnline: true,
                      lanEnabled: directLANEnabled,
                      exposedAgents: directExposedAgents,
                    })
                  }
                >
                  <SlidersHorizontal data-icon="inline-start" />
                  权限与范围
                </Button>
              </SettingsRow>
            );
          })}
        </SettingsGroup>
      )}

      {/* 3. 本机 Agent 开放范围 & 连接与后台（无 Hub 时同样实时生效！） */}
      {hubBindings.length === 0 && (
        <>
          <SettingsGroup title="本机 Agent 开放范围">
            <SettingsRow
              title="默认开放策略"
              description={
                (directBinding ? directBinding.exposeAll : true)
                  ? "当前及今后新建的所有未归档 Agent 均自动向已配对设备开放，无需每次新建后重新配置。"
                  : "仅下方手动开启开关的 Agent 对已配对设备可见。"
              }
            >
              <ToggleGroup
                type="single"
                variant="outline"
                spacing={0}
                aria-label="Agent 开放策略"
                value={
                  (directBinding ? directBinding.exposeAll : true)
                    ? "all"
                    : "selected"
                }
                onValueChange={(value) => {
                  if (!value) return;
                  const enabled = value === "all";
                  mutation.mutate({
                    action: "expose_all",
                    scope: directScope ?? { hubId: "", spaceId: "" },
                    enabled,
                  });
                }}
              >
                <ToggleGroupItem value="all">
                  全部 Agent（含新增）
                </ToggleGroupItem>
                <ToggleGroupItem value="selected">仅选定 Agent</ToggleGroupItem>
              </ToggleGroup>
            </SettingsRow>

            {(directBinding ? directBinding.exposeAll : true) ? (
              <div className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {activeAgents.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      当前暂无活跃 Agent，新建后将自动同步开放。
                    </span>
                  ) : (
                    activeAgents.map((a) => (
                      <span
                        key={a.id}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        <AgentAvatar agent={a} size="xs" />
                        <span className="max-w-36 truncate">{a.name}</span>
                      </span>
                    ))
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  共 {activeAgents.length} 个未归档 Agent 已自动开放。
                </p>
              </div>
            ) : activeAgents.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">
                暂无可开放的 Agent。
              </div>
            ) : (
              activeAgents.map((a) => (
                <SettingsRow
                  key={a.id}
                  title={
                    <span className="flex min-w-0 items-center gap-2.5">
                      <AgentAvatar agent={a} size="sm" />
                      <span className="truncate">{a.name}</span>
                    </span>
                  }
                  description={a.profile.provider || "向已配对设备开放"}
                >
                  <Switch
                    aria-label={"开放 " + a.name}
                    checked={directBinding?.agents.includes(a.id) ?? false}
                    onCheckedChange={(v) =>
                      mutation.mutate({
                        action: v ? "expose" : "hide",
                        scope: directScope ?? { hubId: "", spaceId: "" },
                        agentId: a.id,
                      })
                    }
                  />
                </SettingsRow>
              ))
            )}
          </SettingsGroup>

          <SettingsGroup title="连接与后台">
            <SettingsRow
              title="局域网直连"
              description={
                directLANError ||
                (directLANEnabled && directLANAddr
                  ? `已启用局域网直连服务（${directLANAddr}），同 Wi-Fi 下手机可直接扫码连接。`
                  : "无需部署 Hub：开启后本机在局域网广播加密直连服务，手机扫码即可直接对话。")
              }
            >
              <Switch
                aria-label="局域网直连"
                checked={directLANEnabled}
                onCheckedChange={(enabled) =>
                  mutation.mutate({
                    action: "lan",
                    scope: directScope ?? { hubId: "", spaceId: "" },
                    enabled,
                  })
                }
              />
            </SettingsRow>
            {loginSupported && (
              <SettingsRow
                title="登录时后台保持在线"
                description="开机登录后自动启动本地 Host，便于手机随时直连。"
              >
                <Switch
                  aria-label="登录时后台保持在线"
                  checked={loginEnabled}
                  onCheckedChange={(enabled) =>
                    mutation.mutate({ action: "login", enabled })
                  }
                />
              </SettingsRow>
            )}
          </SettingsGroup>
        </>
      )}

      {/* Direct LAN Pending Inbox (if any manual confirmation needed) */}
      {directScope && (directInbox.data?.length ?? 0) > 0 && (
        <SettingsGroup title="待确认局域网指令">
          {directInbox.data!.map((item) => (
            <SettingsRow
              key={item.intent.id}
              title={
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{item.intent.kind}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {directTrusted.data?.find(
                      (d) => d.id === item.intent.originDeviceId,
                    )?.name ?? item.intent.originDeviceId}
                  </span>
                </span>
              }
              description={
                item.intent.text ||
                `chat=${item.intent.chatId ?? "-"} request=${item.intent.requestId ?? "-"}`
              }
            >
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    mutation.mutate({
                      action: "accept",
                      scope: directScope,
                      id: item.intent.id,
                    })
                  }
                >
                  确认执行
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    mutation.mutate({
                      action: "decline",
                      scope: directScope,
                      id: item.intent.id,
                    })
                  }
                >
                  拒绝
                </Button>
              </div>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      {hubBindings.length > 0 && (
        <div className="flex justify-start">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAddingHub(true)}
          >
            <Plus data-icon="inline-start" />
            接入其他 Hub 空间
          </Button>
        </div>
      )}

      {/* Unified Pair New Device Modal: Direct LAN (Zero-Hub!) + Hub Pairing */}
      <PairDeviceModal
        open={pairModalOpen}
        onOpenChange={setPairModalOpen}
        hubBinding={primaryHubBinding}
        directTrustedCount={directTrusted.data?.length ?? 0}
        onPairHub={async (pair) => {
          await pairHub(pair);
          toast.success("已连接到 Lever Hub");
        }}
        onRefreshStatus={() =>
          void qc.invalidateQueries({ queryKey: ["remote"] })
        }
      />

      {/* Unified Device Scope & Permissions Modal (Works for BOTH Direct LAN and Hub devices!) */}
      {editingDevice && (
        <DeviceScopeDialog
          device={editingDevice}
          isSelf={
            editingDevice.id ===
            (localInfo.data?.deviceId ?? list[0]?.deviceId ?? "")
          }
          agents={activeAgents}
          chats={chats}
          onClose={() => setEditingDevice(undefined)}
          onMutate={(input, onDone) =>
            mutation.mutate(input, onDone ? { onSuccess: onDone } : undefined)
          }
          onControl={async (path, method, body) => {
            await api("/remote", {
              action: "control",
              scope: editingDevice.scope,
              method,
              path,
              body,
            });
            void qc.invalidateQueries({ queryKey: ["remote"] });
          }}
        />
      )}

      {/* Add Another Hub Modal */}
      <Dialog open={addingHub} onOpenChange={setAddingHub}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>连接新的 Lever Hub</DialogTitle>
            <DialogDescription>
              可将本机同时接入另一个 Hub 或协作空间。
            </DialogDescription>
          </DialogHeader>
          <PairHubForm
            inline
            submitLabel="连接并配对"
            onPair={async (pair) => {
              await pairHub(pair);
              toast.success("已连接到新空间");
              setAddingHub(false);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Embedded Shared Workspace Dialog */}
      <Dialog
        open={!!opened}
        onOpenChange={(open) => {
          if (!open) setOpened(undefined);
        }}
      >
        <DialogContent className="h-[92dvh] w-[96vw] max-w-none overflow-hidden p-0 sm:max-w-[96vw]">
          <DialogTitle className="sr-only">共享空间</DialogTitle>
          {opened && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  正在连接共享空间…
                </div>
              }
            >
              <Workspace transport={control} origin={opened.origin} />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PairHubForm({
  inline,
  submitLabel = "连接 Hub",
  onPair,
}: {
  inline?: boolean;
  submitLabel?: string;
  onPair: (pair: {
    hub: string;
    code: string;
    role: string;
  }) => Promise<void>;
}) {
  const [link, setLink] = useState("");
  const [origin, setOrigin] = useState("");
  const [role, setRole] = useState("workstation");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const trimmed = link.trim();
  const isLink = trimmed.includes("://");
  const detectedHub = useMemo(() => {
    if (!isLink) return "";
    try {
      const u = new URL(trimmed);
      if (u.protocol === "leverdevice:" && u.hostname === "pair") {
        return u.searchParams.get("hub") ?? "";
      }
    } catch {
      /* ignore partial input */
    }
    return "";
  }, [isLink, trimmed]);

  const form = (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        const parsed = parsePairingInput(link, origin);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setPending(true);
        try {
          await onPair({ hub: parsed.hub, code: parsed.code, role });
          setLink("");
          setOrigin("");
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            aria-label="配对链接或短码"
            placeholder="粘贴 leverdevice://pair?hub=...&code=... 或短码"
            autoComplete="off"
            className="flex-1 font-mono text-xs"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              if (error) setError("");
            }}
          />
          <Button type="submit" disabled={pending}>
            {pending ? "连接中…" : submitLabel}
          </Button>
        </div>

        {detectedHub ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            已自动识别 Hub 地址：
            <span className="font-mono text-foreground">{detectedHub}</span>
          </p>
        ) : (
          !isLink &&
          trimmed.length > 0 && (
            <Input
              aria-label="Hub 地址"
              placeholder="Hub 地址，例如 https://hub.example.com"
              type="url"
              value={origin}
              onChange={(e) => {
                setOrigin(e.target.value);
                if (error) setError("");
              }}
            />
          )
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">本机角色</span>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          size="sm"
          value={role}
          aria-label="本机角色"
          onValueChange={(v) => {
            if (v) setRole(v);
          }}
        >
          <ToggleGroupItem value="workstation">工作机（推荐）</ToggleGroupItem>
          <ToggleGroupItem value="executor">仅执行</ToggleGroupItem>
          <ToggleGroupItem value="controller">仅控制</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );

  if (inline) return form;
  return (
    <SettingsGroup title="Lever Hub 连接">
      <div className="p-4">{form}</div>
    </SettingsGroup>
  );
}

function HubBindingPanel({
  b,
  agents,
  chats,
  isPending,
  mutate,
  openWorkspace,
  onOpenPair,
  onEditDevice,
}: {
  b: Binding;
  agents: Agent[];
  chats: Chat[];
  isPending: boolean;
  mutate: (input: unknown, onSuccess?: () => void) => void;
  openWorkspace: () => void;
  onOpenPair: () => void;
  onEditDevice: (device: EditableDevice) => void;
}) {
  const scope = useMemo(
    () => ({ hubId: b.hubId, spaceId: b.spaceId }),
    [b.hubId, b.spaceId],
  );
  const [manualControllerId, setManualControllerId] = useState("");
  const canExecute = b.role !== "controller";
  const canControl = b.role !== "executor";

  const trusted = useQuery({
    queryKey: ["remote", "trusted", b.hubId, b.spaceId],
    enabled: canExecute,
    queryFn: () =>
      api<TrustedController[]>("/remote", { action: "trusted", scope }),
  });

  const grants = useQuery({
    queryKey: ["remote", "private-grants", b.hubId, b.spaceId],
    enabled: b.lan && canExecute,
    queryFn: () =>
      api<PrivateGrant[]>("/remote", { action: "private_grants", scope }),
  });

  const devices = useQuery({
    queryKey: ["remote", "devices", b.hubId, b.spaceId],
    enabled: b.online && canControl,
    queryFn: () => api<Device[]>("/remote", { action: "devices", scope }),
    refetchInterval: 12000,
  });

  const inbox = useQuery({
    queryKey: ["remote", "inbox", b.hubId, b.spaceId],
    enabled: canExecute,
    queryFn: () => api<InboxItem[]>("/remote", { action: "inbox", scope }),
    refetchInterval: 4000,
  });

  const activeAgents = useMemo(
    () => agents.filter((a) => !a.archived),
    [agents],
  );
  const exposedAgents = useMemo(
    () =>
      b.exposeAll
        ? activeAgents
        : activeAgents.filter((a) => b.agents.includes(a.id)),
    [activeAgents, b.agents, b.exposeAll],
  );
  const exposedAgentIds = useMemo(
    () => new Set(exposedAgents.map((a) => a.id)),
    [exposedAgents],
  );

  const mergedDevices = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        role: Role;
        platform: string;
        online: boolean;
        draining: boolean;
        revoked: boolean;
      }
    >();
    for (const d of devices.data ?? []) {
      if (!d.revoked || trusted.data?.some((t) => t.id === d.id)) {
        map.set(d.id, d);
      }
    }
    for (const t of trusted.data ?? []) {
      if (!map.has(t.id)) {
        map.set(t.id, {
          id: t.id,
          name: t.name,
          role: "controller",
          platform: "mobile",
          online: false,
          draining: false,
          revoked: false,
        });
      }
    }
    return [...map.values()].sort((a, c) => {
      if (a.id === b.deviceId) return -1;
      if (c.id === b.deviceId) return 1;
      if (a.online !== c.online) return a.online ? -1 : 1;
      return a.name.localeCompare(c.name);
    });
  }, [devices.data, trusted.data, b.deviceId]);

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Lever Hub 连接 — 默认展开 */}
      <SettingsGroup title="Lever Hub 连接">
        <SettingsRow
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={`size-2 shrink-0 rounded-full ${
                  b.online ? "bg-emerald-500" : "bg-muted-foreground/50"
                }`}
                aria-hidden="true"
              />
              <span className="font-mono text-[13px]">{b.origin}</span>
              <Badge variant="outline">{ROLE_LABELS[b.role] ?? b.role}</Badge>
              <Badge variant={b.online ? "secondary" : "outline"}>
                {b.online ? "已连接" : "离线"}
              </Badge>
            </span>
          }
          description={
            b.error
              ? `连接异常：${b.error}`
              : `同步版本 ${b.acked} / ${b.version} · 空间 ${b.spaceId.slice(0, 8)}`
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {canControl && (
              <Button variant="outline" size="sm" onClick={openWorkspace}>
                <ExternalLink data-icon="inline-start" />
                打开共享空间
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirm("解除与此 Hub 空间的配对？"))
                  mutate({ action: "unpair", scope });
              }}
            >
              <Unlink data-icon="inline-start" />
              断开配对
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          title="本机设备标识"
          description="用于在局域网直连和配对设备列表中识别此电脑。"
        >
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {b.deviceId}
            </code>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="复制设备 ID"
              title="复制设备 ID"
              onClick={() => void copyText(b.deviceId, "已复制设备 ID")}
            >
              <Copy />
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      {/* 2. 已连接设备 */}
      {(canControl || canExecute) && (
        <SettingsGroup title="已连接设备">
          {mergedDevices.length === 0 ? (
            <SettingsRow
              title="尚未发现其他设备"
              description={
                canControl
                  ? "点击上方「配对新设备」用手机扫码，或在其他电脑上粘贴配对链接。"
                  : "本机角色为仅执行。如需为手机授予局域网直连与免确认权限，可在下方输入控制端设备 ID。"
              }
            >
              <Button size="sm" variant="outline" onClick={onOpenPair}>
                <QrCode data-icon="inline-start" />
                配对新设备
              </Button>
            </SettingsRow>
          ) : (
            mergedDevices.map((d) => {
              const isSelf = d.id === b.deviceId;
              const trustEntry = trusted.data?.find((t) => t.id === d.id);
              const scopeSummary =
                canExecute && !isSelf && d.role !== "executor"
                  ? summarizeControllerScope(trustEntry, exposedAgentIds)
                  : undefined;
              const statusText = d.revoked
                ? "已撤销"
                : d.draining
                  ? "暂停接单"
                  : d.online
                    ? "在线"
                    : "离线";
              return (
                <SettingsRow
                  key={d.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60">
                        <DeviceIcon platform={d.platform} role={d.role} />
                      </span>
                      <span className="font-medium">{d.name}</span>
                      {isSelf && <Badge variant="secondary">本机</Badge>}
                      {scopeSummary && (
                        <Badge variant={scopeSummary.variant}>
                          {scopeSummary.label}
                        </Badge>
                      )}
                    </span>
                  }
                  description={`${ROLE_LABELS[d.role] ?? d.role} · ${d.platform || "unknown"} · ${statusText}`}
                >
                  {(!isSelf || (canControl && b.online && !d.revoked)) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onEditDevice({
                          ...d,
                          isDirect: false,
                          scope,
                          spaceId: b.spaceId,
                          canControl,
                          canExecute,
                          hostOnline: b.online,
                          lanEnabled: b.lan,
                          exposedAgents,
                        })
                      }
                    >
                      <SlidersHorizontal data-icon="inline-start" />
                      {isSelf ? "设备信息" : "权限与范围"}
                    </Button>
                  )}
                </SettingsRow>
              );
            })
          )}
          {!canControl && canExecute && (
            <SettingsRow
              title="按 ID 添加信任控制端"
              description="仅执行模式无法拉取空间设备目录，可直接输入手机端显示的本机设备 ID 开启信任。"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label="控制端设备 ID"
                  placeholder="输入控制端设备 ID"
                  className="w-56 font-mono text-xs"
                  value={manualControllerId}
                  onChange={(e) => setManualControllerId(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!manualControllerId.trim() || !b.online || isPending}
                  onClick={() =>
                    mutate(
                      {
                        action: "trust",
                        scope,
                        controllerId: manualControllerId.trim(),
                      },
                      () => {
                        setManualControllerId("");
                        toast.success("已信任该控制端");
                      },
                    )
                  }
                >
                  添加信任
                </Button>
              </div>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      {/* 3. 本机 Agent 开放范围 */}
      {canExecute && (
        <SettingsGroup title="本机 Agent 开放范围">
          <SettingsRow
            title="默认开放策略"
            description={
              b.exposeAll
                ? "当前及今后新建的所有未归档 Agent 均自动开放到此空间，无需每次新建后重新勾选。"
                : "仅下方手动开启开关的 Agent 对已配对设备可见。"
            }
          >
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              aria-label="Agent 开放策略"
              value={b.exposeAll ? "all" : "selected"}
              onValueChange={(value) => {
                if (!value) return;
                const enabled = value === "all";
                if (enabled === b.exposeAll) return;
                mutate({ action: "expose_all", scope, enabled });
              }}
            >
              <ToggleGroupItem value="all">全部 Agent（含新增）</ToggleGroupItem>
              <ToggleGroupItem value="selected">仅选定 Agent</ToggleGroupItem>
            </ToggleGroup>
          </SettingsRow>

          {b.exposeAll ? (
            <div className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {activeAgents.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    当前暂无活跃 Agent，新建后将自动同步开放。
                  </span>
                ) : (
                  activeAgents.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs"
                    >
                      <AgentAvatar agent={a} size="xs" />
                      <span className="max-w-36 truncate">{a.name}</span>
                    </span>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                共 {activeAgents.length} 个未归档 Agent 已自动开放。
              </p>
            </div>
          ) : activeAgents.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              暂无可开放的 Agent。
            </div>
          ) : (
            activeAgents.map((a) => (
              <SettingsRow
                key={a.id}
                title={
                  <span className="flex min-w-0 items-center gap-2.5">
                    <AgentAvatar agent={a} size="sm" />
                    <span className="truncate">{a.name}</span>
                  </span>
                }
                description={a.profile.provider || "向此空间开放"}
              >
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
            ))
          )}
        </SettingsGroup>
      )}

      {/* 4. 连接与后台 */}
      {(canExecute || b.loginSupported) && (
        <SettingsGroup title="连接与后台">
          {canExecute && (
            <SettingsRow
              title="局域网直连"
              description={
                b.lanError ||
                (b.lan && b.lanAddr
                  ? `已启用局域网直连（${b.lanAddr}），同 Wi-Fi 下手机低延迟直连并在 Hub 断网时保持可用。`
                  : "允许同一 Wi-Fi 下的受信任设备直连本机，降低延迟并在 Hub 断网时保持可用。")
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
          {b.loginSupported && (
            <SettingsRow
              title="登录时后台保持在线"
              description="开机登录后自动启动本地 Host，便于手机随时连接。"
            >
              <Switch
                aria-label="登录时后台保持在线"
                checked={b.login}
                onCheckedChange={(enabled) =>
                  mutate({ action: "login", scope, enabled })
                }
              />
            </SettingsRow>
          )}
          {b.lan &&
            grants.data?.map((g) => (
              <SettingsRow
                key={g.controllerId + ":" + g.chatId}
                title={g.title || "未命名本地对话"}
                description={`仅局域网授权给：${
                  mergedDevices.find((d) => d.id === g.controllerId)?.name ??
                  g.controllerId
                }`}
              >
                <Button
                  variant="ghost"
                  size="sm"
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
        </SettingsGroup>
      )}

      {/* 5. 待确认远程指令 */}
      {canExecute && (inbox.data?.length ?? 0) > 0 && (
        <SettingsGroup title="待确认远程指令">
          {inbox.data!.map((item) => (
            <SettingsRow
              key={item.intent.id}
              title={
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{item.intent.kind}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {mergedDevices.find(
                      (d) => d.id === item.intent.originDeviceId,
                    )?.name ?? item.intent.actorUserId}
                  </span>
                </span>
              }
              description={
                item.intent.text ||
                `chat=${item.intent.chatId ?? "-"} request=${item.intent.requestId ?? "-"}`
              }
            >
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    mutate({ action: "accept", scope, id: item.intent.id })
                  }
                >
                  确认执行
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    mutate({ action: "decline", scope, id: item.intent.id })
                  }
                >
                  拒绝
                </Button>
              </div>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
    </div>
  );
}

function PairDeviceModal({
  open,
  onOpenChange,
  hubBinding,
  directTrustedCount,
  onPairHub,
  onRefreshStatus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hubBinding?: Binding;
  directTrustedCount: number;
  onPairHub: (pair: {
    hub: string;
    code: string;
    role: string;
  }) => Promise<void>;
  onRefreshStatus: () => void;
}) {
  const qc = useQueryClient();
  const canIssueHub =
    !!hubBinding && hubBinding.role !== "executor" && hubBinding.online;

  // Default to Hub if an online Hub controller binding exists; otherwise IMMEDIATELY show Zero-Hub Direct LAN QR!
  const [channel, setChannel] = useState<"lan" | "hub">(
    canIssueHub ? "hub" : "lan",
  );
  const [hubMode, setHubMode] = useState<"mobile" | "desktop" | "cli">(
    "mobile",
  );
  const [lanTicket, setLanTicket] = useState<LANTicketResult>();
  const [hubTicket, setHubTicket] = useState<{
    code: string;
    expires: number;
  }>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const hubDevices = useQuery({
    queryKey: ["remote", "devices", hubBinding?.hubId, hubBinding?.spaceId],
    enabled: open && channel === "hub" && canIssueHub,
    queryFn: () =>
      api<Device[]>("/remote", {
        action: "devices",
        scope: { hubId: hubBinding!.hubId, spaceId: hubBinding!.spaceId },
      }),
    refetchInterval: open && channel === "hub" && canIssueHub ? 2500 : false,
  });

  const initialDirectCount = useRef<number | undefined>(undefined);
  const initialHubCount = useRef<number | undefined>(undefined);

  const hubRole: Role =
    hubMode === "mobile"
      ? "controller"
      : hubMode === "desktop"
        ? "workstation"
        : "executor";

  const generateLAN = async () => {
    setLoading(true);
    setErr("");
    setLanTicket(undefined);
    try {
      const next = await api<LANTicketResult>("/remote", {
        action: "lan_ticket",
      });
      setLanTicket(next);
      void qc.invalidateQueries({ queryKey: ["remote"] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const generateHub = async (targetRole: Role) => {
    if (!hubBinding || !canIssueHub) return;
    setLoading(true);
    setErr("");
    setHubTicket(undefined);
    try {
      const next = await api<{ code: string; expires: number }>("/remote", {
        action: "control",
        scope: { hubId: hubBinding.hubId, spaceId: hubBinding.spaceId },
        method: "POST",
        path: `/api/spaces/${hubBinding.spaceId}/tickets`,
        body: { role: targetRole },
      });
      setHubTicket(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Pick initial tab each time modal opens.
  useEffect(() => {
    if (!open) {
      initialDirectCount.current = undefined;
      initialHubCount.current = undefined;
      setLanTicket(undefined);
      setHubTicket(undefined);
      setErr("");
      return;
    }
    setChannel(canIssueHub ? "hub" : "lan");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Generate appropriate ticket whenever active channel or Hub target role changes.
  useEffect(() => {
    if (!open) return;
    if (channel === "lan") {
      void generateLAN();
    } else if (canIssueHub) {
      void generateHub(hubRole);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, channel, canIssueHub, hubRole, hubBinding?.hubId, hubBinding?.spaceId]);

  useEffect(() => {
    if (!open || channel !== "lan") return;
    if (initialDirectCount.current === undefined) {
      initialDirectCount.current = directTrustedCount;
      return;
    }
    if (directTrustedCount > initialDirectCount.current) {
      toast.success("新设备已完成局域网直连配对");
      initialDirectCount.current = directTrustedCount;
    }
  }, [open, channel, directTrustedCount]);

  const hubDevCount = hubDevices.data?.length ?? 0;
  useEffect(() => {
    if (!open || channel !== "hub" || !canIssueHub || !hubDevices.data) return;
    if (initialHubCount.current === undefined) {
      initialHubCount.current = hubDevCount;
      return;
    }
    if (hubDevCount > initialHubCount.current) {
      toast.success("检测到新设备已完成配对");
      initialHubCount.current = hubDevCount;
    }
  }, [open, channel, canIssueHub, hubDevices.data, hubDevCount]);

  const hubLink =
    hubTicket && hubBinding ? deviceLink(hubBinding.origin, hubTicket.code) : "";
  const cliCommand =
    hubTicket && hubBinding
      ? `lever remote pair --hub ${hubBinding.origin} --code ${hubTicket.code} --role executor`
      : "";

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("复制失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>配对新设备</DialogTitle>
          <DialogDescription>
            {channel === "lan"
              ? "无需 Hub，同 Wi-Fi 下用手机 Lever 扫码即可建立端到端加密直连。"
              : "经 Lever Hub 配对，支持公网远程访问、多电脑协作与锁屏推送。"}
          </DialogDescription>
        </DialogHeader>

        {/* Connection Mode Switch: Direct LAN (Zero Hub) vs Hub */}
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          className="w-full"
          value={channel}
          onValueChange={(v) => {
            if (v === "lan" || v === "hub") {
              setErr("");
              setChannel(v);
            }
          }}
        >
          <ToggleGroupItem value="lan" className="flex-1">
            <Wifi data-icon="inline-start" />
            局域网直连（免 Hub）
          </ToggleGroupItem>
          <ToggleGroupItem value="hub" className="flex-1">
            <Globe data-icon="inline-start" />
            经 Hub 配对
          </ToggleGroupItem>
        </ToggleGroup>

        {channel === "lan" ? (
          <div className="flex flex-col items-center gap-4 py-1">
            {err && (
              <p role="alert" className="w-full text-xs text-destructive">
                {err}
              </p>
            )}
            {loading && !lanTicket ? (
              <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                正在启动局域网加密服务并生成二维码…
              </div>
            ) : (
              lanTicket && (
                <>
                  <div className="rounded-xl border border-border bg-white p-3.5 shadow-xs">
                    <QRCodeSVG
                      value={lanTicket.link}
                      size={180}
                      marginSize={1}
                    />
                  </div>
                  <div className="flex flex-col items-center gap-1 text-center">
                    <div className="font-mono text-base font-semibold tracking-wider tabular-nums">
                      {lanTicket.code}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      确保手机与本机在同一 Wi-Fi，打开手机 <strong>Lever</strong> 扫码即可直连
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      {lanTicket.lan} · 有效期至{" "}
                      {new Date(lanTicket.expires * 1000).toLocaleTimeString()}
                    </p>
                  </div>
                  <div className="flex w-full items-center gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => void copy(lanTicket.link)}
                    >
                      {copied ? (
                        <Check data-icon="inline-start" />
                      ) : (
                        <Copy data-icon="inline-start" />
                      )}
                      复制直连配对链接
                    </Button>
                    <Button
                      variant="outline"
                      disabled={loading}
                      onClick={() => void generateLAN()}
                    >
                      <RefreshCw data-icon="inline-start" />
                      刷新
                    </Button>
                  </div>
                </>
              )
            )}
          </div>
        ) : !hubBinding ? (
          <div className="flex flex-col gap-3.5 py-1">
            <div className="rounded-xl border border-border bg-muted/35 p-3 text-xs leading-relaxed text-muted-foreground">
              <div className="font-medium text-foreground">
                尚未连接自托管 Lever Hub（可选）
              </div>
              <p className="mt-1">
                如果只需在同 Wi-Fi 下使用手机，切回左侧「局域网直连」直接扫码即可。如需公网访问与推送，可粘贴 Hub 配对链接接入本机：
              </p>
            </div>
            <PairHubForm
              inline
              submitLabel="连接 Hub"
              onPair={onPairHub}
            />
          </div>
        ) : hubBinding.role === "executor" ? (
          <div className="flex flex-col gap-3 py-1 text-xs leading-relaxed text-muted-foreground">
            <div className="rounded-xl border border-border bg-muted/35 p-3">
              本机当前以 <strong className="text-foreground">仅执行</strong>{" "}
              角色接入 <code className="font-mono text-foreground">{hubBinding.origin}</code>，不能直接签发 Hub 配对码。请前往 Hub 网页生成，或切换左侧「局域网直连」直接扫码。
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => void copy(hubBinding.origin)}
              >
                <Copy data-icon="inline-start" />
                复制 Hub 地址
              </Button>
              <Button onClick={() => setChannel("lan")}>改用局域网直连</Button>
            </div>
          </div>
        ) : !hubBinding.online ? (
          <div className="flex flex-col gap-3 py-1 text-xs leading-relaxed text-muted-foreground">
            <div className="rounded-xl border border-border bg-muted/35 p-3">
              当前与 <code className="font-mono text-foreground">{hubBinding.origin}</code> 离线
              {hubBinding.error ? `（${hubBinding.error}）` : ""}。可先切换到左侧「局域网直连」扫码，或恢复网络后重试。
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onRefreshStatus}>
                <RefreshCw data-icon="inline-start" />
                刷新状态
              </Button>
              <Button onClick={() => setChannel("lan")}>改用局域网直连</Button>
            </div>
          </div>
        ) : (
          <>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              className="w-full"
              value={hubMode}
              onValueChange={(v) => {
                if (v === "mobile" || v === "desktop" || v === "cli")
                  setHubMode(v);
              }}
            >
              <ToggleGroupItem value="mobile" className="flex-1">
                <Smartphone data-icon="inline-start" />
                手机 App
              </ToggleGroupItem>
              <ToggleGroupItem value="desktop" className="flex-1">
                <Laptop data-icon="inline-start" />
                另一台电脑
              </ToggleGroupItem>
              <ToggleGroupItem value="cli" className="flex-1">
                <Terminal data-icon="inline-start" />
                服务器 CLI
              </ToggleGroupItem>
            </ToggleGroup>

            {err && (
              <p role="alert" className="text-xs text-destructive">
                {err}
              </p>
            )}

            {loading && !hubTicket ? (
              <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                正在生成 Hub 配对凭证…
              </div>
            ) : (
              hubTicket && (
                <div className="flex flex-col items-center gap-4 py-1">
                  {hubMode !== "cli" && (
                    <div className="rounded-xl border border-border bg-white p-3.5 shadow-xs">
                      <QRCodeSVG value={hubLink} size={172} marginSize={1} />
                    </div>
                  )}

                  {hubMode === "cli" ? (
                    <div className="flex w-full flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        在目标 Linux / 无界面服务器上运行以下命令：
                      </p>
                      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-xs leading-relaxed">
                        {cliCommand}
                      </pre>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-center">
                      <div className="font-mono text-base font-semibold tracking-wider tabular-nums">
                        {hubTicket.code}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {hubMode === "mobile"
                          ? "打开手机上的 Lever，扫码或粘贴配对链接即可完成连接"
                          : "在另一台电脑「设置 → 远程与设备」中直接粘贴配对链接"}
                      </p>
                      <p className="text-[11px] text-muted-foreground tabular-nums">
                        有效期至{" "}
                        {new Date(hubTicket.expires * 1000).toLocaleTimeString()}
                      </p>
                    </div>
                  )}

                  <div className="flex w-full items-center gap-2">
                    <Button
                      className="flex-1"
                      onClick={() =>
                        void copy(hubMode === "cli" ? cliCommand : hubLink)
                      }
                    >
                      {copied ? (
                        <Check data-icon="inline-start" />
                      ) : (
                        <Copy data-icon="inline-start" />
                      )}
                      {hubMode === "cli" ? "复制命令" : "复制配对链接"}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={loading}
                      onClick={() => void generateHub(hubRole)}
                    >
                      <RefreshCw data-icon="inline-start" />
                      刷新
                    </Button>
                  </div>
                </div>
              )
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeviceScopeDialog({
  device,
  isSelf,
  agents,
  chats,
  onClose,
  onMutate,
  onControl,
}: {
  device: EditableDevice;
  isSelf: boolean;
  agents: Agent[];
  chats: Chat[];
  onClose: () => void;
  onMutate: (input: unknown, onDone?: () => void) => void;
  onControl: (path: string, method?: string, body?: unknown) => Promise<void>;
}) {
  const { scope } = device;
  const trusted = useQuery({
    queryKey: ["remote", "trusted", scope.hubId, scope.spaceId],
    enabled: device.canExecute,
    queryFn: () =>
      api<TrustedController[]>("/remote", { action: "trusted", scope }),
  });
  const grants = useQuery({
    queryKey: ["remote", "private-grants", scope.hubId, scope.spaceId],
    enabled: device.lanEnabled && device.canExecute && !device.isDirect,
    queryFn: () =>
      api<PrivateGrant[]>("/remote", { action: "private_grants", scope }),
  });

  const trustEntry = trusted.data?.find((t) => t.id === device.id);
  const exposedAgents = device.exposedAgents.length
    ? device.exposedAgents
    : agents;
  const privateChats = chats.filter((c) => !c.sharedScope);
  const deviceGrants = (grants.data ?? []).filter(
    (g) => g.controllerId === device.id,
  );

  const [nameDraft, setNameDraft] = useState(device.name);
  const [savingName, setSavingName] = useState(false);
  const [drainingBusy, setDrainingBusy] = useState(false);
  const [chatToGrant, setChatToGrant] = useState("");
  const justTrustedRef = useRef(false);

  const isTrusted = !!trustEntry;
  const perms = trustEntry?.permissions ?? [];
  const hasWildcard = perms.some((p) => p.agentId === "*");

  const [scopeMode, setScopeMode] = useState<"all" | "selected">(
    hasWildcard || perms.length === 0 ? "all" : "selected",
  );
  const [selectedAgents, setSelectedAgents] = useState<string[]>(() =>
    hasWildcard
      ? exposedAgents.map((a) => a.id)
      : [...new Set(perms.filter((p) => p.agentId !== "*").map((p) => p.agentId))],
  );
  const [ops, setOps] = useState<string[]>(() =>
    hasWildcard
      ? perms.filter((p) => p.agentId === "*").map((p) => p.action)
      : [...new Set(perms.map((p) => p.action))],
  );

  useEffect(() => {
    setNameDraft(device.name);
  }, [device.id, device.name]);

  const permsKey = useMemo(
    () =>
      (trustEntry?.permissions ?? [])
        .map((p) => `${p.agentId}:${p.action}`)
        .sort()
        .join("|"),
    [trustEntry],
  );

  useEffect(() => {
    const nextPerms = trustEntry?.permissions ?? [];
    if (justTrustedRef.current && nextPerms.length === 0) {
      justTrustedRef.current = false;
      setScopeMode("all");
      setSelectedAgents(exposedAgents.map((a) => a.id));
      setOps(["send", "answer", "stop", "dispatch_task"]);
      return;
    }
    const nextWildcard = nextPerms.some((p) => p.agentId === "*");
    setScopeMode(nextWildcard || nextPerms.length === 0 ? "all" : "selected");
    if (nextWildcard) {
      setSelectedAgents(exposedAgents.map((a) => a.id));
      setOps(nextPerms.filter((p) => p.agentId === "*").map((p) => p.action));
    } else {
      setSelectedAgents([
        ...new Set(
          nextPerms.filter((p) => p.agentId !== "*").map((p) => p.agentId),
        ),
      ]);
      setOps([...new Set(nextPerms.map((p) => p.action))]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id, isTrusted, permsKey]);

  const canConfigureTrust =
    device.canExecute && !isSelf && device.role !== "executor";
  const canRenameHub =
    !device.isDirect && device.canControl && device.hostOnline && !device.revoked;
  const canRenameDirect = device.isDirect && !isSelf && isTrusted;

  const savePermissions = () => {
    onMutate(
      {
        action: "set_permissions",
        scope,
        controllerId: device.id,
        allAgents: scopeMode === "all",
        agentIds: scopeMode === "all" ? [] : selectedAgents,
        operations: ops,
      },
      () => {
        toast.success("已更新设备权限范围");
        onClose();
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[86dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DeviceIcon platform={device.platform} role={device.role} />
            <span>{device.name}</span>
            {isSelf && <Badge variant="secondary">本机</Badge>}
            {device.isDirect && <Badge variant="secondary">局域网直连</Badge>}
          </DialogTitle>
          <DialogDescription>
            {ROLE_LABELS[device.role] ?? device.role} ·{" "}
            {device.isDirect
              ? "免 Hub 同 Wi-Fi 直连"
              : `${device.platform} · ${
                  device.revoked
                    ? "已撤销"
                    : device.draining
                      ? "暂停接单"
                      : device.online
                        ? "在线"
                        : "离线"
                }`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-1">
          {/* Rename */}
          {(canRenameHub || canRenameDirect) && (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="device-rename-input"
                className="text-[13px] font-medium"
              >
                设备名称
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id="device-rename-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    savingName ||
                    !nameDraft.trim() ||
                    nameDraft.trim() === device.name
                  }
                  onClick={async () => {
                    if (canRenameDirect) {
                      onMutate(
                        {
                          action: "rename_trusted",
                          scope,
                          controllerId: device.id,
                          name: nameDraft.trim(),
                        },
                        () => toast.success("已更新设备名称"),
                      );
                      return;
                    }
                    setSavingName(true);
                    try {
                      await onControl(
                        `/api/spaces/${device.spaceId}/devices/${device.id}`,
                        "PATCH",
                        { name: nameDraft.trim() },
                      );
                      toast.success("已更新设备名称");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : String(e));
                    } finally {
                      setSavingName(false);
                    }
                  }}
                >
                  保存名称
                </Button>
              </div>
            </div>
          )}

          {/* Trust & Agent Scope */}
          {canConfigureTrust && (
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-muted/25 p-3.5">
              {!device.isDirect && (
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium">
                      <ShieldCheck className="size-4 text-muted-foreground" />
                      信任此控制端
                    </div>
                    <p className="text-xs text-muted-foreground">
                      开启后，即使 Hub 离线也可在局域网直连，并可按下方范围免确认执行操作。
                    </p>
                  </div>
                  <Switch
                    aria-label="信任此控制端"
                    checked={isTrusted}
                    disabled={!device.hostOnline && !isTrusted}
                    onCheckedChange={(enabled) => {
                      if (enabled) justTrustedRef.current = true;
                      onMutate({
                        action: enabled ? "trust" : "untrust",
                        scope,
                        controllerId: device.id,
                      });
                    }}
                  />
                </div>
              )}

              {isTrusted && (
                <>
                  <div
                    className={`flex flex-col gap-2 ${
                      device.isDirect ? "" : "border-t border-border pt-3"
                    }`}
                  >
                    <span className="text-[13px] font-medium">
                      可操作的 Agent 范围
                    </span>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      spacing={0}
                      className="w-full"
                      value={scopeMode}
                      onValueChange={(v) => {
                        if (v === "all" || v === "selected") setScopeMode(v);
                      }}
                    >
                      <ToggleGroupItem value="all" className="flex-1">
                        全部开放 Agent（含新增）
                      </ToggleGroupItem>
                      <ToggleGroupItem value="selected" className="flex-1">
                        仅限指定 Agent
                      </ToggleGroupItem>
                    </ToggleGroup>
                    <p className="text-xs text-muted-foreground">
                      {scopeMode === "all"
                        ? "自动跟随本机已开放的全部 Agent；今后新建的 Agent 也会自动生效，无需重复配置。"
                        : "仅勾选的 Agent 允许该设备直接执行操作，其余操作需在本机确认。"}
                    </p>

                    {scopeMode === "selected" && (
                      <div className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-background p-2">
                        {exposedAgents.length === 0 ? (
                          <span className="px-2 py-1 text-xs text-muted-foreground">
                            本机尚未开放任何 Agent。
                          </span>
                        ) : (
                          exposedAgents.map((a) => {
                            const checked = selectedAgents.includes(a.id);
                            return (
                              <label
                                key={a.id}
                                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-control-hover"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(next) =>
                                    setSelectedAgents((prev) =>
                                      next
                                        ? [...new Set([...prev, a.id])]
                                        : prev.filter((id) => id !== a.id),
                                    )
                                  }
                                />
                                <AgentAvatar agent={a} size="xs" />
                                <span className="truncate">{a.name}</span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <span className="text-[13px] font-medium">
                      允许免确认执行的操作
                    </span>
                    <ToggleGroup
                      type="multiple"
                      variant="outline"
                      spacing={1}
                      className="flex-wrap"
                      value={ops}
                      onValueChange={setOps}
                    >
                      {OPERATIONS.map(([val, label]) => (
                        <ToggleGroupItem key={val} value={val}>
                          {label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <p className="text-xs text-muted-foreground">
                      未勾选的操作仍会发往本机，需手动确认后执行。
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Hub LAN Private Chat Grants */}
          {canConfigureTrust && device.lanEnabled && !device.isDirect && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-border p-3.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium">
                  局域网仅设备对话授权
                </span>
                <p className="text-xs text-muted-foreground">
                  本地私有对话内容不经 Hub，仅在局域网直连时提供给此设备。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={chatToGrant} onValueChange={setChatToGrant}>
                  <SelectTrigger className="flex-1" aria-label="选择本地对话">
                    <SelectValue placeholder="选择本地私有对话…" />
                  </SelectTrigger>
                  <SelectContent>
                    {privateChats.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.title || "未命名对话"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!chatToGrant}
                  onClick={() =>
                    onMutate(
                      {
                        action: "grant_private",
                        scope,
                        id: chatToGrant,
                        controllerId: device.id,
                      },
                      () => {
                        setChatToGrant("");
                        toast.success("已授权局域网对话");
                      },
                    )
                  }
                >
                  授权
                </Button>
              </div>
              {deviceGrants.length > 0 && (
                <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
                  {deviceGrants.map((g) => (
                    <div
                      key={g.chatId}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs"
                    >
                      <span className="truncate">
                        {g.title || "未命名对话"}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          onMutate({
                            action: "revoke_private",
                            scope,
                            id: g.chatId,
                            controllerId: device.id,
                          })
                        }
                      >
                        收回
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Revoke (Direct LAN OR Hub) */}
          {!isSelf && (device.isDirect || canRenameHub) && (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              {!device.isDirect && device.role !== "controller" && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium">暂停接单</div>
                    <p className="text-xs text-muted-foreground">
                      不向此执行机派发新任务，正在运行的会话不受影响。
                    </p>
                  </div>
                  <Switch
                    aria-label="暂停接单"
                    checked={device.draining}
                    disabled={drainingBusy}
                    onCheckedChange={async (draining) => {
                      setDrainingBusy(true);
                      try {
                        await onControl(
                          `/api/spaces/${device.spaceId}/devices/${device.id}`,
                          "PATCH",
                          { draining },
                        );
                        toast.success(draining ? "已暂停接单" : "已恢复接单");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : String(e));
                      } finally {
                        setDrainingBusy(false);
                      }
                    }}
                  />
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-destructive">
                    撤销此设备
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {device.isDirect
                      ? "立即吊销该设备的局域网直连授权，下次访问将被拒绝。"
                      : "立即吊销该设备在空间内的访问凭证。"}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    if (!confirm(`确认撤销「${device.name}」的访问权限？`))
                      return;
                    if (device.isDirect) {
                      onMutate(
                        {
                          action: "untrust",
                          scope,
                          controllerId: device.id,
                        },
                        () => {
                          toast.success("已撤销该局域网设备");
                          onClose();
                        },
                      );
                      return;
                    }
                    try {
                      await onControl(
                        `/api/spaces/${device.spaceId}/devices/${device.id}`,
                        "DELETE",
                      );
                      toast.success("已撤销该设备");
                      onClose();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  <Trash2 data-icon="inline-start" />
                  撤销设备
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          {canConfigureTrust && isTrusted && (
            <Button onClick={savePermissions}>保存权限</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
