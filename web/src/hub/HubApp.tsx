import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { call, on } from "mygo-runtime";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  ListTodo,
  Lock,
  MessageCircle,
  MonitorSmartphone,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTheme, type Theme } from "@/hooks/useTheme";
import type {
  Device,
  InboxItem,
  PushNotice,
  Record as Shared,
  Task,
} from "@/api/hub.gen";
import { fetchArchive, savedArchive } from "./archive";
import {
  clearSaved,
  pairPhone,
  readLocal,
  saveLocal,
  type Account,
  type Transport,
} from "./client";
import { ScanPairing } from "./ScanPairing";
import { DevicesPanel, ProfilePanel } from "./Devices";
import { Conversation, type Command } from "./Conversation";
import { NewTask, TaskDetail } from "./Tasks";
import { formatChatTime, HubAgentAvatar, LeverMark } from "./ui";
import "./hub.css";

export function HubApp({
  transport,
  origin,
}: {
  transport: Transport;
  origin?: string;
}) {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 1000 },
          mutations: { retry: false },
        },
      }),
    [transport],
  );
  return (
    <QueryClientProvider client={client}>
      <Entry transport={transport} origin={origin} />
    </QueryClientProvider>
  );
}

export interface Workspace {
  transport: Transport;
  path: string;
  key: string;
  origin: string;
  refresh(): void;
  go(route: string): void;
  act(fn: () => Promise<void>): Promise<void>;
}

function useIsCompact() {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 768 : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return compact;
}

function Entry({
  transport,
  origin,
}: {
  transport: Transport;
  origin?: string;
}) {
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => transport.request<Account>("/api/me"),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const [link, setLink] = useState("");
  useEffect(() => {
    if (transport.kind !== "mobile") return;
    const check = () =>
      void call<string>("Mobile.PairingLink")
        .then((v) => {
          if (v) setLink(v);
        })
        .catch(() => {});
    check();
    const timer = setInterval(check, 1200);
    return () => clearInterval(timer);
  }, [transport]);

  if (me.isLoading) {
    return (
      <main className="hub-login">
        <div className="flex flex-col items-center gap-3">
          <LeverMark size={56} />
          <span className="text-xs text-muted-foreground">正在连接 Lever…</span>
        </div>
      </main>
    );
  }

  if (!me.data) {
    return (
      <main className="hub-login">
        <form
          className="hub-login-card"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(async () => {
              if (transport.kind === "mobile") {
                await pairPhone(link);
                const account = await transport.request<Account>("/api/me");
                const status = await transport
                  .request<{
                    available: boolean;
                  }>("/api/spaces/" + account.spaces[0].id + "/push")
                  .catch(() => null);
                if (status?.available)
                  void call("Mobile.SetPush", true).catch(() => {});
              } else {
                await transport.request("/api/login", "POST", {
                  name: f.get("user"),
                  password: f.get("password"),
                });
              }
              await qc.invalidateQueries({ queryKey: ["me"] });
            });
          }}
        >
          <div className="flex flex-col items-center gap-2.5 text-center">
            <LeverMark size={64} />
            <div className="flex flex-col gap-0.5">
              <h1 className="text-[22px] font-semibold tracking-tight">
                {transport.kind === "mobile" ? "Lever" : "登录 Lever"}
              </h1>
              <p className="text-xs text-muted-foreground">
                {transport.kind === "mobile"
                  ? "连接你的工作电脑，随时与 Agent 对话并审批操作"
                  : "登录你的 Lever Hub 协作空间"}
              </p>
            </div>
          </div>

          {transport.kind === "mobile" ? (
            <div className="flex flex-col gap-3.5">
              <ScanPairing onLink={setLink} />
              <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>或粘贴配对链接</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                配对链接
                <Input
                  aria-label="配对链接"
                  placeholder="leverdevice://pair?hub=...&code=..."
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  required
                />
              </label>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                账号
                <Input
                  name="user"
                  autoComplete="username"
                  defaultValue="admin"
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                密码
                <Input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
            </div>
          )}

          <Button type="submit" className="h-10 w-full rounded-xl" disabled={busy}>
            {transport.kind === "mobile"
              ? busy
                ? "正在配对…"
                : "连接并配对"
              : "登录"}
          </Button>
          {error && (
            <p role="alert" className="text-center text-xs text-destructive">
              {error}
            </p>
          )}
        </form>
      </main>
    );
  }

  return (
    <Workbench
      key={me.data.hub.id + me.data.userId}
      account={me.data}
      transport={transport}
      origin={origin ?? me.data.origin}
      theme={theme}
      onThemeChange={setTheme}
      onLogout={() =>
        void act(async () => {
          if (transport.kind === "mobile") await call("Mobile.Unpair");
          else await transport.request("/api/logout", "POST", {});
          clearSaved(me.data.hub.id, me.data.userId);
          qc.clear();
          await me.refetch();
        })
      }
    />
  );
}

function useSavedFilter<T>(key: string, initial: T): [T, (value: T) => void] {
  const [local, setLocal] = useState(() => ({
    key,
    value: readLocal(key, initial),
  }));
  return [
    local.key === key ? local.value : readLocal(key, initial),
    (value) => {
      saveLocal(key, value);
      setLocal({ key, value });
    },
  ];
}

function useSavedScroll(key: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const target = readLocal<number>(key, 0);
    const observer = new MutationObserver(restore);
    function restore() {
      if (node && node.scrollHeight - node.clientHeight >= target) {
        node.scrollTop = target;
        observer.disconnect();
      }
    }
    const stop = () => observer.disconnect();
    const save = () => saveLocal(key, node.scrollTop);
    observer.observe(node, { childList: true, subtree: true });
    restore();
    node.addEventListener("wheel", stop, { passive: true });
    node.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      stop();
      save();
      node.removeEventListener("wheel", stop);
      node.removeEventListener("touchstart", stop);
      window.removeEventListener("pagehide", save);
    };
  }, [key]);
  return ref;
}

interface AgentRowItem {
  key: string;
  device: Device;
  agentId: string;
  name: string;
  avatar?: string;
  model?: string;
  provider?: string;
  latestChat?: Shared;
  chatCount: number;
  unreadCount: number;
  sortTime: number;
  timeText: string;
  preview: string;
  isPrivate: boolean;
}

function Workbench({
  account,
  transport,
  origin,
  theme,
  onThemeChange,
  onLogout,
}: {
  account: Account;
  transport: Transport;
  origin?: string;
  theme: Theme;
  onThemeChange: (next: Theme) => void;
  onLogout: () => void;
}) {
  const qc = useQueryClient();
  const compact = useIsCompact();
  const isMobileUI = transport.kind === "mobile" || compact;
  const prefix = `lever:hub:${account.hub.id}:${account.userId}:${account.deviceId || "browser"}:`;
  const [route, setRoute] = useState(() =>
    transport.kind === "web" && location.pathname.startsWith("/s/")
      ? location.pathname
      : readLocal(prefix + "route", ""),
  );
  const parts = route.split("/").filter(Boolean);
  const space =
    account.spaces.find((v) => v.id === parts[1]) ?? account.spaces[0];
  const base = "/s/" + space.id;

  // Resolve top-level section while keeping deep conversation URLs (/s/:space/devices/:dev/chats/:chat) intact.
  const isConversationRoute =
    parts[2] === "devices" && parts.length >= 5 && !!parts[3];
  const isDevicesTab = parts[2] === "devices" && !isConversationRoute;
  const section: "agents" | "tasks" | "devices" | "settings" =
    parts[2] === "tasks"
      ? "tasks"
      : parts[2] === "settings" || parts[2] === "me"
        ? "settings"
        : isDevicesTab
          ? "devices"
          : "agents";

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const path = "/api/spaces/" + space.id;
  const key = prefix + space.id;

  const go = (s: string) => {
    const next = base + "/" + s;
    setRoute(next);
    saveLocal(prefix + "route", next);
    if (transport.kind === "web" && location.pathname !== next)
      history.pushState(null, "", next);
    setError("");
  };

  useEffect(() => {
    if (transport.kind !== "web") return;
    const pop = () => setRoute(location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [transport]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [key] });
  };

  useEffect(() => {
    const sync = () => {
      void qc.invalidateQueries({ queryKey: [key] }, { cancelRefetch: false });
    };
    const wake = () => {
      if (document.visibilityState !== "hidden") sync();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    let alive = true;
    const openNotice = async () => {
      const n = await call<PushNotice | null>("Mobile.OpenedNotice");
      if (!alive || !n || n.hubId !== account.hub.id || n.spaceId !== space.id)
        return;
      const ids = [
        n.deviceId,
        n.chatId,
        n.sessionId,
        n.requestId,
        n.runId,
      ].filter(Boolean);
      if (!ids.every((id) => /^[\w-]{1,160}$/.test(id!))) return;
      const dest =
        base +
        "/devices/" +
        n.deviceId +
        "/chats/" +
        n.chatId +
        (n.sessionId ? "/topics/" + n.sessionId : "") +
        (n.requestId
          ? "/requests/" + n.requestId
          : n.runId
            ? "/runs/" + n.runId
            : "");
      setRoute(dest);
      saveLocal(prefix + "route", dest);
      sync();
    };
    const watch = () => {
      void call("Mobile.Watch", document.visibilityState !== "hidden").catch(
        () => {},
      );
    };
    let off: (() => void) | undefined;
    if (transport.kind === "mobile") {
      off = on<string>("lever:mobile-changed", (reason) => {
        if (reason === "unpaired") {
          clearSaved(account.hub.id, account.userId);
          qc.clear();
          void qc.invalidateQueries({ queryKey: ["me"] });
          window.location.reload();
        } else if (reason === "opened") void openNotice().catch(() => {});
        else wake();
      });
      watch();
      void openNotice().catch(() => {});
      document.addEventListener("visibilitychange", watch);
    }
    const stream =
      transport.kind === "web" ? new EventSource(path + "/events") : undefined;
    if (stream) stream.onmessage = sync;
    const timer = setInterval(wake, stream ? 60000 : 4000);
    return () => {
      alive = false;
      off?.();
      if (transport.kind === "mobile") {
        document.removeEventListener("visibilitychange", watch);
        void call("Mobile.Watch", false).catch(() => {});
      }
      window.removeEventListener("online", wake);
      stream?.close();
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [
    key,
    path,
    qc,
    transport,
    account.hub.id,
    account.userId,
    space.id,
    base,
    prefix,
  ]);

  const ws: Workspace = {
    transport,
    path,
    key,
    origin: origin ?? location.origin,
    refresh,
    go,
    act: async (fn) => {
      setBusy(true);
      setError("");
      try {
        await fn();
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
  };

  const native = transport.kind !== "web";
  const cachedQuery = <T,>(resource: string) => ({
    queryKey: [key, resource],
    initialData: native
      ? readLocal<T | undefined>(key + ":" + resource, undefined)
      : undefined,
    initialDataUpdatedAt: 0,
    queryFn: async () => {
      const value = await transport.request<T>(path + "/" + resource);
      if (native) saveLocal(key + ":" + resource, value);
      return value;
    },
  });

  const devices = useQuery(cachedQuery<Device[]>("devices"));
  const publicIndex = (index: Record<string, Shared[]>) =>
    Object.fromEntries(
      Object.entries(index).map(([id, rows]) => [
        id,
        rows.filter((v) => !v.private),
      ]),
    );
  const archive = useQuery({
    queryKey: [key, "index", devices.data?.map((d) => d.id)],
    enabled: !!devices.data,
    initialData: native
      ? () =>
          publicIndex(readLocal<Record<string, Shared[]>>(key + ":index", {}))
      : undefined,
    initialDataUpdatedAt: 0,
    queryFn: async ({ signal }) => {
      const entries = await Promise.all(
        (devices.data ?? [])
          .filter((d) => d.role !== "controller")
          .map(async (d) => {
            const previous =
              savedArchive(key, d.id)?.records ??
              readLocal<Shared[]>(key + ":index:" + d.id, []).filter(
                (v) => !v.private,
              );
            const shared = fetchArchive(
              qc,
              transport,
              key,
              path,
              d.id,
              "",
              signal,
            ).then((v) => v.records);
            const privateRows =
              native && !d.revoked
                ? transport
                    .request<Shared[]>(path + "/private-archive/" + d.id)
                    .catch(() => [])
                : Promise.resolve([]);
            const records = [
              ...(await shared.catch((e) => {
                if (!native) throw e;
                return previous.filter((v) => !v.private);
              })),
              ...(await privateRows),
            ];
            return [d.id, records] as const;
          }),
      );
      const result = Object.fromEntries(entries);
      if (native) saveLocal(key + ":index", publicIndex(result));
      return result;
    },
  });
  const tasks = useQuery(cachedQuery<Task[]>("tasks"));

  const resourceError =
    devices.error ??
    archive.error ??
    (section === "tasks" ? tasks.error : null);
  const hubOffline = !error && resourceError?.message === "暂时无法连接 Hub";
  const list = devices.data ?? [];
  const index = archive.data ?? {};

  const [search, setSearch] = useSavedFilter(
    key + ":" + section + ":search",
    "",
  );
  const [filter, setFilter] = useSavedFilter(key + ":task-filter", "");
  const [deviceFilter, setDeviceFilter] = useSavedFilter(
    key + ":device-filter",
    "",
  );
  const [unread, setUnread] = useSavedFilter(key + ":unread", false);
  const listScroll = useSavedScroll(key + ":" + section + ":scroll");
  const detailScroll = useSavedScroll(key + ":" + route + ":scroll");

  const taskId = section === "tasks" ? parts[3] : undefined;
  const device = isConversationRoute
    ? list.find((d) => d.id === parts[3])
    : undefined;
  const privateChat = isConversationRoute && parts[4] === "private";
  const chat =
    isConversationRoute && (parts[4] === "chats" || privateChat)
      ? parts[5]
      : undefined;
  const agent =
    isConversationRoute && parts[4] === "agents" ? parts[5] : undefined;

  const activeAgentId = useMemo(() => {
    if (!device) return undefined;
    if (agent) return agent;
    if (chat) {
      return (index[device.id] ?? []).find(
        (v) => v.kind === "chat" && v.id === chat,
      )?.agentId;
    }
    return undefined;
  }, [device, agent, chat, index]);

  // Build unified WeChat/Feishu-style Agent IM list across all paired devices.
  const agentRows = useMemo<AgentRowItem[]>(() => {
    const rows: AgentRowItem[] = [];
    for (const d of list.filter((x) => x.role !== "controller")) {
      const records = index[d.id] ?? [];
      const agentsMap = new Map<string, Shared>();
      const chatsByAgent = new Map<string, Shared[]>();
      const sessionsByChat = new Map<string, Shared[]>();

      for (const r of records) {
        if (r.kind === "agent") {
          agentsMap.set(r.id, r);
        } else if (r.kind === "chat") {
          const aid = r.agentId || "__chat:" + r.id;
          const arr = chatsByAgent.get(aid) ?? [];
          arr.push(r);
          chatsByAgent.set(aid, arr);
        } else if (r.kind === "session" && r.chatId) {
          const arr = sessionsByChat.get(r.chatId) ?? [];
          arr.push(r);
          sessionsByChat.set(r.chatId, arr);
        }
      }

      const allAgentIds = new Set<string>([
        ...agentsMap.keys(),
        ...chatsByAgent.keys(),
      ]);

      for (const aid of allAgentIds) {
        const a = agentsMap.get(aid);
        const chats = [...(chatsByAgent.get(aid) ?? [])].sort((x, y) => {
          const tx = Date.parse(x.updatedAt || x.createdAt || "") || 0;
          const ty = Date.parse(y.updatedAt || y.createdAt || "") || 0;
          return ty - tx;
        });
        const latestChat = chats[0];
        let unreadCount = 0;
        for (const c of chats) {
          for (const s of sessionsByChat.get(c.id) ?? []) {
            if ((s.unreadSequence ?? 0) > readLocal(key + d.id + s.id, 0)) {
              unreadCount += 1;
            }
          }
        }
        const sortTime = latestChat
          ? Date.parse(latestChat.updatedAt || latestChat.createdAt || "") || 0
          : 0;
        const name = a?.title || latestChat?.title || "本地对话";
        const preview = latestChat
          ? latestChat.title || "未命名对话"
          : [a?.model || a?.provider, "点击开始新对话"]
              .filter(Boolean)
              .join(" · ");
        rows.push({
          key: d.id + ":" + aid,
          device: d,
          agentId: aid,
          name,
          avatar: a?.avatar,
          model: a?.model,
          provider: a?.provider,
          latestChat,
          chatCount: chats.length,
          unreadCount,
          sortTime,
          timeText: formatChatTime(
            latestChat?.updatedAt || latestChat?.createdAt,
          ),
          preview,
          isPrivate: !!latestChat?.private,
        });
      }
    }

    return rows.sort((a, b) => {
      if (a.sortTime !== b.sortTime) return b.sortTime - a.sortTime;
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      if (a.device.online !== b.device.online) return a.device.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [list, index, key]);

  const totalUnread = useMemo(
    () => agentRows.reduce((sum, row) => sum + row.unreadCount, 0),
    [agentRows],
  );

  const currentAgentUnread = useMemo(() => {
    if (!device || !activeAgentId) return 0;
    return (
      agentRows.find(
        (r) => r.device.id === device.id && r.agentId === activeAgentId,
      )?.unreadCount ?? 0
    );
  }, [agentRows, device, activeAgentId]);

  const filteredAgentRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agentRows.filter((row) => {
      if (unread && row.unreadCount === 0) return false;
      if (!q) return true;
      if (
        row.name.toLowerCase().includes(q) ||
        row.device.name.toLowerCase().includes(q) ||
        row.preview.toLowerCase().includes(q)
      ) {
        return true;
      }
      const records = index[row.device.id] ?? [];
      return records.some(
        (r) =>
          r.kind === "chat" &&
          r.agentId === row.agentId &&
          (r.title ?? "").toLowerCase().includes(q),
      );
    });
  }, [agentRows, search, unread, index]);

  const attentionTasks = useMemo(
    () =>
      (tasks.data ?? []).filter(
        (t) => t.status === "review" || t.status === "attention",
      ).length,
    [tasks.data],
  );

  const onlineExecutors = list.filter(
    (d) => d.role !== "controller" && d.online && !d.revoked,
  ).length;

  const hasSidebar = section === "agents" || section === "tasks";
  const detail = !!(
    taskId ||
    device ||
    section === "devices" ||
    section === "settings"
  );
  const inImmersiveChat = !!(device && (chat || agent));
  const [collapsed, setCollapsed] = useState(false);

  const navItems: {
    id: "agents" | "tasks" | "devices" | "settings";
    label: string;
    icon: typeof MessageCircle;
    badge?: number;
  }[] = [
    {
      id: "agents",
      label: "对话",
      icon: MessageCircle,
      badge: totalUnread,
    },
    {
      id: "tasks",
      label: isMobileUI ? "任务" : "Tasks",
      icon: ListTodo,
      badge: attentionTasks,
    },
    {
      id: "devices",
      label: "设备",
      icon: MonitorSmartphone,
    },
    {
      id: "settings",
      label: isMobileUI ? "我" : "设置",
      icon: isMobileUI ? User : Settings,
    },
  ];

  const openAgentRow = (row: AgentRowItem) => {
    if (row.latestChat) {
      go(
        "devices/" +
          row.device.id +
          (row.latestChat.private ? "/private/" : "/chats/") +
          row.latestChat.id,
      );
    } else {
      go("devices/" + row.device.id + "/agents/" + row.agentId);
    }
  };

  return (
    <main
      className="hub-shell"
      data-section={section}
      data-has-sidebar={hasSidebar}
      data-detail={detail}
      data-immersive={inImmersiveChat}
      data-collapsed={collapsed}
      aria-busy={busy}
    >
      {/* Primary Navigation: Bottom Tab Bar on Mobile / Left Rail on Desktop */}
      <nav aria-label="工作区" className="hub-nav">
        <div className="hub-nav-brand">
          <LeverMark size={28} />
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = item.id === section;
          return (
            <button
              type="button"
              key={item.id}
              className="hub-nav-btn"
              data-active={active || undefined}
              aria-current={active ? "page" : undefined}
              onClick={() => go(item.id)}
            >
              <span className="relative inline-flex items-center justify-center">
                <Icon className="size-[20px]" strokeWidth={active ? 2.2 : 1.75} />
                {!!item.badge && item.badge > 0 && (
                  <span className="hub-nav-badge" aria-hidden="true">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                )}
              </span>
              <span className="hub-nav-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Secondary Pane: WeChat/Feishu IM Agents List OR Tasks List */}
      {hasSidebar && (
        <aside className="hub-aside" ref={listScroll}>
          <header className="hub-aside-header">
            {section === "agents" ? (
              <>
                <button
                  type="button"
                  className="hub-conn-pill hub-mobile-only"
                  onClick={() => go("devices")}
                >
                  <span
                    className={`size-2 rounded-full ${
                      hubOffline
                        ? "bg-muted-foreground/50"
                        : onlineExecutors > 0
                          ? "bg-emerald-500"
                          : "bg-amber-500"
                    }`}
                  />
                  <span>
                    {hubOffline
                      ? "离线"
                      : onlineExecutors > 0
                        ? `${onlineExecutors} 台在线`
                        : "已连接"}
                  </span>
                </button>
                <h2 className="hub-aside-title">
                  Lever
                  {totalUnread > 0 && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
                      ({totalUnread})
                    </span>
                  )}
                </h2>
              </>
            ) : (
              <h2 className="hub-aside-title">
                {isMobileUI ? "任务" : "Tasks"}
              </h2>
            )}

            <div className="flex items-center gap-1">
              {section === "agents" ? (
                <Popover open={plusMenuOpen} onOpenChange={setPlusMenuOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="快捷操作"
                    >
                      <CirclePlus className="size-[18px]" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-44 p-1.5">
                    <button
                      type="button"
                      className="hub-menu-item"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        go("devices/pair");
                      }}
                    >
                      <QrCode className="size-4 text-muted-foreground" />
                      <span>配对新设备</span>
                    </button>
                    <button
                      type="button"
                      className="hub-menu-item"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        go("tasks/new");
                      }}
                    >
                      <Plus className="size-4 text-muted-foreground" />
                      <span>新建共享任务</span>
                    </button>
                    <button
                      type="button"
                      className="hub-menu-item"
                      onClick={() => {
                        setUnread(!unread);
                        setPlusMenuOpen(false);
                      }}
                    >
                      <Check
                        className={`size-4 ${unread ? "text-foreground" : "opacity-0"}`}
                      />
                      <span>仅看未读</span>
                    </button>
                    <button
                      type="button"
                      className="hub-menu-item"
                      onClick={() => {
                        refresh();
                        setPlusMenuOpen(false);
                      }}
                    >
                      <RefreshCw className="size-4 text-muted-foreground" />
                      <span>刷新同步</span>
                    </button>
                  </PopoverContent>
                </Popover>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => go("tasks/new")}
                >
                  <Plus data-icon="inline-start" className="size-3.5" />
                  新建任务
                </Button>
              )}

              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="hub-desktop-only"
                onClick={() => setCollapsed(!collapsed)}
                aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
              >
                {collapsed ? (
                  <ChevronRight className="size-4" />
                ) : (
                  <ChevronLeft className="size-4" />
                )}
              </Button>
            </div>
          </header>

          {!collapsed && (
            <>
              {/* Search Bar */}
              <div className="px-3 pb-2.5">
                <div className="hub-search-box">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    type="search"
                    aria-label="搜索"
                    placeholder={
                      section === "tasks" ? "搜索任务" : "搜索"
                    }
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      type="button"
                      aria-label="清空搜索"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setSearch("")}
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>

                {section === "agents" && unread && (
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>已筛选：仅未读</span>
                    <button
                      type="button"
                      className="text-foreground underline-offset-2 hover:underline"
                      onClick={() => setUnread(false)}
                    >
                      显示全部
                    </button>
                  </div>
                )}

                {section === "tasks" && (
                  <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
                    {[
                      ["", "全部"],
                      ["todo", "待办"],
                      ["running", "进行中"],
                      ["attention", "需处理"],
                      ["review", "待验收"],
                      ["done", "已完成"],
                    ].map(([val, text]) => (
                      <button
                        type="button"
                        key={val || "all"}
                        data-active={filter === val || undefined}
                        className="hub-filter-chip"
                        onClick={() => setFilter(val)}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Error / Offline banner inside mobile list too */}
              {(error || resourceError) && isMobileUI && (
                <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/60 px-3 py-2 text-xs">
                  <span className={hubOffline ? "text-muted-foreground" : "text-destructive"}>
                    {hubOffline
                      ? "Hub 离线 · 显示本地缓存"
                      : error || resourceError?.message}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={refresh}
                  >
                    刷新
                  </Button>
                </div>
              )}

              {/* Content List */}
              <div className="flex-1 overflow-y-auto">
                {section === "agents" ? (
                  filteredAgentRows.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
                      <LeverMark size={44} />
                      <div className="flex flex-col gap-1">
                        <div className="text-[14px] font-medium">
                          {list.length === 0
                            ? "还没有已配对的电脑"
                            : search || unread
                              ? "没有匹配的 Agent"
                              : "暂无已开放的 Agent"}
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {list.length === 0
                            ? "先在设备页生成配对码，将你的工作电脑接入此空间。"
                            : search || unread
                              ? "尝试更换关键词或清除未读筛选。"
                              : "请在电脑端 Lever「设置 → 远程与设备」开放 Agent。"}
                        </p>
                      </div>
                      {list.length === 0 && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => go("devices/pair")}
                        >
                          <QrCode data-icon="inline-start" />
                          添加第一台设备
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="hub-im-list">
                      {filteredAgentRows.map((row) => {
                        const isSelected =
                          device?.id === row.device.id &&
                          activeAgentId === row.agentId;
                        return (
                          <button
                            type="button"
                            key={row.key}
                            data-selected={isSelected || undefined}
                            className="hub-im-row"
                            onClick={() => openAgentRow(row)}
                          >
                            <div className="relative shrink-0">
                              <HubAgentAvatar
                                id={row.agentId}
                                name={row.name}
                                avatar={row.avatar}
                                size="md"
                              />
                              {row.unreadCount > 0 && (
                                <span className="hub-im-unread">
                                  {row.unreadCount > 99
                                    ? "99+"
                                    : row.unreadCount}
                                </span>
                              )}
                            </div>
                            <div className="hub-im-body">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-[15px] font-medium text-foreground">
                                    {row.name}
                                  </span>
                                  <span className="hub-device-tag">
                                    <span
                                      className={`size-1.5 rounded-full ${
                                        row.device.online && !row.device.revoked
                                          ? "bg-emerald-500"
                                          : "bg-muted-foreground/45"
                                      }`}
                                    />
                                    <span className="max-w-20 truncate">
                                      {row.device.name}
                                    </span>
                                  </span>
                                </div>
                                {row.timeText && (
                                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                                    {row.timeText}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-[13px] text-muted-foreground">
                                  {row.unreadCount > 0 && (
                                    <span className="mr-1 font-medium text-destructive">
                                      [{row.unreadCount}条未读]
                                    </span>
                                  )}
                                  {row.isPrivate && (
                                    <span className="mr-1 inline-flex items-center gap-0.5 text-foreground/75">
                                      <Lock className="inline size-3" />
                                      [仅局域网]
                                    </span>
                                  )}
                                  {row.preview}
                                </span>
                                {row.chatCount > 1 && (
                                  <span className="shrink-0 text-[11px] text-muted-foreground/80 tabular-nums">
                                    {row.chatCount} 对话
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-1.5 px-3 pb-4">
                    {(tasks.data ?? [])
                      .filter(
                        (t) =>
                          (!filter || t.status === filter) &&
                          t.title.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((t) => (
                        <button
                          type="button"
                          key={t.id}
                          data-selected={taskId === t.id || undefined}
                          className="hub-task-row"
                          onClick={() => go("tasks/" + t.id)}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="line-clamp-2 text-[14px] font-medium">
                              {t.title}
                            </span>
                            <Badge
                              variant={
                                t.status === "review" ||
                                t.status === "attention"
                                  ? "default"
                                  : "outline"
                              }
                              className="shrink-0"
                            >
                              {label(t.status)}
                            </Badge>
                          </div>
                          {(t.project || t.deviceId) && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {t.project && <span>{t.project}</span>}
                              {t.deviceId && (
                                <span className="truncate">
                                  {list.find((d) => d.id === t.deviceId)?.name}
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                      ))}
                    {(tasks.data ?? []).length === 0 && (
                      <div className="py-10 text-center text-xs text-muted-foreground">
                        暂无共享任务
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      )}

      {/* Main Content Pane */}
      <article className="hub-main" ref={detailScroll}>
        {account.spaces.length > 1 && !inImmersiveChat && (
          <div className="flex items-center justify-end border-b border-border px-4 py-2">
            <select
              aria-label="空间"
              className="hub-mini-select"
              value={space.id}
              onChange={(e) => {
                const next = "/s/" + e.target.value + "/" + section;
                setRoute(next);
                saveLocal(prefix + "route", next);
              }}
            >
              {account.spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {(error || resourceError) && !isMobileUI && (
          <div
            className={`mx-4 mt-3 flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs ${
              hubOffline
                ? "border-border bg-muted/50 text-muted-foreground"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
            role={hubOffline ? "status" : "alert"}
          >
            <span>
              {hubOffline ? "Hub 离线" : error || resourceError?.message}
            </span>
            <Button type="button" size="xs" variant="ghost" onClick={refresh}>
              刷新
            </Button>
          </div>
        )}

        {section === "devices" ? (
          <DevicesPanel
            ws={ws}
            devices={list}
            ownDevice={account.deviceId}
            spaceName={space.name}
            initialPairOpen={parts[3] === "pair"}
          />
        ) : section === "settings" ? (
          <ProfilePanel
            ws={ws}
            logout={onLogout}
            browser={!!account.sessionId}
            ownDevice={account.deviceId}
            spaceName={space.name}
            theme={theme}
            onThemeChange={onThemeChange}
          />
        ) : section === "tasks" ? (
          taskId === "new" ? (
            <NewTask key={parts[4] ?? "new"} ws={ws} draftId={parts[4]} />
          ) : taskId ? (
            <TaskDetail
              key={taskId}
              ws={ws}
              id={taskId}
              devices={list}
              index={index}
            />
          ) : (
            <div className="hub-pane-scroll">
              <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-[20px] font-semibold tracking-tight">
                    任务看板
                  </h1>
                  <select
                    aria-label="执行设备"
                    className="hub-mini-select"
                    value={deviceFilter}
                    onChange={(e) => setDeviceFilter(e.target.value)}
                  >
                    <option value="">全部设备</option>
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="hub-board">
                  {[
                    "todo",
                    "running",
                    "attention",
                    "review",
                    "done",
                    "closed",
                  ].map((s) => {
                    const colTasks = (tasks.data ?? []).filter(
                      (t) =>
                        t.status === s &&
                        (!deviceFilter ||
                          t.deviceId === deviceFilter ||
                          (!t.deviceId &&
                            (index[deviceFilter] ?? []).some(
                              (v) => v.taskId === t.id,
                            ))),
                    );
                    return (
                      <section
                        key={s}
                        className="flex flex-col gap-2 rounded-xl border border-border bg-muted/25 p-2.5"
                      >
                        <div className="flex items-center justify-between px-1">
                          <h3 className="text-xs font-semibold text-muted-foreground">
                            {label(s)}
                          </h3>
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {colTasks.length}
                          </span>
                        </div>
                        {colTasks.map((t) => (
                          <button
                            type="button"
                            key={t.id}
                            className="rounded-lg border border-border bg-card px-2.5 py-2 text-left text-[13px] font-medium transition-colors outline-none hover:bg-control-hover focus-visible:bg-control-focus"
                            onClick={() => go("tasks/" + t.id)}
                          >
                            <span className="line-clamp-2">{t.title}</span>
                          </button>
                        ))}
                      </section>
                    );
                  })}
                </div>
              </div>
            </div>
          )
        ) : device && (chat || agent) ? (
          <Conversation
            key={[device.id, chat, agent, parts[6], parts[7]].join("/")}
            ws={ws}
            device={device}
            chat={chat}
            privateChat={privateChat}
            agent={agent}
            session={parts[6] === "topics" ? parts[7] : undefined}
            target={
              ["requests", "runs"].includes(parts.at(-2) ?? "")
                ? parts.at(-1)
                : undefined
            }
            index={index[device.id] ?? []}
            otherUnreadCount={Math.max(0, totalUnread - currentAgentUnread)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <LeverMark size={52} />
            <div className="flex flex-col gap-1">
              <h1 className="text-[18px] font-semibold">Lever</h1>
              <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                {agentRows.length
                  ? "在左侧选择一个 Agent 开始对话，或查看历史 Chat 与话题。"
                  : "配对执行设备并在桌面端开放 Agent 后，即可在这里随时对话。"}
              </p>
            </div>
            {list.length === 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => go("devices/pair")}
              >
                <QrCode data-icon="inline-start" />
                配对第一台设备
              </Button>
            )}
          </div>
        )}
      </article>
    </main>
  );
}

export const statuses: Record<string, string> = {
  closed: "已关闭",
  todo: "待办",
  running: "进行中",
  attention: "需处理",
  review: "待验收",
  done: "已完成",
  pending: "待设备确认",
  reviewing: "设备确认中",
  accepted: "已受理",
  completed: "执行完成",
  unknown: "待核实",
  interrupted: "已中断",
  failed: "失败",
  declined: "已拒绝",
  waiting_user: "等待回答",
  queued: "已排队",
  answered: "已回答",
  cancelled: "已取消",
};

export function label(s?: string) {
  return s ? (statuses[s] ?? s) : "";
}

export function deviceStatus(d: Device) {
  return d.revoked
    ? "已撤销"
    : d.draining
      ? "暂停接单"
      : d.online
        ? "在线"
        : "离线";
}

export async function submit(ws: Workspace, cmd: Command) {
  const k =
    ws.key + ":command:" + cmd.deviceId + ":" + (cmd.chatId || cmd.agentId);
  const hash = JSON.stringify(cmd);
  const prev = readLocal(k, { hash: "", id: "" });
  const id = hash === prev.hash ? prev.id : crypto.randomUUID();
  saveLocal(k, { hash, id });
  const result = await ws.transport.request<InboxItem>(
    ws.path + "/commands",
    "POST",
    {
      ...cmd,
      id,
    },
  );
  localStorage.removeItem(k);
  return result;
}
