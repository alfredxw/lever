import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Event as LeverEvent } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentAvatar } from "@/features/agents/AgentAvatar";
import { nodeAgentKey, type NodeOverview } from "./nodes";

const directoryKey = ["remote", "nodes"] as const;

export function useNodeDirectory() {
  const client = useQueryClient();
  const directory = useQuery({
    queryKey: directoryKey,
    queryFn: () => api<NodeOverview[]>("/nodes"),
    refetchInterval: 5000,
  });
  const online = directory.data?.some(({ node }) => node.online) ?? false;
  useEffect(() => {
    if (!online) return;
    const nodes = client.getQueryData<NodeOverview[]>(directoryKey) ?? [];
    const cursors = Object.fromEntries(
      nodes.map((v) => [v.node.nodeId, v.cursor]),
    );
    const cursor = btoa(JSON.stringify(cursors))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const stream = new EventSource(
      `/api/events?scope=remote&after=v1.${cursor}`,
    );
    stream.onmessage = ({ data }) => {
      const e = JSON.parse(data) as LeverEvent;
      if (e.type !== "conversation-read" || !e.readSequence) return;
      const read = e.readSequence;
      client.setQueryData<NodeOverview[]>(directoryKey, (entries) =>
        entries?.map((v) => {
          if (v.node.nodeId !== e.nodeId) return v;
          const conversations = (v.conversations ?? []).map((c) =>
            c.id === e.sessionId
              ? { ...c, readSequence: Math.max(c.readSequence ?? 0, read) }
              : c,
          );
          return { ...v, conversations };
        }),
      );
    };
    return () => stream.close();
  }, [online, client]);
  return directory;
}

export function NodeFilter({
  nodes,
  value,
  onChange,
}: {
  nodes: NodeOverview[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mx-(--sidebar-gutter) mb-1">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" className="w-full" aria-label="按设备筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部设备</SelectItem>
          <SelectItem value="local">本机</SelectItem>
          {nodes.map(({ node }) => (
            <SelectItem key={node.nodeId} value={node.nodeId}>
              {node.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function NodeDirectory({
  nodes,
  filter,
  selected,
  onOpen,
}: {
  nodes: NodeOverview[];
  filter: string;
  selected: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex flex-col px-(--sidebar-gutter)">
      {nodes
        .filter((v) => filter === "all" || filter === v.node.nodeId)
        .flatMap(({ node, agents, conversations }) =>
          (agents ?? []).map((agent) => {
            const key = nodeAgentKey(node.nodeId, agent.id);
            const unread = conversations?.some(
              (c) =>
                c.agentId === agent.id &&
                c.unreadSequence > (c.readSequence ?? 0),
            );
            return (
              <Button
                className="min-w-0 justify-start gap-2 px-2"
                key={key}
                variant={selected === key ? "secondary" : "ghost"}
                onClick={() => onOpen(key)}
                title={agent.name + " · " + node.name}
              >
                <AgentAvatar
                  agent={
                    agent.avatar?.kind === "image"
                      ? { ...agent, avatar: undefined }
                      : agent
                  }
                  size="sm"
                />
                <span className="min-w-0 truncate">{agent.name}</span>
                {unread && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-foreground"
                    role="img"
                    aria-label="有未读消息"
                  />
                )}
                <span className="ml-auto flex max-w-[45%] items-center gap-1 text-xs font-normal text-muted-foreground">
                  <span
                    className={
                      node.online
                        ? "size-1.5 shrink-0 rounded-full bg-emerald-600"
                        : "size-1.5 shrink-0 rounded-full bg-muted-foreground"
                    }
                    aria-label={node.online ? "在线" : "离线"}
                  />
                  <span className="truncate">{node.name}</span>
                </span>
              </Button>
            );
          }),
        )}
    </div>
  );
}
