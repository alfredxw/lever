import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchArchive, savedArchive } from "./archive";
import type { Answer, Device, Intent, Record as Shared } from "@/api/hub.gen";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { InboxItem } from "@/api/hub.gen";
import { label, submit, type Workspace } from "./HubApp";
import { readLocal, saveLocal } from "./client";
import { taskDraftKey } from "./Tasks";

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
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  return (
    <section className="hub-card" id={"hub-record-" + q.id}>
      <h3>{q.title}</h3>
      <p>{q.text}</p>
      {q.status !== "pending" ? (
        <p>
          {label(q.status)}{" "}
          {q.answeredByUserId && <small>{q.answeredByUserId} · </small>}
          {q.type === "question" && q.answer?.answers
            ? Object.values(q.answer.answers).flat().join("，")
            : (q.answer?.optionId ??
              (q.answer?.allow ? "已允许" : q.answer ? "已拒绝" : ""))}
        </p>
      ) : (
        <>
          {q.questions?.map((v) => (
            <fieldset key={v.id}>
              <legend>{v.text}</legend>
              {v.options?.length ? (
                v.options.map((o) => (
                  <label className="hub-check" key={o.id}>
                    <input
                      type={v.multiple ? "checkbox" : "radio"}
                      name={v.id}
                      checked={answers[v.id]?.includes(o.id) ?? false}
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [v.id]: e.target.checked
                            ? [
                                ...(v.multiple ? (answers[v.id] ?? []) : []),
                                o.id,
                              ]
                            : (answers[v.id] ?? []).filter((id) => id !== o.id),
                        })
                      }
                    />
                    {o.name}
                  </label>
                ))
              ) : (
                <Input
                  onChange={(e) =>
                    setAnswers({ ...answers, [v.id]: [e.target.value] })
                  }
                />
              )}
            </fieldset>
          ))}
          <div className="hub-actions">
            {q.type === "question" ? (
              <Button
                disabled={
                  disabled ||
                  q.questions?.some((v) => !answers[v.id]?.some(Boolean))
                }
                onClick={() => onAnswer({ allow: true, answers })}
              >
                提交回答
              </Button>
            ) : (
              <>
                {q.options?.length ? (
                  q.options.map((v) => (
                    <Button
                      key={v.id}
                      disabled={disabled}
                      variant="outline"
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
                      disabled={disabled}
                      onClick={() => onAnswer({ allow: true })}
                    >
                      允许一次
                    </Button>
                    <Button
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
        </>
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
}: {
  ws: Workspace;
  device: Device;
  chat?: string;
  privateChat: boolean;
  agent?: string;
  session?: string;
  target?: string;
  index: Shared[];
}) {
  const base =
    "devices/" + device.id + (privateChat ? "/private/" : "/chats/") + chat;
  const cached =
    ws.key + (privateChat ? ":private:" : ":archive:") + device.id + ":" + chat;
  const qc = useQueryClient();
  const native = ws.transport.kind !== "web";
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
      const target =
        "devices/" +
        device.id +
        (privateChat ? "/private/" : "/chats/") +
        known.receipt.chatId +
        (known.intent.operation === "topic" && known.receipt.sessionId
          ? "/topics/" + known.receipt.sessionId
          : "");
      localStorage.removeItem(receiptKey);
      ws.go(target);
    }
  }, [known, chat, session, device.id, privateChat, receiptKey, ws]);
  const [delivery, setDelivery] = useState("queue");
  const [group, setGroup] = useState("");
  const a = index.find(
    (v) =>
      v.kind === "agent" &&
      v.id === (agent ?? records.find((v) => v.kind === "chat")?.agentId),
  );
  const title = (
    chat ? index.find((v) => v.kind === "chat" && v.id === chat) : a
  )?.title;
  const canSend =
    (!!a || privateChat) &&
    (device.online || ws.transport.kind !== "web") &&
    !device.revoked &&
    (!device.draining || !!chat);
  useEffect(() => {
    if (current?.unreadSequence)
      saveLocal(ws.key + device.id + current.id, current.unreadSequence);
  }, [current?.id, current?.unreadSequence, device.id, ws.key]);
  const enqueue = (cmd: Command) =>
    ws.act(async () => {
      remember(await submit(ws, { ...cmd, private: privateChat || undefined }));
    });
  return (
    <>
      <h1>{title ?? "共享对话"}</h1>
      <p>
        {device.name} ·{" "}
        {privateChat
          ? "仅设备 · 局域网"
          : query.isError
            ? "上次同步"
            : query.data?.cursor?.stream === "lan"
              ? "局域网直连"
              : "Hub 共享"}
      </p>
      {chat && (
        <div className="hub-actions">
          {records.find((v) => v.kind === "chat")?.taskId && (
            <Button
              variant="ghost"
              onClick={() =>
                ws.go("tasks/" + records.find((v) => v.kind === "chat")?.taskId)
              }
            >
              打开关联任务
            </Button>
          )}
          <Button
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const id = crypto.randomUUID();
              const selected = window.getSelection()?.toString() ?? "";
              saveLocal(taskDraftKey(ws.key, id), {
                id,
                title: privateChat ? "" : (title ?? ""),
                body: selected,
                source: privateChat
                  ? undefined
                  : { deviceId: device.id, chatId: chat, sessionId: session },
              });
              ws.go("tasks/new/" + id);
            }}
          >
            从对话创建任务
          </Button>
        </div>
      )}
      {sessions.length > 0 && (
        <div className="hub-actions">
          {sessions.map((s) => (
            <Button
              key={s.id}
              variant={s.id === current?.id ? "secondary" : "ghost"}
              onClick={() =>
                ws.go(base + (s.type === "main" ? "" : "/topics/" + s.id))
              }
            >
              {s.type === "main" ? "主会话" : s.title || "Topic"}
            </Button>
          ))}
        </div>
      )}
      {query.error && (
        <p role="alert">
          {String(query.error)}{" "}
          {records.length > 0 &&
            lastSync &&
            "上次同步 " + new Date(lastSync).toLocaleString()}
        </p>
      )}
      {target && !awaitingNotice && !records.some((r) => r.id === target) && (
        <p role="status">这条提醒对应的记录已移除。</p>
      )}
      {runs.map((r) => (
        <section className="hub-turn" key={r.id} id={"hub-record-" + r.id}>
          <small>{label(r.status)}</small>
          <p className="hub-user">{r.text}</p>
          {r.items?.map((v, j) => (
            <div key={v.id + ":" + j}>
              {v.title && <strong>{v.title}</strong>}
              <p>{v.text}</p>
              {v.truncated && <small>输出已截断</small>}
            </div>
          ))}
          {r.error && <p role="alert">{r.error}</p>}
          {r.files?.map((f, i) => (
            <div key={i}>
              <code>{f.name}</code> +{f.additions} −{f.deletions}
            </div>
          ))}
          {records
            .filter((q) => q.kind === "request" && q.runId === r.id)
            .map((q) => (
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
                    kind: answer === "allow_run" ? "allow_run" : "answer",
                    deviceId: device.id,
                    chatId: chat,
                    runId: r.id,
                    requestId: q.id,
                    answer: answer === "allow_run" ? undefined : answer,
                  })
                }
              />
            ))}
          {["starting", "running", "waiting_user", "unknown"].includes(
            r.status ?? "",
          ) && (
            <Button
              variant="outline"
              disabled={
                device.revoked ||
                (!device.online && ws.transport.kind === "web")
              }
              onClick={() => {
                if (r.status !== "unknown" || confirm("已核实原执行停止？"))
                  void enqueue({
                    kind: r.status === "unknown" ? "resolve_unknown" : "stop",
                    deviceId: device.id,
                    chatId: chat,
                    runId: r.id,
                  });
              }}
            >
              {r.status === "unknown" ? "确认执行已停止" : "停止执行"}
            </Button>
          )}
        </section>
      ))}
      {current?.queuePaused && (
        <Button
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
      )}
      <form
        className="hub-compose"
        onSubmit={(e) => {
          e.preventDefault();
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
                  ["starting", "running", "waiting_user"].includes(
                    v.status ?? "",
                  ),
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
        }}
      >
        <Textarea
          aria-label="消息"
          placeholder="输入消息…"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            saveLocal(draftKey, e.target.value);
          }}
        />
        <div className="hub-actions">
          {chat && (
            <label className="hub-check">
              <input
                type="checkbox"
                checked={topic}
                onChange={(e) => {
                  setTopic(e.target.checked);
                  setGroup("");
                }}
              />
              新建 Topic
            </label>
          )}
          {(!chat || topic) && !!a?.groups?.length && (
            <select
              aria-label="目录组"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              <option value="">默认目录组</option>
              {a.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          {canSteer && (
            <select
              aria-label="发送方式"
              value={delivery}
              onChange={(e) => setDelivery(e.target.value)}
            >
              <option value="queue">加入队列</option>
              <option value="steer">引导当前回复</option>
            </select>
          )}
          <Button disabled={!draft.trim() || !canSend}>发送</Button>
        </div>
      </form>
      {known && (
        <p role="status">
          {label(known.receipt.status)} {known.receipt.detail}
        </p>
      )}
    </>
  );
}
