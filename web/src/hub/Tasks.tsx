import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ChatRef,
  Device,
  Dispatch,
  Record as Shared,
  Task,
} from "@/api/hub.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deviceStatus, label, type Workspace } from "./HubApp";
import { readLocal, saveLocal } from "./client";

export function taskDraftKey(space: string, id?: string) {
  return space + ":new-task" + (id ? ":" + id : "");
}
export function NewTask({ ws, draftId }: { ws: Workspace; draftId?: string }) {
  const key = taskDraftKey(ws.key, draftId);
  const [draft, setDraft] = useState(() =>
    readLocal<{
      id: string;
      title: string;
      body: string;
      project?: string;
      source?: ChatRef;
    }>(key, { id: crypto.randomUUID(), title: "", body: "" }),
  );
  const change = (value: Partial<typeof draft>) => {
    const d = { ...draft, ...value };
    setDraft(d);
    saveLocal(key, d);
  };
  return (
    <>
      <h1>新建共享任务</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ws.act(async () => {
            const t = await ws.transport.request<Task>(
              ws.path + "/tasks",
              "POST",
              draft,
            );
            localStorage.removeItem(key);
            ws.go("tasks/" + t.id);
          });
        }}
      >
        <label>
          标题
          <Input
            required
            value={draft.title}
            onChange={(e) => change({ title: e.target.value })}
          />
        </label>
        <label>
          正文
          <Textarea
            value={draft.body}
            onChange={(e) => change({ body: e.target.value })}
          />
        </label>
        <label>
          项目标签
          <Input
            value={draft.project ?? ""}
            onChange={(e) => change({ project: e.target.value })}
          />
        </label>
        {draft.source && <small>任务将保留来源对话链接。</small>}
        <Button>创建任务</Button>
      </form>
    </>
  );
}
export function TaskDetail({
  ws,
  id,
  devices,
  index,
}: {
  ws: Workspace;
  id: string;
  devices: Device[];
  index: Record<string, Shared[]>;
}) {
  const path = ws.path + "/tasks/" + id;
  const cacheKey = ws.key + ":task:" + id;
  type TaskHistory = { task: Task; history: Dispatch[] };
  const detail = useQuery({
    queryKey: [ws.key, "task", id],
    initialData:
      ws.transport.kind !== "web"
        ? readLocal<TaskHistory | undefined>(cacheKey, undefined)
        : undefined,
    initialDataUpdatedAt: 0,
    queryFn: async () => {
      const value = await ws.transport.request<TaskHistory>(path);
      if (ws.transport.kind !== "web") saveLocal(cacheKey, value);
      return value;
    },
  });
  const [device, setDevice] = useState("");
  const [agent, setAgent] = useState("");
  const [group, setGroup] = useState("");
  const key = ws.key + ":dispatch:" + id;
  const [instruction, setInstruction] = useState(() =>
    readLocal(key + ":text", ""),
  );
  const [editing, setEditing] = useState(false);
  if (!detail.data)
    return <p>{detail.error ? String(detail.error) : "正在读取任务…"}</p>;
  const { task: t, history } = detail.data;
  const current = history.find((d) => d.id === t.dispatchId);
  const online = devices.some(
    (d) => d.id === current?.deviceId && d.online && !d.revoked,
  );
  const agents = (index[device] ?? []).filter((v) => v.kind === "agent");
  const groups = agents.find((a) => a.id === agent)?.groups;
  return (
    <>
      <h1>{t.title}</h1>
      <p>
        {label(t.status)} {t.project && <small> · {t.project}</small>}
        {current &&
          (!online ||
            current.status === "pending" ||
            current.status === "reviewing") && (
            <small>
              {" "}
              · {devices.find((d) => d.id === current.deviceId)?.name}{" "}
              {online
                ? label(current.status)
                : devices.find((d) => d.id === current.deviceId)?.revoked
                  ? "已撤销"
                  : "离线"}
            </small>
          )}
      </p>
      {t.source && (
        <Button
          variant="ghost"
          onClick={() =>
            ws.go(
              "devices/" +
                t.source!.deviceId +
                "/chats/" +
                t.source!.chatId +
                (t.source!.sessionId ? "/topics/" + t.source!.sessionId : ""),
            )
          }
        >
          打开来源对话
        </Button>
      )}
      {t.acceptedOffline && <small>按设备最后同步的结果验收</small>}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void ws.act(async () => {
              await ws.transport.request(path, "PATCH", {
                title: f.get("title"),
                body: f.get("body"),
                project: f.get("project"),
                version: t.version,
              });
              setEditing(false);
            });
          }}
        >
          <Input name="title" defaultValue={t.title} required />
          <Textarea name="body" defaultValue={t.body} />
          <Input
            aria-label="项目标签"
            name="project"
            defaultValue={t.project ?? ""}
          />
          <Button>保存</Button>
        </form>
      ) : (
        <>
          <p>{t.body}</p>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            编辑
          </Button>
          {t.status !== "done" &&
            t.status !== "closed" &&
            (!current ||
              [
                "completed",
                "failed",
                "interrupted",
                "declined",
                "cancelled",
              ].includes(current.status)) && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (confirm("关闭此共享任务？"))
                    void ws.act(async () => {
                      await ws.transport.request(path, "PATCH", {
                        version: t.version,
                        title: t.title,
                        body: t.body,
                        close: true,
                      });
                    });
                }}
              >
                关闭任务
              </Button>
            )}
        </>
      )}
      {current && (
        <div className="hub-actions">
          {current.chatId && (
            <Button
              variant="outline"
              onClick={() =>
                ws.go(
                  "devices/" + current.deviceId + "/chats/" + current.chatId,
                )
              }
            >
              打开 Chat
            </Button>
          )}
          {t.status === "review" && (
            <Button
              onClick={() => {
                if (!online && !confirm("执行机离线。按最后同步的结果验收？"))
                  return;
                void ws.act(async () => {
                  await ws.transport.request(path + "/accept", "POST", {
                    version: t.version,
                    runId: current.runId,
                    confirmOffline: !online,
                  });
                });
              }}
            >
              验收
            </Button>
          )}
        </div>
      )}
      {t.status !== "done" && t.status !== "closed" && (
        <form
          className="hub-group"
          onSubmit={(e) => {
            e.preventDefault();
            void ws.act(async () => {
              let force = false;
              if (
                current &&
                !online &&
                !["completed", "interrupted", "failed", "declined"].includes(
                  current.status,
                )
              ) {
                force = confirm(
                  "原设备离线，旧执行可能仍在运行。忽略原设备并强制改派？",
                );
                if (!force) return;
              }
              const payload = {
                version: t.version,
                deviceId: device,
                agentId: agent,
                workingCopyId: group || undefined,
                text: instruction,
                force,
              };
              const hash = JSON.stringify(payload);
              const prev = readLocal(key, { hash: "", commandId: "" });
              const commandId =
                prev.hash === hash ? prev.commandId : crypto.randomUUID();
              saveLocal(key, { hash, commandId });
              await ws.transport.request(path + "/dispatch", "POST", {
                ...payload,
                commandId,
              });
              localStorage.removeItem(key);
              localStorage.removeItem(key + ":text");
              setInstruction("");
            });
          }}
        >
          <h2>{current ? "改派" : "派发"}</h2>
          <label>
            执行设备
            <select
              required
              value={device}
              onChange={(e) => {
                setDevice(e.target.value);
                setAgent("");
                setGroup("");
              }}
            >
              <option value="">选择设备</option>
              {devices
                .filter((d) => d.role !== "controller")
                .map((d) => (
                  <option
                    key={d.id}
                    value={d.id}
                    disabled={!d.online || d.revoked || d.draining}
                  >
                    {d.name} · {deviceStatus(d)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Agent
            <select
              required
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                setGroup("");
              }}
            >
              <option value="">选择已开放的 Agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
          {!!groups?.length && (
            <label>
              目录组
              <select value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">默认目录组</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            补充指令
            <Textarea
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                saveLocal(key + ":text", e.target.value);
              }}
            />
          </label>
          <Button disabled={!device || !agent}>
            确认{current ? "改派" : "派发"}
          </Button>
        </form>
      )}
      {history.length > 0 && (
        <section className="hub-group">
          <h2>派发记录</h2>
          {history.map((d) => (
            <div key={d.id}>
              <strong>
                {devices.find((v) => v.id === d.deviceId)?.name ?? d.deviceId}
              </strong>{" "}
              · {label(d.status)} {d.superseded && <small>已改派</small>}
              {d.chatId && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    ws.go("devices/" + d.deviceId + "/chats/" + d.chatId)
                  }
                >
                  打开
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
