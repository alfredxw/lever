import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ComposerMeta, NodeDescriptor, Receipt } from "@/api/hub.gen";
import type {
  ChatView,
  Event as LeverEvent,
  SessionRuns,
  Attachment,
  Run,
  TurnReview,
} from "@/api/types.gen";
import { APIError, updateHistoryRun } from "@/api/client";
import { ErrorNotice, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { responseParts } from "@/features/chat/runActivityLogic";
import { RunActivity } from "@/features/chat/RunActivity";
import { ChatMarkdown } from "@/features/chat/ChatResponse";
import {
  ImagePreview,
  ImagePreviewProvider,
} from "@/features/chat/ImagePreview";
import { UserMessage } from "@/features/chat/UserMessage";
import { RequestCard } from "@/features/chat/RequestCard";
import { canUseFiles, nodeApi, nodePath, type NodeOverview } from "./nodes";

import { canManage, NodeAgentForm } from "./NodeAgentForm";
const TerminalPane = lazy(() => import("@/features/terminal/TerminalPane"));
const Diff = lazy(() => import("@/features/diff/Diff"));
const Files = lazy(() =>
  import("@/features/files/Files").then((m) => ({ default: m.Files })),
);

export function NodeWorkspace({
  node,
  agentId,
  openWorkspace,
  onAgentCreated,
  onCreateTask,
  targetRecord,
  initialChat,
  initialTopic,
  dark,
  index,
}: {
  node: NodeDescriptor;
  agentId: string;
  openWorkspace?: () => void;
  onAgentCreated?: (id: string) => void;
  onCreateTask?: (chat: string, title: string, topic?: string) => void;
  targetRecord?: string;
  initialChat?: string;
  initialTopic?: string;
  dark: boolean;
  index?: NodeOverview;
}) {
  const id = node.nodeId;
  const [chat, setChat] = useState(initialChat);
  const [topic, setTopic] = useState(initialTopic ?? "");
  const [tab, setTab] = useState("chat");
  const [terminalID, setTerminalID] = useState(() => crypto.randomUUID());
  const terminalAvailable =
    node.online &&
    node.accessLevel === "admin" &&
    !node.draining &&
    !node.readOnlyFs &&
    node.features?.includes("terminal_v1");
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: ["node", id, "overview"],
    queryFn: ({ signal }) =>
      nodeApi<NodeOverview>(id, "/overview", undefined, "GET", signal),
    enabled: node.online || !!node.cacheEpoch,
    initialData: index,
    initialDataUpdatedAt: 0,
  });
  const view = overview.data ?? index;
  const agent = view?.agents?.find((a) => a.id === agentId);
  const chats = view?.chats?.filter((c) => c.agentId === agentId) ?? [];
  const selected = chat ?? chats[0]?.id ?? "";
  const conversations =
    view?.conversations?.filter((c) => c.chatId === selected) ?? [];
  const topics = conversations.filter((c) => c.kind === "topic");
  const current = conversations.find((c) =>
    topic ? c.id === topic : c.kind === "main",
  );
  useEffect(() => {
    if (openWorkspace || !node.online || !view || !selected) return;
    const source = new EventSource(
      `/api${nodePath(id, "/events")}?chat=${encodeURIComponent(selected)}&after=${view.cursor}`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void qc.invalidateQueries({ queryKey: ["node", id, "chat", selected] });
        void qc.invalidateQueries({ queryKey: ["node", id, "overview"] });
      }, 180);
    };
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as LeverEvent;
      if (event.run && event.chatId === selected) {
        const run = event.run;
        let matched = false;
        qc.setQueriesData<InfiniteData<HistoryPage>>(
          { queryKey: ["node", id, "chat", selected] },
          (data) => {
            const next = updateHistoryRun(data, run);
            if (next) matched = true;
            return next;
          },
        );
        if (matched && run.status === "running" && !event.request) return;
      }
      if (event.type === "conversation-read")
        void qc.invalidateQueries({ queryKey: ["node", id, "overview"] });
      else refresh();
    };
    source.addEventListener("reset", refresh);
    return () => {
      source.close();
      clearTimeout(timer);
    };
    // The replay cursor seeds this subscription. Reconnecting on each new
    // overview would interrupt a healthy stream.
  }, [id, selected, node.online, !!view, qc, !!openWorkspace]);
  if (
    overview.isError &&
    ((overview.error instanceof APIError &&
      [401, 403, 404].includes(overview.error.status)) ||
      !agent)
  )
    return <ErrorNotice error={overview.error} />;
  if (creating && canManage(node) && onAgentCreated)
    return (
      <div className="flex h-full flex-col">
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => setCreating(false)}
        >
          取消
        </Button>
        <NodeAgentForm
          node={node}
          done={(a) => {
            setCreating(false);
            onAgentCreated(a.id);
          }}
        />
      </div>
    );
  if (!agent && view)
    return (
      <p className="p-4 text-muted-foreground">
        此设备尚未开放这个 Agent。
        {onAgentCreated && canManage(node) && (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            新建 Agent
          </Button>
        )}
      </p>
    );
  if (!agent)
    return node.online ? (
      <Loading />
    ) : (
      <p className="p-4 text-muted-foreground">设备离线</p>
    );
  return (
    <section className="flex h-full min-h-0 w-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <strong className="truncate">{agent.name}</strong>
        <span className="text-xs text-muted-foreground">
          {node.name}
          {node.online ? "" : " · 离线"}
        </span>
        {onAgentCreated && canManage(node) && (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            新建 Agent
          </Button>
        )}
        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={(v) => v && setTab(v)}
          className="ml-auto"
          size="sm"
        >
          <ToggleGroupItem value="chat">对话</ToggleGroupItem>
          {openWorkspace && (
            <Button size="sm" variant="ghost" onClick={openWorkspace}>
              打开工作区
            </Button>
          )}
          {!openWorkspace && terminalAvailable && (
            <ToggleGroupItem value="terminal">终端</ToggleGroupItem>
          )}
          {canManage(node) && (
            <ToggleGroupItem value="profile">配置</ToggleGroupItem>
          )}
          {(node.features.includes("git_v1") ||
            node.features.includes("chat_controls_v1")) && (
            <ToggleGroupItem value="diff" disabled={!node.online}>
              变更
            </ToggleGroupItem>
          )}
          {node.features.includes("peer_v1") && (
            <ToggleGroupItem value="files" onClick={openWorkspace}>
              文件
            </ToggleGroupItem>
          )}
        </ToggleGroup>
      </header>
      {tab === "terminal" && terminalAvailable ? (
        <Suspense fallback={<Loading />}>
          <TerminalPane
            key={terminalID}
            path={nodePath(
              id,
              `/agents/${encodeURIComponent(agent.id)}/terminal`,
            )}
            terminalId={terminalID}
            started={false}
            closing={false}
            onRestart={async () => setTerminalID(crypto.randomUUID())}
            style={{ flex: 1, minHeight: 0 }}
            selected
            dark={dark}
          />
        </Suspense>
      ) : tab === "profile" && canManage(node) ? (
        <NodeAgentForm node={node} agent={agent} done={() => setTab("chat")} />
      ) : tab === "diff" &&
        node.online &&
        node.features.includes("chat_controls_v1") &&
        (!canUseFiles(node) || !node.features.includes("git_v1")) ? (
        <NodeChanges node={node} agentId={agentId} sessionId={current?.id} />
      ) : tab === "diff" && node.online && canUseFiles(node) ? (
        <Suspense fallback={<Loading />}>
          <Diff
            nodeId={id}
            agent={agent}
            dark={dark}
            canReview={false}
            openFile={() => setTab("files")}
            onFeedback={async () => {
              throw new Error("请在对话中发送反馈");
            }}
          />
        </Suspense>
      ) : tab === "files" && node.online && canUseFiles(node) ? (
        <Suspense fallback={<Loading />}>
          <Files
            source={{
              kind: "agent",
              id: agent.id,
              nodeId: id,
              readOnly: node.readOnlyFs,
            }}
            scope={agent.profile}
            dark={dark}
            active
          />
        </Suspense>
      ) : tab !== "chat" ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {!node.online
            ? "目标设备离线"
            : tab === "files" && !node.features.includes("fs_v1")
              ? "请升级目标设备的 Lever 以使用文件工作区。"
              : "目标设备尚未开放此权限，可在其「远程与设备」设置中调整。"}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 py-2">
            <Select
              value={selected || "new"}
              onValueChange={(v) => {
                setChat(v === "new" ? "" : v);
                setTopic("");
              }}
            >
              <SelectTrigger size="sm" aria-label="选择对话">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">新对话</SelectItem>
                {chats.map((c) => (
                  <SelectItem value={c.id} key={c.id}>
                    {c.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && onCreateTask && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  onCreateTask(
                    selected,
                    chats.find((c) => c.id === selected)?.title ?? "",
                    topic || undefined,
                  )
                }
              >
                从对话创建任务
              </Button>
            )}
            {selected && topics.length > 0 && (
              <Select
                value={topic || "main"}
                onValueChange={(v) => setTopic(v === "main" ? "" : v)}
              >
                <SelectTrigger
                  size="sm"
                  className="md:hidden"
                  aria-label="选择话题"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">主对话</SelectItem>
                  {topics.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex min-h-0 flex-1">
            {topics.length > 0 && (
              <nav
                aria-label="话题"
                className="hidden w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r p-2 md:flex"
              >
                {[{ id: "", title: "主对话" }, ...topics].map((item) => (
                  <Button
                    key={item.id}
                    size="sm"
                    variant={topic === item.id ? "secondary" : "ghost"}
                    aria-current={topic === item.id ? "page" : undefined}
                    className="justify-start"
                    onClick={() => setTopic(item.id)}
                  >
                    <span className="truncate">{item.title}</span>
                  </Button>
                ))}
              </nav>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <ImagePreviewProvider>
                <NodeChat
                  key={[id, agentId, selected, topic].join("/")}
                  targetRecord={targetRecord}
                  node={node}
                  agent={agentId}
                  chat={selected}
                  topic={topic}
                  onSent={(chatID, topicID) => {
                    setChat(chatID);
                    if (topicID) setTopic(topicID);
                  }}
                  binaryWorkspace={openWorkspace}
                  sessionId={current?.id}
                  unread={current?.unreadSequence}
                  read={current?.readSequence}
                />
                <ImagePreview />
              </ImagePreviewProvider>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function NodeChat({
  targetRecord,
  node,
  agent,
  chat,
  topic,
  onSent,
  binaryWorkspace,
  sessionId,
  unread = 0,
  read = 0,
}: {
  targetRecord?: string;
  node: NodeDescriptor;
  agent: string;
  chat: string;
  topic: string;
  onSent: (id: string, topic?: string) => void;
  binaryWorkspace?: () => void;
  sessionId?: string;
  unread?: number;
  read?: number;
}) {
  const id = node.nodeId;
  const qc = useQueryClient();
  const apiBase = `/api${nodePath(id, "")}`;
  const showAttachments =
    !!canUseFiles(node) && node.online && !binaryWorkspace;
  const previewFiles =
    showAttachments && node.features.includes("workspace_assets_v1");
  const draftKey = `lever:node:${id}:${agent}:${chat}:${topic}:draft`;
  const [text, setText] = useState(
    () => sessionStorage.getItem(draftKey) ?? "",
  );
  const [pending, setPending] = useState(
    () => sessionStorage.getItem(draftKey + ":command") ?? "",
  );
  const [newTopic, setNewTopic] = useState(false);
  const [modelChoice, setModelChoice] = useState("");
  const composer = useQuery({
    queryKey: ["node", id, "composer", agent],
    enabled: node.online && node.features.includes("chat_controls_v1"),
    queryFn: () => nodeApi<ComposerMeta>(id, `/agents/${agent}/composer`),
  });
  const models = (composer.data?.providers ?? []).flatMap((p) =>
    (p.models ?? []).map((m) => ({
      value: JSON.stringify([p.id, m.id]),
      name: `${p.name} · ${m.name || m.id}`,
      selection: {
        provider: p.id,
        model: m.id,
        effort: m.defaultEffort ?? "",
        fast: false,
      },
    })),
  );
  const selection = models.find((m) => m.value === modelChoice)?.selection;
  const attachmentKey = draftKey + ":attachments";
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(attachmentKey) ?? "[]");
    } catch {
      return [];
    }
  });
  const rememberAttachments = (files: Attachment[]) => {
    setAttachments(files);
    sessionStorage.setItem(attachmentKey, JSON.stringify(files));
  };
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const attachment = await nodeApi<Attachment>(
        id,
        chat ? `/chats/${chat}/attachments` : `/agents/${agent}/attachments`,
        body,
      );
      rememberAttachments([...attachments, attachment]);
    },
  });
  const [unconfirmed, setUnconfirmed] = useState(false);
  const applying = useRef(false);
  const key = ["node", id, "chat", chat, topic];
  const pages = useInfiniteQuery({
    queryKey: key,
    enabled: !!chat && (node.online || !!node.cacheEpoch),
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const before = `?limit=40&before=${pageParam}`;
      if (topic) {
        const page = await nodeApi<
          SessionRuns & { requests: ChatView["requests"] }
        >(id, `/sessions/${topic}/runs${before}`, undefined, "GET", signal);
        return {
          runs: (page.runs ?? []).slice().reverse(),
          requests: page.requests ?? [],
          next:
            page.runs?.length === 40
              ? Math.min(...page.runs.map((r) => r.sequence))
              : undefined,
        };
      }
      const page = await nodeApi<ChatView>(
        id,
        `/chats/${chat}${before}`,
        undefined,
        "GET",
        signal,
      );
      return {
        runs: page.runs ?? [],
        requests: page.requests ?? [],
        queue: page.sessions?.find((s) => s.queuePaused)?.id,
        next: page.hasMore ? page.entries[0]?.sequence : undefined,
      };
    },
    getNextPageParam: (p) => p.next,
  });
  useEffect(() => {
    if (!node.online || !pages.isSuccess || !sessionId || unread <= read)
      return;
    void nodeApi(id, "/read", {
      items: [{ sessionId, sequence: unread }],
    }).catch(() => {});
  }, [id, node.online, pages.isSuccess, sessionId, unread, read]);
  const change = (value: string) => {
    setText(value);
    sessionStorage.setItem(draftKey, value);
  };
  const clearPending = () => {
    setUnconfirmed(false);
    setPending("");
    sessionStorage.removeItem(draftKey + ":command");
  };
  const sent = (receipt: Receipt) => {
    clearPending();
    change("");
    rememberAttachments([]);
    void qc.invalidateQueries({ queryKey: ["node", id] });
    if (receipt.chatId)
      onSent(receipt.chatId, newTopic ? receipt.sessionId : undefined);
    setNewTopic(false);
  };
  const send = useMutation({
    mutationFn: async () => {
      if (applying.current) return;
      applying.current = true;
      try {
        if (pending && !unconfirmed) {
          const receipt = await nodeApi<Receipt>(
            id,
            "/commands/" + pending,
          ).catch((e) => {
            if (e instanceof APIError && e.status === 404) {
              setUnconfirmed(true);
              throw new Error("设备没有此消息的回执，可用原编号重新提交。");
            }
            throw e;
          });
          sent(receipt);
          return;
        }
        const commandId = pending || crypto.randomUUID();
        setUnconfirmed(false);
        setPending(commandId);
        sessionStorage.setItem(draftKey + ":command", commandId);
        try {
          sent(
            await nodeApi<Receipt>(id, "/messages", {
              commandId,
              agentId: agent,
              chatId: chat,
              sessionId: newTopic ? undefined : topic,
              operation: newTopic ? "topic" : topic ? "reply" : "main",
              selection,
              text,
              attachmentIds: attachments.map((f) => f.id),
            }),
          );
        } catch (e) {
          if (e instanceof APIError && e.status >= 400 && e.status < 500)
            clearPending();
          throw e;
        }
      } finally {
        applying.current = false;
      }
    },
  });
  const accessWithdrawn =
    pages.error instanceof APIError &&
    [401, 403, 404].includes(pages.error.status);
  useEffect(() => {
    if (accessWithdrawn) {
      sessionStorage.removeItem(draftKey);
      sessionStorage.removeItem(draftKey + ":command");
      sessionStorage.removeItem(attachmentKey);
    }
  }, [accessWithdrawn, draftKey, attachmentKey]);
  const focusedRecord = useRef("");
  useEffect(() => {
    if (
      !targetRecord ||
      !pages.isSuccess ||
      focusedRecord.current === targetRecord
    )
      return;
    const el = document.getElementById("hub-record-" + targetRecord);
    if (el) {
      el.scrollIntoView({ block: "center" });
      focusedRecord.current = targetRecord;
    }
  }, [targetRecord, pages.dataUpdatedAt, pages.isSuccess]);
  if (accessWithdrawn) return <ErrorNotice error={pages.error!} />;
  const history = (pages.data?.pages ?? []).slice().reverse();
  const requests = new Map(
    history.flatMap((p) => p.requests).map((r) => [r.id, r]),
  );
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
        <div className="mx-auto flex max-w-(--chat-content-width) flex-col gap-4">
          {pages.hasNextPage && (
            <Button
              variant="ghost"
              disabled={pages.isFetchingNextPage}
              onClick={() => void pages.fetchNextPage()}
            >
              加载更早对话
            </Button>
          )}
          {pages.isError && <ErrorNotice error={pages.error} />}
          {pages.isLoading && <Loading />}
          {history
            .flatMap((p) => p.runs)
            .map((run) => (
              <article
                id={"hub-record-" + run.id}
                key={run.id}
                className="flex min-w-0 flex-col gap-2"
              >
                <UserMessage
                  message={run}
                  apiBase={apiBase}
                  showAttachments={showAttachments}
                  previewFiles={previewFiles}
                />
                {responseParts(run.items ?? []).map((part) =>
                  Array.isArray(part) ? (
                    <RunActivity
                      key={part[0].id}
                      items={part}
                      runStatus={run.status}
                      live={node.online && run.status === "running"}
                      autoExpandThinking={
                        run.selection?.provider === "antigravity"
                      }
                      previewEndpoint={
                        previewFiles
                          ? `${apiBase}/runs/${encodeURIComponent(run.id)}/preview`
                          : undefined
                      }
                    />
                  ) : part.kind === "user" ? (
                    part.message && (
                      <UserMessage
                        key={part.id}
                        message={part.message}
                        apiBase={apiBase}
                        showAttachments={showAttachments}
                        previewFiles={previewFiles}
                      />
                    )
                  ) : (
                    <ChatMarkdown
                      key={part.id}
                      text={part.text}
                      citations={part.citations}
                      fallbackItems={run.items}
                      running={
                        node.online &&
                        run.status === "running" &&
                        part.status === "running"
                      }
                      endpoint={
                        previewFiles
                          ? `${apiBase}/runs/${encodeURIComponent(run.id)}/preview`
                          : undefined
                      }
                    />
                  ),
                )}
                {run.status === "unverifiable" && (
                  <p role="status">连接中断，运行结果待确认</p>
                )}
                {run.error && <p role="alert">{run.error}</p>}
                <RunActions node={node} run={run} />
              </article>
            ))}
          {history[history.length - 1]?.queue && (
            <NodeAction
              node={node}
              path={`/sessions/${history[history.length - 1].queue}/queue/resume`}
              label="恢复队列"
            />
          )}
          {[...requests.values()]
            .filter((r) => r.status !== "pending")
            .map((r) => (
              <p
                key={r.id}
                id={"hub-record-" + r.id}
                className="text-sm text-muted-foreground"
              >
                {r.title} ·{" "}
                {r.answer ? (r.answer.allow ? "已允许" : "已拒绝") : "已处理"}
              </p>
            ))}
          {[...requests.values()]
            .filter((r) => r.status === "pending")
            .map((request) => (
              <div key={request.id} id={"hub-record-" + request.id}>
                <RequestCard
                  request={{ ...request, questions: request.questions ?? [] }}
                  onSubmit={async (answer) => {
                    if (!node.online) throw new Error("设备离线");
                    await confirmedAction(
                      id,
                      answer === "allow-run"
                        ? `/runs/${request.runId}/approvals`
                        : `/requests/${request.id}/answer`,
                      answer === "allow-run" ? {} : answer,
                    );
                    void qc.invalidateQueries({ queryKey: key });
                  }}
                />
              </div>
            ))}
        </div>
      </div>
      <form
        className="mx-auto flex w-full max-w-(--chat-content-width) items-end gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            !send.isPending &&
            node.online &&
            (pending || text.trim() || attachments.length)
          )
            send.mutate();
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {chat && !topic && (
              <Button
                type="button"
                variant={newTopic ? "secondary" : "ghost"}
                aria-pressed={newTopic}
                size="sm"
                disabled={!!pending}
                onClick={() => setNewTopic((v) => !v)}
              >
                发起话题
              </Button>
            )}
            {!!models.length && (
              <Select
                value={modelChoice || "default"}
                disabled={!!pending || !node.online}
                onValueChange={(v) => setModelChoice(v === "default" ? "" : v)}
              >
                <SelectTrigger size="sm" aria-label="运行模型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">沿用当前模型</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {binaryWorkspace && canUseFiles(node) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={binaryWorkspace}
              >
                附件与文件
              </Button>
            )}
          </div>
          {canUseFiles(node) && !binaryWorkspace && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="cursor-pointer text-muted-foreground">
                添加附件
                <input
                  aria-label="添加附件"
                  type="file"
                  className="sr-only"
                  disabled={
                    !node.online ||
                    !!pending ||
                    upload.isPending ||
                    attachments.length >= 8
                  }
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) upload.mutate(file);
                  }}
                />
              </label>
              {attachments.map((f) => (
                <Button
                  type="button"
                  key={f.id}
                  size="sm"
                  variant="ghost"
                  disabled={!!pending || upload.isPending}
                  onClick={() =>
                    rememberAttachments(
                      attachments.filter((a) => a.id !== f.id),
                    )
                  }
                >
                  {f.name} ×
                </Button>
              ))}
            </div>
          )}
          {upload.error && <ErrorNotice error={upload.error} />}
          {send.isError && <ErrorNotice error={send.error} />}
          {!node.online && (
            <p role="status" className="text-sm text-muted-foreground">
              设备离线。草稿已保留，上线后可加载更早历史。
            </p>
          )}
          <Textarea
            value={text}
            aria-label="消息"
            placeholder="发送消息"
            readOnly={!!pending}
            onChange={(e) => change(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={
            !node.online ||
            send.isPending ||
            (!text.trim() && attachments.length === 0) ||
            upload.isPending ||
            node.draining
          }
        >
          {pending ? (unconfirmed ? "重新提交" : "查询发送结果") : "发送"}
        </Button>
      </form>
    </>
  );
}

type HistoryPage = {
  runs: Run[];
  requests: ChatView["requests"];
  next?: number;
  queue?: string;
};

async function confirmedAction(id: string, path: string, body: unknown = {}) {
  const key = `lever:node:${id}:action:${path}`;
  const previous = sessionStorage.getItem(key);
  if (previous) {
    try {
      const receipt = await nodeApi<Receipt>(id, "/commands/" + previous);
      sessionStorage.removeItem(key);
      return receipt;
    } catch (e) {
      if (!(e instanceof APIError && e.status === 404)) throw e;
    }
  }
  const commandId = previous || crypto.randomUUID();
  sessionStorage.setItem(key, commandId);
  try {
    const result = await nodeApi<Receipt>(id, path, {
      ...(body as object),
      commandId,
    });
    sessionStorage.removeItem(key);
    return result;
  } catch (e) {
    if (e instanceof APIError && e.status >= 400 && e.status < 500)
      sessionStorage.removeItem(key);
    throw e;
  }
}
function NodeAction({
  node,
  path,
  label,
}: {
  node: NodeDescriptor;
  path: string;
  label: string;
}) {
  const qc = useQueryClient();
  const action = useMutation({
    mutationFn: () => confirmedAction(node.nodeId, path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["node", node.nodeId] }),
  });
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        disabled={!node.online || action.isPending}
        onClick={() => action.mutate()}
      >
        {label}
      </Button>
      {action.error && <ErrorNotice error={action.error} />}
    </div>
  );
}
function RunActions({ node, run }: { node: NodeDescriptor; run: Run }) {
  if (!node.online || run.superseded) return null;
  let op: string, label: string;
  switch (run.status) {
    case "paused":
      op = "resume";
      label = "继续";
      break;
    case "interrupted":
    case "failed":
      op = "retry";
      label = run.items?.length ? "继续或重试" : "重试";
      break;
    case "unknown":
      op = "resolve";
      label = "确认执行已结束";
      break;
    case "starting":
    case "running":
    case "waiting_user":
      op = run.canPause ? "pause" : "stop";
      label = run.canPause ? "暂停" : "停止";
      break;
    default:
      return null;
  }
  return (
    <NodeAction node={node} path={`/runs/${run.id}/${op}`} label={label} />
  );
}
function NodeChanges({
  node,
  agentId,
  sessionId,
}: {
  node: NodeDescriptor;
  agentId: string;
  sessionId?: string;
}) {
  const review = useQuery({
    queryKey: ["node", node.nodeId, "changes", agentId, sessionId],
    queryFn: () =>
      nodeApi<TurnReview>(
        node.nodeId,
        `/agents/${agentId}/changes?sessionId=${encodeURIComponent(sessionId ?? "")}`,
      ),
  });
  if (review.error) return <ErrorNotice error={review.error} />;
  if (!review.data) return <Loading />;
  const files = (review.data.changes ?? []).flatMap((c) =>
    (c.files ?? []).map((f) => ({ ...f, root: c.root.id })),
  );
  return (
    <div className="overflow-auto p-4">
      <p className="mb-2 text-sm text-muted-foreground">
        当前显示变更摘要。完整 Diff 需要目标设备开放工作区权限。
      </p>
      {files.map((f) => (
        <div className="flex gap-3 text-sm" key={f.root + "/" + f.path}>
          <span>{f.path}</span>
          <span>
            +{f.additions} −{f.deletions}
          </span>
        </div>
      ))}
      {!files.length && <p>本轮没有文件变更。</p>}
    </div>
  );
}
