import type { GitRootSummary } from "../../api/types.gen.ts";

export type DiffTarget = {
  key: string;
  rootId: string;
  mode: "working" | "committed";
  commit?: string;
};

export function summarizeGitRoots(roots: GitRootSummary[] | undefined) {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  for (const root of roots ?? []) {
    if (root.error) continue;
    files += root.files;
    additions += root.additions;
    deletions += root.deletions;
    if (root.truncated) truncated = true;
  }
  return { files, additions, deletions, truncated };
}

export function formatCompactCommitTime(
  timestamp: string,
  locale: string,
  now = new Date(),
) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const full = date.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const displayed =
    date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year:
            date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
  return { displayed, full };
}
