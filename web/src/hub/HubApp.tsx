import { useEffect, useLayoutEffect, useRef, useMemo, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { call, on } from "mygo-runtime";
import {
  MonitorSmartphone,
  MessagesSquare,
  ListTodo,
  Settings,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/hooks/useTheme";
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
import { Devices } from "./Devices";
import { Conversation, type Command } from "./Conversation";
import { TaskDetail, NewTask } from "./Tasks";
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
function Entry({
  transport,
  origin,
}: {
  transport: Transport;
  origin?: string;
}) {
  useTheme();
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
  if (me.isLoading) return <main className="hub-login">正在连接 Hub…</main>;
  if (!me.data)
    return (
      <main className="hub-login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(async () => {
              if (transport.kind === "mobile") {
                await pairPhone(link);
                // Only prompt automatically after the user pairs a phone.
                // Existing installs and a later change of mind use Settings.
                const account = await transport.request<Account>("/api/me");
                const status = await transport
                  .request<{
                    available: boolean;
                  }>("/api/spaces/" + account.spaces[0].id + "/push")
                  .catch(() => null);
                if (status?.available)
                  void call("Mobile.SetPush", true).catch(() => {});
              } else
                await transport.request("/api/login", "POST", {
                  name: f.get("user"),
                  password: f.get("password"),
                });
              await qc.invalidateQueries({ queryKey: ["me"] });
            });
          }}
        >
          <MonitorSmartphone size={28} />
          <h1>{transport.kind === "mobile" ? "配对设备" : "登录 Lever Hub"}</h1>
          {transport.kind === "mobile" ? (
            <>
              <ScanPairing onLink={setLink} />
              <label>
                配对链接
                <Input
                  aria-label="配对链接"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <>
              <label>
                账号
                <Input
                  name="user"
                  autoComplete="username"
                  defaultValue="admin"
                  required
                />
              </label>
              <label>
                密码
                <Input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </label>
            </>
          )}
          <Button disabled={busy}>
            {transport.kind === "mobile" ? "配对" : "登录"}
          </Button>
          {error && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  return (
    <Workbench
      key={me.data.hub.id + me.data.userId}
      account={me.data}
      transport={transport}
      origin={origin ?? me.data.origin}
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
function Workbench({
  account,
  transport,
  origin,
  onLogout,
}: {
  account: Account;
  transport: Transport;
  origin?: string;
  onLogout: () => void;
}) {
  const qc = useQueryClient();
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
  const section =
    parts[2] === "tasks"
      ? "tasks"
      : parts[2] === "settings"
        ? "settings"
        : "agents";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
  const device =
    parts[2] === "devices" ? list.find((d) => d.id === parts[3]) : undefined;
  const privateChat = parts[4] === "private";
  const chat = parts[4] === "chats" || privateChat ? parts[5] : undefined;
  const agent = parts[4] === "agents" ? parts[5] : undefined;
  const detail = !!(taskId || device || section === "settings");
  const sectionName = { agents: "Agents", tasks: "Tasks", settings: "设置" };
  const [collapsed, setCollapsed] = useState(false);
  const actions = (["agents", "tasks", "settings"] as const).map((v, j) => {
    const Icon = [MessagesSquare, ListTodo, Settings][j];
    return (
      <Button
        type="button"
        key={v}
        variant={v === section ? "secondary" : "ghost"}
        onClick={() => go(v)}
        aria-current={v === section ? "page" : undefined}
      >
        <Icon size={18} />
        {sectionName[v]}
      </Button>
    );
  });
  return (
    <main
      className="hub-shell"
      data-section={section}
      data-detail={detail}
      data-collapsed={collapsed}
      aria-busy={busy}
    >
      <nav aria-label="工作区">{actions}</nav>
      {section !== "settings" && (
        <aside ref={listScroll}>
          <header>
            <h2>{sectionName[section]}</h2>
            <Button
              variant="ghost"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
            >
              {collapsed ? "›" : "‹"}
            </Button>
          </header>
          {!collapsed && (
            <>
              <Input
                aria-label="搜索"
                placeholder={
                  section === "tasks" ? "搜索任务" : "搜索设备 / Agent"
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {section === "agents" ? (
                <>
                  <label className="hub-check">
                    <input
                      type="checkbox"
                      checked={unread}
                      onChange={(e) => setUnread(e.target.checked)}
                    />
                    仅未读
                  </label>
                  {list
                    .filter((d) => d.role !== "controller")
                    .map((d) => {
                      const records = index[d.id] ?? [];
                      const needle = search.toLowerCase();
                      const agents = records.filter(
                        (v) =>
                          v.kind === "agent" &&
                          (d.name + " " + v.title)
                            .toLowerCase()
                            .includes(needle),
                      );
                      const chats = records.filter(
                        (v) =>
                          v.kind === "chat" &&
                          ((v.title ?? "").toLowerCase().includes(needle) ||
                            agents.some((a) => a.id === v.agentId)) &&
                          (!unread ||
                            records.some(
                              (s) =>
                                s.kind === "session" &&
                                s.chatId === v.id &&
                                (s.unreadSequence ?? 0) >
                                  readLocal(key + d.id + s.id, 0),
                            )),
                      );
                      if (!agents.length && !chats.length && search)
                        return null;
                      return (
                        <section key={d.id}>
                          <h3>
                            {d.name} <small>{deviceStatus(d)}</small>
                          </h3>
                          {agents.map((a) => (
                            <button
                              key={a.id}
                              onClick={() =>
                                go("devices/" + d.id + "/agents/" + a.id)
                              }
                            >
                              {a.title}
                            </button>
                          ))}
                          {chats.map((c) => (
                            <button
                              className="hub-chat-link"
                              key={c.id}
                              onClick={() =>
                                go(
                                  "devices/" +
                                    d.id +
                                    (c.private ? "/private/" : "/chats/") +
                                    c.id,
                                )
                              }
                            >
                              {c.title}
                              {c.private && <small>仅局域网</small>}
                            </button>
                          ))}
                        </section>
                      );
                    })}
                  {list.length === 0 && (
                    <Button variant="outline" onClick={() => go("settings")}>
                      添加第一台设备
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button onClick={() => go("tasks/new")}>新建任务</Button>
                  <select
                    aria-label="任务状态"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(statuses)
                      .filter(([s]) =>
                        [
                          "todo",
                          "running",
                          "review",
                          "attention",
                          "done",
                          "closed",
                        ].includes(s),
                      )
                      .map(([s, v]) => (
                        <option key={s} value={s}>
                          {v}
                        </option>
                      ))}
                  </select>
                  {(tasks.data ?? [])
                    .filter(
                      (t) =>
                        (!filter || t.status === filter) &&
                        t.title.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((t) => (
                      <button key={t.id} onClick={() => go("tasks/" + t.id)}>
                        {t.title}
                        <small>{label(t.status)}</small>
                      </button>
                    ))}
                </>
              )}
            </>
          )}
        </aside>
      )}
      <article ref={detailScroll}>
        <header>
          {section !== "settings" && (
            <Button
              className="hub-back"
              variant="ghost"
              onClick={() => go(section)}
            >
              <ArrowLeft size={16} />
              返回
            </Button>
          )}
          {account.spaces.length > 1 && (
            <select
              aria-label="空间"
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
          )}
        </header>
        {(error || resourceError) && (
          <p
            className={hubOffline ? undefined : "hub-error"}
            role={hubOffline ? "status" : "alert"}
          >
            {hubOffline ? "Hub 离线" : error || resourceError?.message}{" "}
            <Button variant="ghost" onClick={refresh}>
              刷新
            </Button>
          </p>
        )}
        {section === "settings" ? (
          <Devices
            ws={ws}
            devices={list}
            logout={onLogout}
            browser={!!account.sessionId}
            ownDevice={account.deviceId}
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
            <>
              <h1>任务看板</h1>
              <select
                aria-label="执行设备"
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
              <div className="hub-board">
                {[
                  "todo",
                  "running",
                  "attention",
                  "review",
                  "done",
                  "closed",
                ].map((s) => (
                  <section key={s}>
                    <h3>{label(s)}</h3>
                    {(tasks.data ?? [])
                      .filter(
                        (t) =>
                          t.status === s &&
                          (!deviceFilter ||
                            t.deviceId === deviceFilter ||
                            (!t.deviceId &&
                              (index[deviceFilter] ?? []).some(
                                (v) => v.taskId === t.id,
                              ))),
                      )
                      .map((t) => (
                        <Button
                          key={t.id}
                          variant="outline"
                          onClick={() => go("tasks/" + t.id)}
                        >
                          {t.title}
                        </Button>
                      ))}
                  </section>
                ))}
              </div>
            </>
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
          />
        ) : (
          <>
            <h1>Agents</h1>
            <p>
              {list.length
                ? "选择设备上的 Agent 或共享对话。"
                : "配对执行设备后，在该设备的 Lever 设置中开放 Agent。"}
            </p>
          </>
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
