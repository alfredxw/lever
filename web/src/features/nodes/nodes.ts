import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { NodeDescriptor } from "@/api/hub.gen";
import type { Agent, Chat, Conversation } from "@/api/types.gen";

export interface NodeOverview {
  node: NodeDescriptor;
  agents: Agent[];
  chats: Chat[];
  conversations: Conversation[];
  cursor: number;
  route?: string;
  rttMs?: number;
}
export const nodeAgentKey = (nodeId: string, agentId: string) =>
  `node/${nodeId}/${agentId}`;
export const nodePath = (id: string, path: string) =>
  `/nodes/${encodeURIComponent(id)}${path}`;

export const nodeApi = <T>(
  id: string,
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
) => api<T>(nodePath(id, path), body, method, signal);

export const canUseFiles = (n: NodeDescriptor) =>
  n.features?.includes("fs_v1") &&
  ["workspace", "admin"].includes(n.accessLevel);

export function clearNodeState(id: string, client: QueryClient) {
  client.removeQueries({ queryKey: ["node", id] });
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith(`lever:node:${id}:`)) sessionStorage.removeItem(key);
}
