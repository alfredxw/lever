import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Pencil,
  Send,
  XCircle,
} from "lucide-react";
import type {
  ChatRef,
  Device,
  Dispatch,
  Record as Shared,
  Task,
} from "@/api/hub.gen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deviceStatus, label, type Workspace } from "./HubApp";
import { readLocal, saveLocal } from "./client";

export function taskDraftKey(space: string, id?: string) {
  return space + ":new-task" + (id ? ":" + id : "");
}

export function createTaskFromChat(ws: Workspace, source: ChatRef | undefined, title: string) {
  const id=crypto.randomUUID();
  saveLocal(taskDraftKey(ws.key,id),{id,title,body:window.getSelection()?.toString()??"",source});
  ws.go("tasks/new/"+id);
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
    <div className="hub-pane-scroll">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="hub-mobile-only -ml-2"
            onClick={() => ws.go("tasks")}
          >
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
          <h1 className="text-[20px] font-semibold tracking-tight">
            新建共享任务
          </h1>
        </div>
        <form
          className="hub-card-surface flex flex-col gap-4 p-4"
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
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            标题
            <Input
              required
              placeholder="输入任务标题"
              value={draft.title}
              onChange={(e) => change({ title: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            正文
            <Textarea
              rows={4}
              placeholder="描述目标、上下文或验收标准…"
              value={draft.body}
              onChange={(e) => change({ body: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            项目标签
            <Input
              placeholder="可选，例如：移动端 / 后端"
              value={draft.project ?? ""}
              onChange={(e) => change({ project: e.target.value })}
            />
          </label>
          {draft.source && (
            <p className="text-xs text-muted-foreground">
              任务将保留来源对话链接。
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit">创建任务</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => ws.go("tasks")}
            >
              取消
            </Button>
          </div>
        </form>
      </div>
    </div>
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

  if (!detail.data) {
    return (
      <div className="hub-pane-scroll">
        <p className="text-sm text-muted-foreground">
          {detail.error ? String(detail.error) : "正在读取任务…"}
        </p>
      </div>
    );
  }

  const { task: t, history } = detail.data;
  const current = history.find((d) => d.id === t.dispatchId);
  const online = devices.some(
    (d) => d.id === current?.deviceId && d.online && !d.revoked,
  );
  const agents = (index[device] ?? []).filter((v) => v.kind === "agent");
  const groups = agents.find((a) => a.id === agent)?.groups;

  return (
    <div className="hub-pane-scroll">
      <div className="mx-auto flex w-full max-w-[740px] flex-col gap-4">
        <div className="flex items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="hub-mobile-only -ml-2 shrink-0"
            onClick={() => ws.go("tasks")}
          >
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold tracking-tight">
              {t.title}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge
                variant={
                  t.status === "review" || t.status === "attention"
                    ? "default"
                    : "secondary"
                }
              >
                {label(t.status)}
              </Badge>
              {t.project && <Badge variant="outline">{t.project}</Badge>}
              {current &&
                (!online ||
                  current.status === "pending" ||
                  current.status === "reviewing") && (
                  <span className="text-xs text-muted-foreground">
                    · {devices.find((d) => d.id === current.deviceId)?.name}{" "}
                    {online
                      ? label(current.status)
                      : devices.find((d) => d.id === current.deviceId)?.revoked
                        ? "已撤销"
                        : "离线"}
                  </span>
                )}
              {t.acceptedOffline && (
                <span className="text-xs text-muted-foreground">
                  · 按设备最后同步的结果验收
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Body & Primary Actions */}
        <section className="hub-card-surface flex flex-col gap-3 p-4">
          {editing ? (
            <form
              className="flex flex-col gap-3"
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
              <Textarea name="body" rows={4} defaultValue={t.body} />
              <Input
                aria-label="项目标签"
                name="project"
                placeholder="项目标签"
                defaultValue={t.project ?? ""}
              />
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm">
                  保存
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(false)}
                >
                  取消
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">
                {t.body || "无任务正文"}
              </p>
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                {current?.chatId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      ws.go(
                        "devices/" +
                          current.deviceId +
                          "/chats/" +
                          current.chatId,
                      )
                    }
                  >
                    <ExternalLink data-icon="inline-start" />
                    打开 Chat
                  </Button>
                )}
                {t.status === "review" && current && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      if (
                        !online &&
                        !confirm("执行机离线。按最后同步的结果验收？")
                      )
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
                    <CheckCircle2 data-icon="inline-start" />
                    验收
                  </Button>
                )}
                {t.source && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      ws.go(
                        "devices/" +
                          t.source!.deviceId +
                          "/chats/" +
                          t.source!.chatId +
                          (t.source!.sessionId
                            ? "/topics/" + t.source!.sessionId
                            : ""),
                      )
                    }
                  >
                    打开来源对话
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                >
                  <Pencil data-icon="inline-start" />
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
                      type="button"
                      size="sm"
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
                      <XCircle data-icon="inline-start" />
                      关闭任务
                    </Button>
                  )}
              </div>
            </>
          )}
        </section>

        {/* Dispatch / Re-dispatch Form */}
        {t.status !== "done" && t.status !== "closed" && (
          <form
            className="hub-card-surface flex flex-col gap-3.5 p-4"
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
            <h2 className="text-[14px] font-semibold">
              {current ? "改派任务" : "派发给设备"}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                执行设备
                <select
                  required
                  className="hub-select"
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
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                Agent
                <select
                  required
                  className="hub-select"
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
            </div>
            {!!groups?.length && (
              <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                目录组
                <select
                  className="hub-select"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="">默认目录组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-[13px] font-medium">
              补充指令
              <Textarea
                rows={2}
                placeholder="可选，给执行 Agent 的补充说明…"
                value={instruction}
                onChange={(e) => {
                  setInstruction(e.target.value);
                  saveLocal(key + ":text", e.target.value);
                }}
              />
            </label>
            <div>
              <Button type="submit" disabled={!device || !agent}>
                <Send data-icon="inline-start" />
                确认{current ? "改派" : "派发"}
              </Button>
            </div>
          </form>
        )}

        {/* Dispatch History */}
        {history.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
              派发记录
            </h2>
            <div className="hub-card-surface divide-y divide-border overflow-hidden">
              {history.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="font-medium">
                      {devices.find((v) => v.id === d.deviceId)?.name ??
                        d.deviceId}
                    </span>
                    <Badge variant="outline">{label(d.status)}</Badge>
                    {d.superseded && (
                      <span className="text-xs text-muted-foreground">
                        已改派
                      </span>
                    )}
                  </div>
                  {d.chatId && (
                    <Button
                      type="button"
                      size="xs"
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
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
