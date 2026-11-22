import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { GitRootSummary, Root } from "@/api/types.gen";
import { scopeParams } from "@/features/worktrees/scope";

export {
  formatCompactCommitTime,
  summarizeGitRoots,
  type DiffTarget,
} from "./gitSummary";

export function useGitSummary(
  agentId: string | undefined,
  roots: Root[] | undefined,
  sessionId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["git-summary", agentId, sessionId ?? "", roots],
    queryFn: ({ signal }) =>
      api<GitRootSummary[]>(
        `/agents/${encodeURIComponent(agentId!)}/git-summary?${new URLSearchParams(scopeParams(sessionId))}`,
        undefined,
        "GET",
        signal,
      ),
    enabled: enabled && !!agentId && !!roots?.length,
    refetchOnWindowFocus: "always",
  });
}
