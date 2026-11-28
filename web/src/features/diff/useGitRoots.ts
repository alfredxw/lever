import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Root } from "@/api/types.gen";
import { scopeParams } from "@/features/worktrees/scope";

export function useGitRoots(
  agentId: string | undefined,
  roots: Root[] | undefined,
  sessionId?: string,
  nodeId?: string,
) {
  return useQuery({
    queryKey: [
      "git-roots",
      nodeId ? [nodeId, agentId] : agentId,
      sessionId,
      roots,
    ],
    queryFn: ({ signal }) =>
      api<Root[]>(
        `${nodeId ? "/nodes/" + encodeURIComponent(nodeId) : ""}/agents/${encodeURIComponent(agentId!)}/git-roots?${new URLSearchParams(scopeParams(sessionId))}`,
        undefined,
        "GET",
        signal,
      ),
    enabled: !!agentId && !!roots?.length,
    refetchOnWindowFocus: "always",
  });
}
