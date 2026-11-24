import { queryOptions, useQuery } from "@tanstack/react-query";
import type { CopyCheckout, CopyOptions, WorkingCopy } from "@/api/types.gen";
import { api } from "@/api/client";
import { directoryName } from "@/lib/paths";

export type WorktreeOwner = "agent" | "project";

export const copyPath = (id: string, owner: WorktreeOwner = "agent") =>
  `/${owner === "project" ? "projects" : "agents"}/${id}/working-copies`;
export const copyKey = (id: string, owner: WorktreeOwner = "agent") =>
  owner === "project"
    ? (["working-copies", "project", id] as const)
    : (["working-copies", id] as const);
export const worktreePath = (id: string, owner: WorktreeOwner = "agent") =>
  `/${owner === "project" ? "projects" : "agents"}/${id}/worktrees`;
export const worktreeKey = (id: string, owner: WorktreeOwner = "agent") =>
  owner === "project"
    ? (["worktrees", "project", id] as const)
    : (["worktrees", id] as const);
export const worktreeOptionsKey = (
  id: string,
  owner: WorktreeOwner = "agent",
) =>
  owner === "project"
    ? (["worktree-options", "project", id] as const)
    : (["worktree-options", id] as const);

export const workingCopiesQuery = (
  id: string,
  owner: WorktreeOwner = "agent",
) =>
  queryOptions({
    queryKey: copyKey(id, owner),
    queryFn: () => api<WorkingCopy[]>(copyPath(id, owner)),
  });

export function useWorkingCopies(
  id: string,
  enabled: boolean,
  refetchInterval: number | false = false,
  owner: WorktreeOwner = "agent",
) {
  return useQuery({
    ...workingCopiesQuery(id, owner),
    enabled: enabled && !!id,
    refetchOnWindowFocus: true,
    refetchInterval,
  });
}

export function useWorkingCopyOptions(
  id: string,
  requestId: string,
  owner: WorktreeOwner = "agent",
) {
  return useQuery({
    queryKey: [...worktreeOptionsKey(id, owner), requestId],
    queryFn: () =>
      api<CopyOptions>(`${copyPath(id, owner)}/options?requestId=${requestId}`),
    enabled: !!id,
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
