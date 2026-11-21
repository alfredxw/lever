import { queryOptions, useQuery } from "@tanstack/react-query";
import type { CopyCheckout, CopyOptions, WorkingCopy } from "@/api/types.gen";
import { api } from "@/api/client";
import { directoryName } from "@/lib/paths";

export const copyPath = (agentId: string) =>
  `/agents/${agentId}/working-copies`;
export const copyKey = (agentId: string) =>
  ["working-copies", agentId] as const;
export const worktreePath = (agentId: string) => `/agents/${agentId}/worktrees`;
export const worktreeKey = (agentId: string) => ["worktrees", agentId] as const;
export const worktreeOptionsKey = (agentId: string) =>
  ["worktree-options", agentId] as const;

export const workingCopiesQuery = (agentId: string) =>
  queryOptions({
    queryKey: copyKey(agentId),
    queryFn: () => api<WorkingCopy[]>(copyPath(agentId)),
  });

export function useWorkingCopies(
  agentId: string,
  enabled: boolean,
  refetchInterval: number | false = false,
) {
  return useQuery({
    ...workingCopiesQuery(agentId),
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval,
  });
}

export function useWorkingCopyOptions(agentId: string, requestId: string) {
  return useQuery({
    queryKey: [...worktreeOptionsKey(agentId), requestId],
    queryFn: () =>
      api<CopyOptions>(`${copyPath(agentId)}/options?requestId=${requestId}`),
  });
}

export function availableGroup(copy?: WorkingCopy) {
  return copy?.state === "ready" && !copy.archived && !copy.error;
}

export function checkoutName(
  checkout: Pick<CopyCheckout, "name" | "branch" | "path">,
) {
  return (
    checkout.name ||
    (checkout.branch !== "HEAD" && checkout.branch) ||
    directoryName(checkout.path)
  );
}

export function groupSummary(copy: WorkingCopy) {
  return copy.checkouts
    .map(
      (checkout) =>
        `${directoryName(checkout.source)} → ${checkoutName(checkout)}`,
    )
    .join(" · ");
}
