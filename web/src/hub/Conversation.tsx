import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileDiff,
  Hash,
  History,
  ListPlus,
  Lock,
  MessageSquarePlus,
  SendHorizontal,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { fetchArchive, savedArchive } from "./archive";
import type {
  Answer,
  Device,
  InboxItem,
  Intent,
  Record as Shared,
} from "@/api/hub.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { label, submit, type Workspace } from "./HubApp";
import { readLocal, saveLocal } from "./client";
import { createTaskFromChat } from "./Tasks";
import { formatChatTime, HubAgentAvatar } from "./ui";

export type Command = Omit<Intent, "id">;

function Card({
  q,
  onAnswer,
  disabled,
}: {
  q: Shared;
  onAnswer: (a: Answer | "allow_run") => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (q.questions ?? [])
        .filter((v) => v.initialAnswer)
        .map((v) => [v.id, v.initialAnswer!]),
    ),
  );
  const isPending = q.status === "pending";
  const resolvedAnswers = (): Record<string, string[]> | null => {
    const out: Record<string, string[]> = {};
    for (const v of q.questions ?? []) {
      const allowCustom = v.allowCustom !== false;
      const text = allowCustom ? (custom[v.id] ?? "").trim() : "";
      if (text) {
        out[v.id] = [text];
        continue;
      }
      const choices = selected[v.id] ?? [];
      if (choices.length) {
        out[v.id] = choices;
        continue;
      }
      if (v.required === false) {
        if (v.multiple) out[v.id] = [];
        continue;
      }
      return null;
    }
    return out;
  };
  const submitAnswers = q.type === "question" ? resolvedAnswers() : null;
  return (
    <section
      className={`hub-approval-card ${isPending ? "hub-approval-pending" : "hub-approval-done"}`}
      id={"hub-record-" + q.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold">
          {isPending ? (
            <ShieldAlert className="size-4 shrink-0 text-amber-500" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
          )}
          <span>{q.title || (q.type === "question" ? "需要回答" : "请求审批")}</span>
        </div>
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
          {label(q.status)}
        </span>
      </div>
      {q.text && (
        <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {q.text}
        </p>
      )}
      {!isPending ? (
        <div className="mt-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{label(q.status)}</span>
          {q.answeredByUserId && <span> · {q.answeredByUserId}</span>}
          {" · "}
          {q.type === "question" && q.answer?.answers
            ? Object.values(q.answer.answers).flat().join("，")
            : (q.answer?.optionId ??
              (q.answer?.allow ? "已允许" : q.answer ? "已拒绝" : ""))}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {q.questions?.map((v) => {
            const allowCustom = v.allowCustom !== false;
            const customVal = custom[v.id] ?? "";
            const choices = customVal.trim() ? [] : (selected[v.id] ?? []);
            return (
              <fieldset key={v.id} className="flex flex-col gap-1.5">
                <legend className="mb-1 text-[13px] font-medium text-foreground">
                  {v.header && v.header !== v.text ? `${v.header} · ` : ""}
                  {v.text}
                  {v.required === false && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      (可选)
                    </span>
                  )}
                </legend>
                {v.options?.map((o) => (
                  <label
                    className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] hover:bg-control-hover"
                    key={o.id}
                  >
                    <input
                      type={v.multiple ? "checkbox" : "radio"}
                      name={v.id}
                      className="mt-0.5"
                      checked={choices.includes(o.id)}
                      onChange={(e) => {
                        setCustom((prev) => ({ ...prev, [v.id]: "" }));
                        setSelected((prev) => ({
                          ...prev,
                          [v.id]: e.target.checked
                            ? [
                                ...(v.multiple ? (prev[v.id] ?? []) : []),
                                o.id,
                              ]
                            : (prev[v.id] ?? []).filter((id) => id !== o.id),
                        }));
                      }}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span>{o.name}</span>
                      {o.description && o.description !== o.name && (
                        <span className="text-xs text-muted-foreground">
                          {o.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {allowCustom && (
                  <Input
                    type={v.secret ? "password" : "text"}
                    value={customVal}
                    placeholder={
                      v.placeholder ||
                      (v.options?.length ? "或输入其他回答…" : "输入回答…")
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustom((prev) => ({ ...prev, [v.id]: val }));
                      if (val.trim()) {
                        setSelected((prev) => ({ ...prev, [v.id]: [] }));
                      }
                    }}
                  />
                )}
              </fieldset>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            {q.type === "question" ? (
              <>
                <Button
                  size="sm"
                  disabled={disabled || !submitAnswers}
                  onClick={() =>
                    submitAnswers &&
                    onAnswer({ allow: true, answers: submitAnswers })
                  }
                >
                  提交回答
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onAnswer({ allow: false, answers: {} })}
                >
                  忽略
                </Button>
              </>
            ) : (
              <>
                {q.options?.length ? (
                  q.options.map((v) => (
                    <Button
                      key={v.id}
                      size="sm"
                      disabled={disabled}
                      variant={v.allow ? "default" : "outline"}
                      onClick={() =>
                        onAnswer({ allow: !!v.allow, optionId: v.id })
                      }
                    >
                      {v.name}
                    </Button>
                  ))
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() => onAnswer({ allow: true })}
                    >
                      允许一次
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => onAnswer({ allow: false })}
                    >
                      拒绝
                    </Button>
                  </>
                )}
                {q.allowOnce && (
                  <Button
                    size="sm"
                    disabled={disabled}
                    variant="ghost"
                    onClick={() => onAnswer("allow_run")}
                  >
                    允许本轮
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function Conversation({
  ws,
  device,
  chat,
  privateChat,
  agent,
  session,
  target,
  index,
  otherUnreadCount = 0,
}: {
  ws: Workspace;
  device: Device;
  chat?: string;
  privateChat: boolean;
  agent?: string;
  session?: string;
  target?: string;
  index: Shared[];
  otherUnreadCount?: number;
}) {
  const base =
    "devices/" + device.id + (privateChat ? "/private/" : "/chats/") + chat;
  const cached =
    ws.key + (privateChat ? ":private:" : ":archive:") + device.id + ":" + chat;
  const qc = useQueryClient();
  const native = ws.transport.kind !== "web";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: [ws.key, "chat", device.id, chat, privateChat],
    enabled: !!chat,
    refetchOnMount: target ? "always" : true,
    queryFn: async ({ signal }) => {
      if (!privateChat)
        return fetchArchive(
          qc,
          ws.transport,
          ws.key,
          ws.path,
          device.id,
          chat,
          signal,
        );
      const result = await ws.transport.request<Shared[]>(
        ws.path +
          "/private-archive/" +
          device.id +
          "?chat=" +
          encodeURIComponent(chat!),
      );
      return { records: result, at: Date.now(), cursor: undefined };
    },
  });

  const saved =
    !query.data && native && !privateChat
      ? savedArchive(ws.key, device.id, chat)
      : undefined;
  const lastSync = query.data?.at ?? saved?.at;
  const records =
    (privateChat && query.error ? undefined : query.data?.records) ??
    (native && !privateChat
      ? (saved?.records ?? readLocal<Shared[]>(cached, []))
      : []);

  const viewed = useRef("");
  const awaitingNotice =
    !!target && (!query.isFetchedAfterMount || query.isError);
  useEffect(() => {
    if (!target || query.isFetching || viewed.current === target) return;
    const element = document.getElementById("hub-record-" + target);
    if (element) {
      element.scrollIntoView({ block: "center" });
      viewed.current = target;
    }
  }, [target, query.dataUpdatedAt, query.isFetching]);

  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  const chatRecord =
    records.find((v) => v.kind === "chat") ??
    (chat ? index.find((v) => v.kind === "chat" && v.id === chat) : undefined);

  const resolvedAgentId = agent ?? chatRecord?.agentId ?? "";
  const agentRecord = index.find(
    (v) => v.kind === "agent" && v.id === resolvedAgentId,
  );
  const agentName = agentRecord?.title || "Agent";

  // All historical chats and their topics belonging to this Agent on this device.
  const agentChats = useMemo(() => {
    const list = index.filter(
      (v) => v.kind === "chat" && (!resolvedAgentId || v.agentId === resolvedAgentId),
    );
    return [...list].sort((x, y) => {
      const tx = Date.parse(x.updatedAt || x.createdAt || "") || 0;
      const ty = Date.parse(y.updatedAt || y.createdAt || "") || 0;
      return ty - tx;
    });
  }, [index, resolvedAgentId]);

  const sessionsByChat = useMemo(() => {
    const map = new Map<string, Shared[]>();
    for (const s of index) {
      if (s.kind !== "session" || !s.chatId) continue;
      const arr = map.get(s.chatId) ?? [];
      arr.push(s);
      map.set(s.chatId, arr);
    }
    return map;
  }, [index]);

  const sessions = records.filter((v) => v.kind === "session");
  const current = sessions.find((v) =>
    session ? v.id === session : v.type === "main",
  );
  const runs = records
    .filter(
      (v) => v.kind === "run" && v.sessionId === current?.id && !v.superseded,
    )
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const canSteer = runs.some((v) => v.canSteer && v.status === "running");

  const draftKey =
    ws.key +
    ":draft:" +
    device.id +
    ":" +
    (chat ?? agent) +
    ":" +
    (session ?? "main");
  const [draft, setDraft] = useState(() => readLocal(draftKey, ""));
  const [topic, setTopic] = useState(false);
  const receiptKey = draftKey + ":receipt";
  const [submitted, setSubmitted] = useState<InboxItem | undefined>(() =>
    readLocal(receiptKey, undefined),
  );
  const receipt = useQuery({
    queryKey: [ws.key, "receipt", device.id, submitted?.intent.id],
    enabled: !!submitted,
    queryFn: () =>
      ws.transport.request<InboxItem>(
        ws.path +
          (privateChat ? "/private-commands/" : "/commands/") +
          device.id +
          "/" +
          submitted!.intent.id,
      ),
    refetchInterval: (q) =>
      ["pending", "reviewing"].includes(
        (q.state.data ?? submitted)?.receipt.status ?? "",
      )
        ? 2000
        : false,
    initialData: submitted,
    initialDataUpdatedAt: 0,
  });
  const known = receipt.data ?? submitted;
  const remember = (item: InboxItem) => {
    setSubmitted(item);
    saveLocal(receiptKey, item);
  };
  useEffect(() => {
    if (
      known?.receipt.status !== "accepted" ||
      known.intent.kind !== "send" ||
      !known.receipt.chatId
    )
      return;
    if (
      !chat ||
      (known.intent.operation === "topic" &&
        known.receipt.sessionId !== session)
    ) {
      const next =
        "devices/" +
        device.id +
        (privateChat ? "/private/" : "/chats/") +
        known.receipt.chatId +
        (known.intent.operation === "topic" && known.receipt.sessionId
          ? "/topics/" + known.receipt.sessionId
          : "");
      localStorage.removeItem(receiptKey);
      ws.go(next);
    }
  }, [known, chat, session, device.id, privateChat, receiptKey, ws]);

  const [delivery, setDelivery] = useState("queue");
  const [group, setGroup] = useState("");

  const canSend =
    (!!agentRecord || privateChat) &&
    (device.online || ws.transport.kind !== "web") &&
    !device.revoked &&
    (!device.draining || !!chat);

  useEffect(() => {
    if (!current?.unreadSequence) return;
    const prev = Math.max(
      current.readSequence ?? 0,
      readLocal(ws.key + device.id + current.id, 0),
    );
    if (current.unreadSequence <= prev) return;
    saveLocal(ws.key + device.id + current.id, current.unreadSequence);
    void ws.transport
      .request(ws.path + "/read", "POST", {
        deviceId: device.id,
        items: [{ sessionId: current.id, sequence: current.unreadSequence }],
      })
      .catch(() => {});
  }, [
    current?.id,
    current?.readSequence,
    current?.unreadSequence,
    device.id,
    ws.key,
    ws.path,
    ws.transport,
  ]);

  const enqueue = (cmd: Command) =>
    ws.act(async () => {
      remember(await submit(ws, { ...cmd, private: privateChat || undefined }));
    });

  const routeLabel = privateChat
    ? "仅设备 · 局域网"
    : query.isError
      ? "离线缓存"
      : query.data?.cursor?.stream === "lan"
        ? "局域网直连"
        : "Hub 共享";

  const chatTitle = chat ? chatRecord?.title || "共享对话" : "新对话";

  const sendDraft = () => {
    if (!draft.trim() || !canSend) return;
    void ws.act(async () => {
      remember(
        await submit(ws, {
          private: privateChat || undefined,
          kind: "send",
          deviceId: device.id,
          chatId: chat,
          agentId: agent,
          sessionId: topic ? undefined : session,
          workingCopyId: group || undefined,
          operation: topic ? "topic" : session ? "reply" : "main",
          delivery: runs.some((v) =>
            ["starting", "running", "waiting_user"].includes(v.status ?? ""),
          )
            ? canSteer
              ? delivery
              : "queue"
            : undefined,
          text: draft,
        }),
      );
      setDraft("");
      localStorage.removeItem(draftKey);
    });
  };

  const filteredHistoryChats = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return agentChats;
    return agentChats.filter((c) => {
      if ((c.title ?? "").toLowerCase().includes(q)) return true;
      const ts = sessionsByChat.get(c.id) ?? [];
      return ts.some((s) => (s.title ?? "").toLowerCase().includes(q));
    });
  }, [agentChats, historySearch, sessionsByChat]);

  return (
    <div className="hub-chat-view">
      {/* Top IM Chat Header */}
      <header className="hub-chat-header">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="hub-mobile-only -ml-1.5 h-8 gap-1 px-2"
            onClick={() => ws.go("agents")}
            aria-label="返回对话列表"
          >
            <ArrowLeft className="size-4" />
            {otherUnreadCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums">
                {otherUnreadCount > 99 ? "99+" : otherUnreadCount}
              </span>
            )}
          </Button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors outline-none hover:bg-control-hover focus-visible:bg-control-focus"
          >
            <HubAgentAvatar
              id={resolvedAgentId || device.id}
              name={agentName}
              avatar={agentRecord?.avatar}
              size="sm"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1 text-[15px] leading-tight font-semibold">
                <span className="truncate">{agentName}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </span>
              <span className="truncate text-[11.5px] text-muted-foreground">
                {chatTitle} · {device.name} · {routeLabel}
              </span>
            </span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setHistoryOpen(true)}
            aria-label="历史对话与话题"
            title="历史对话与话题"
          >
            <History data-icon="inline-start" />
            <span className="hidden sm:inline">历史</span>
            {agentChats.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {agentChats.length}
              </span>
            )}
          </Button>
        </div>
      </header>

      {/* Topic, History & Task Quick Ribbon */}
      {(sessions.length > 0 || agentChats.length > 0 || !!chat) && (
        <div className="hub-topic-ribbon">
          {sessions.map((s) => (
            <button
              type="button"
              key={s.id}
              data-active={s.id === current?.id || undefined}
              className="hub-topic-pill"
              onClick={() =>
                ws.go(base + (s.type === "main" ? "" : "/topics/" + s.id))
              }
            >
              {s.type === "topic" && <Hash className="size-3 opacity-70" />}
              <span className="max-w-36 truncate">
                {s.type === "main" ? "主会话" : s.title || "Topic"}
              </span>
            </button>
          ))}
          {agentChats.length > 0 && (
            <button
              type="button"
              className="hub-topic-pill"
              onClick={() => setHistoryOpen(true)}
            >
              <Clock className="size-3 opacity-70" />
              <span>历史对话 ({agentChats.length})</span>
            </button>
          )}
          {chat && resolvedAgentId && agentRecord && (
            <button
              type="button"
              className="hub-topic-pill"
              onClick={() =>
                ws.go("devices/" + device.id + "/agents/" + resolvedAgentId)
              }
            >
              <MessageSquarePlus className="size-3 opacity-70" />
              <span>新对话</span>
            </button>
          )}
          {chatRecord?.taskId && (
            <button
              type="button"
              className="hub-topic-pill"
              onClick={() => ws.go("tasks/" + chatRecord.taskId)}
            >
              打开关联任务
            </button>
          )}
          {chat && (
            <button
              type="button"
              className="hub-topic-pill ml-auto"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                createTaskFromChat(ws, privateChat ? undefined : {deviceId:device.id,chatId:chat,sessionId:session},privateChat?"":chatRecord?.title??"");
              }}
            >
              <ListPlus className="size-3 opacity-70" />
              从对话创建任务
            </button>
          )}
        </div>
      )}

      {/* Scrollable Message Thread */}
      <div className="hub-chat-thread" ref={threadRef}>
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-4">
          {query.error && (
            <div
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {String(query.error)}
              {records.length > 0 &&
                lastSync &&
                " · 上次同步 " + new Date(lastSync).toLocaleString()}
            </div>
          )}

          {target &&
            !awaitingNotice &&
            !records.some((r) => r.id === target) && (
              <div
                role="status"
                className="rounded-xl border border-border bg-muted/50 px-3 py-2 text-center text-xs text-muted-foreground"
              >
                这条提醒对应的记录已移除。
              </div>
            )}

          {runs.length === 0 && !query.isLoading && (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <HubAgentAvatar
                id={resolvedAgentId || device.id}
                name={agentName}
                avatar={agentRecord?.avatar}
                size="lg"
              />
              <div className="flex flex-col gap-1">
                <div className="text-[15px] font-semibold">{agentName}</div>
                <p className="text-xs text-muted-foreground">
                  {chat
                    ? "该会话暂无消息记录，在下方输入指令即可开始。"
                    : `在 ${device.name} 上开启新对话${agentRecord?.model ? ` · ${agentRecord.model}` : ""}`}
                </p>
              </div>
              {agentChats.length > 0 && !chat && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setHistoryOpen(true)}
                >
                  <History data-icon="inline-start" />
                  查看 {agentChats.length} 个历史对话
                </Button>
              )}
            </div>
          )}

          {runs.map((r) => {
            const requests = records.filter(
              (q) => q.kind === "request" && q.runId === r.id,
            );
            const isActive = [
              "starting",
              "running",
              "waiting_user",
              "unknown",
            ].includes(r.status ?? "");
            return (
              <section
                className="flex flex-col gap-2.5"
                key={r.id}
                id={"hub-record-" + r.id}
              >
                {/* User message bubble */}
                {r.text && (
                  <div className="flex justify-end">
                    <div className="hub-bubble-user">{r.text}</div>
                  </div>
                )}

                {/* Agent response bubble */}
                {(r.items?.length ||
                  r.error ||
                  r.files?.length ||
                  requests.length > 0 ||
                  isActive) && (
                  <div className="flex items-start gap-2.5">
                    <HubAgentAvatar
                      id={resolvedAgentId || device.id}
                      name={agentName}
                      avatar={agentRecord?.avatar}
                      size="sm"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          {agentName}
                        </span>
                        {r.status && (
                          <Badge
                            variant={
                              r.status === "waiting_user" ||
                              r.status === "running"
                                ? "secondary"
                                : "outline"
                            }
                            className="h-4 px-1.5 text-[10px]"
                          >
                            {label(r.status)}
                          </Badge>
                        )}
                      </div>

                      {(r.items?.length || r.error) && (
                        <div className="hub-bubble-agent">
                          {r.items?.map((v, j) => (
                            <div
                              key={v.id + ":" + j}
                              className={
                                v.kind === "text"
                                  ? "leading-relaxed whitespace-pre-wrap"
                                  : "rounded-lg border border-border/80 bg-muted/40 px-2.5 py-2 text-xs"
                              }
                            >
                              {v.title && (
                                <div className="mb-0.5 font-medium text-foreground">
                                  {v.title}
                                </div>
                              )}
                              {v.text && (
                                <div className="whitespace-pre-wrap break-words">
                                  {v.text}
                                </div>
                              )}
                              {v.truncated && (
                                <span className="mt-1 inline-block text-[11px] text-muted-foreground">
                                  输出已截断
                                </span>
                              )}
                            </div>
                          ))}
                          {r.error && (
                            <p
                              role="alert"
                              className="rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
                            >
                              {r.error}
                            </p>
                          )}
                        </div>
                      )}

                      {!!r.files?.length && (
                        <div className="flex flex-wrap gap-1.5">
                          {r.files.map((f, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 font-mono text-[11px]"
                            >
                              <FileDiff className="size-3 text-muted-foreground" />
                              <span>{f.name}</span>
                              <span className="text-emerald-600 tabular-nums dark:text-emerald-400">
                                +{f.additions}
                              </span>
                              <span className="text-destructive tabular-nums">
                                −{f.deletions}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}

                      {requests.map((q) => (
                        <Card
                          key={q.id}
                          q={q}
                          disabled={
                            !canSend ||
                            awaitingNotice ||
                            (q.id === target && query.isFetching)
                          }
                          onAnswer={(answer) =>
                            void enqueue({
                              kind:
                                answer === "allow_run" ? "allow_run" : "answer",
                              deviceId: device.id,
                              chatId: chat,
                              runId: r.id,
                              requestId: q.id,
                              answer: answer === "allow_run" ? undefined : answer,
                            })
                          }
                        />
                      ))}

                      {isActive && (
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              device.revoked ||
                              (!device.online && ws.transport.kind === "web")
                            }
                            onClick={() => {
                              if (
                                r.status !== "unknown" ||
                                confirm("已核实原执行停止？")
                              )
                                void enqueue({
                                  kind:
                                    r.status === "unknown"
                                      ? "resolve_unknown"
                                      : "stop",
                                  deviceId: device.id,
                                  chatId: chat,
                                  runId: r.id,
                                });
                            }}
                          >
                            <Square data-icon="inline-start" />
                            {r.status === "unknown"
                              ? "确认执行已停止"
                              : "停止执行"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}

          {current?.queuePaused && (
            <div className="flex justify-center">
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  void enqueue({
                    kind: "resume_queue",
                    deviceId: device.id,
                    chatId: chat,
                    sessionId: current.id,
                  })
                }
              >
                恢复队列
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Sticky IM Composer */}
      <form
        className="hub-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          sendDraft();
        }}
      >
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-2">
          {(chat || ((!chat || topic) && !!agentRecord?.groups?.length) || canSteer || known) && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {chat && (
                <label
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors select-none ${
                    topic
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:bg-control-hover hover:text-foreground"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={topic}
                    onChange={(e) => {
                      setTopic(e.target.checked);
                      setGroup("");
                    }}
                  />
                  <Hash className="size-3" />
                  <span>新建 Topic</span>
                </label>
              )}
              {(!chat || topic) && !!agentRecord?.groups?.length && (
                <select
                  aria-label="目录组"
                  className="hub-mini-select"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">默认目录组</option>
                  {agentRecord.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              )}
              {canSteer && (
                <select
                  aria-label="发送方式"
                  className="hub-mini-select"
                  value={delivery}
                  onChange={(e) => setDelivery(e.target.value)}
                >
                  <option value="queue">加入队列</option>
                  <option value="steer">引导当前回复</option>
                </select>
              )}
              {known && (
                <span
                  role="status"
                  className="ml-auto text-xs text-muted-foreground"
                >
                  {label(known.receipt.status)} {known.receipt.detail}
                </span>
              )}
            </div>
          )}

          <div className="flex items-end gap-2">
            <Textarea
              aria-label="消息"
              placeholder={
                canSend
                  ? `发消息给 ${agentName}…`
                  : "当前设备离线或不可发送"
              }
              rows={1}
              className="max-h-36 min-h-[40px] flex-1 resize-none rounded-xl bg-background py-2.5 text-[14px]"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                saveLocal(draftKey, e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  sendDraft();
                }
              }}
            />
            <Button
              type="submit"
              className="h-10 shrink-0 rounded-xl px-4"
              disabled={!draft.trim() || !canSend}
            >
              <SendHorizontal data-icon="inline-start" />
              发送
            </Button>
          </div>
        </div>
      </form>

      {/* Slide-up History Chats & Topics Sheet */}
      {historyOpen && (
        <div
          className="hub-sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="历史对话与话题"
          onClick={(e) => {
            if (e.target === e.currentTarget) setHistoryOpen(false);
          }}
        >
          <div className="hub-sheet">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <HubAgentAvatar
                  id={resolvedAgentId || device.id}
                  name={agentName}
                  avatar={agentRecord?.avatar}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold">
                    {agentName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    历史 Chat 与话题 · {device.name}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {resolvedAgentId && agentRecord && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setHistoryOpen(false);
                      ws.go(
                        "devices/" + device.id + "/agents/" + resolvedAgentId,
                      );
                    }}
                  >
                    <MessageSquarePlus data-icon="inline-start" />
                    新对话
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="关闭"
                  onClick={() => setHistoryOpen(false)}
                >
                  <X />
                </Button>
              </div>
            </div>

            {agentChats.length > 4 && (
              <div className="border-b border-border px-4 py-2.5">
                <Input
                  aria-label="筛选历史对话"
                  placeholder="搜索历史对话或话题…"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                />
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-3">
              {filteredHistoryChats.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground">
                  暂无历史对话记录
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {filteredHistoryChats.map((c) => {
                    const topics = (sessionsByChat.get(c.id) ?? []).filter(
                      (s) => s.type === "topic",
                    );
                    const isCurrentChat = c.id === chat;
                    return (
                      <div
                        key={c.id}
                        className={`rounded-xl border transition-colors ${
                          isCurrentChat
                            ? "border-foreground/25 bg-muted/50"
                            : "border-border bg-card"
                        }`}
                      >
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left outline-none hover:bg-control-hover focus-visible:bg-control-focus"
                          onClick={() => {
                            setHistoryOpen(false);
                            ws.go(
                              "devices/" +
                                device.id +
                                (c.private ? "/private/" : "/chats/") +
                                c.id,
                            );
                          }}
                        >
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[14px] font-medium">
                                {c.title || "未命名对话"}
                              </span>
                              {c.private && (
                                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                                  <Lock className="size-2.5" />
                                  仅局域网
                                </Badge>
                              )}
                              {isCurrentChat && !session && (
                                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                                  当前
                                </Badge>
                              )}
                            </div>
                            <span className="text-[11.5px] text-muted-foreground">
                              主会话
                              {topics.length > 0
                                ? ` · ${topics.length} 个话题`
                                : ""}
                            </span>
                          </div>
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {formatChatTime(c.updatedAt || c.createdAt)}
                          </span>
                        </button>

                        {topics.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 border-t border-border/70 px-3 py-2">
                            {topics.map((t) => {
                              const isCurrentTopic =
                                isCurrentChat && session === t.id;
                              const isTopicUnread =
                                (t.unreadSequence ?? 0) >
                                Math.max(
                                  t.readSequence ?? 0,
                                  readLocal(ws.key + device.id + t.id, 0),
                                );
                              return (
                                <button
                                  type="button"
                                  key={t.id}
                                  className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors outline-none ${
                                    isCurrentTopic
                                      ? "border-foreground/30 bg-foreground text-background"
                                      : "border-border bg-background text-foreground hover:bg-control-hover"
                                  }`}
                                  onClick={() => {
                                    setHistoryOpen(false);
                                    ws.go(
                                      "devices/" +
                                        device.id +
                                        (c.private ? "/private/" : "/chats/") +
                                        c.id +
                                        "/topics/" +
                                        t.id,
                                    );
                                  }}
                                >
                                  <Hash className="size-3 shrink-0 opacity-70" />
                                  <span className="truncate">
                                    {t.title || "Topic"}
                                  </span>
                                  {isTopicUnread && !isCurrentTopic && (
                                    <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
