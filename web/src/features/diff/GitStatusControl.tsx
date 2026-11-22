import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FileDiff,
  GitBranch,
  GitCompare,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Agent, GitCommit, GitRootSummary } from "@/api/types.gen";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { rootName } from "@/features/files/filePaths";
import { scopeParams } from "@/features/worktrees/scope";
import { cn } from "@/lib/utils";
import {
  formatCompactCommitTime,
  summarizeGitRoots,
  useGitSummary,
  type DiffTarget,
} from "./useGitSummary";

const previewCommitCount = 5;

function CommitTime({ timestamp }: { timestamp?: string }) {
  const { i18n } = useTranslation();
  if (!timestamp) return null;
  const formatted = formatCompactCommitTime(timestamp, i18n.language);
  if (!formatted) return null;
  return (
    <time
      className="git-status-commit-time"
      dateTime={timestamp}
      title={formatted.full}
    >
      {formatted.displayed}
    </time>
  );
}

function LineStats({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("diff-stats", className)}>
      <span className={additions > 0 ? "diff-added" : "text-muted-foreground"}>
        +{additions}
      </span>
      <span className={deletions > 0 ? "diff-removed" : "text-muted-foreground"}>
        −{deletions}
      </span>
    </span>
  );
}

function branchLabel(repo: GitRootSummary, detached: string) {
  if (repo.branch) return repo.branch;
  if (repo.head) return `${detached} · ${repo.head.slice(0, 7)}`;
  return detached;
}

export function GitStatusControl({
  agent,
  sessionId,
  enabled,
  active,
  onOpenDiff,
}: {
  agent: Agent;
  sessionId?: string;
  enabled: boolean;
  active?: boolean;
  onOpenDiff: (target: DiffTarget) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selectedRootId, setSelectedRootId] = useState<string>();
  const [expandedCommits, setExpandedCommits] = useState(false);

  const summary = useGitSummary(
    agent.id,
    agent.profile.roots,
    sessionId,
    enabled,
  );
  const repos = summary.data ?? [];
  const activeRepo =
    repos.find((item) => item.root.id === selectedRootId) ??
    repos.find((item) => item.root.id === agent.profile.primaryRootId) ??
    repos[0];

  const commits = useQuery({
    queryKey: [
      "commits",
      agent.id,
      activeRepo?.root.id,
      activeRepo?.root.path,
      sessionId,
    ],
    enabled: enabled && open && !!activeRepo && !activeRepo.error,
    queryFn: ({ signal }) =>
      api<GitCommit[]>(
        `/agents/${encodeURIComponent(agent.id)}/commits?${new URLSearchParams({
          root: activeRepo!.root.id,
          ...scopeParams(sessionId),
        })}`,
        undefined,
        "GET",
        signal,
      ),
  });

  const totals = summarizeGitRoots(summary.data);
  const hasLineStats = totals.additions > 0 || totals.deletions > 0;
  const hasFileOnly = !hasLineStats && totals.files > 0;
  const triggerCompact = !hasLineStats && !hasFileOnly;

  const triggerTitleParts = [t("git.status")];
  if (activeRepo && !activeRepo.error) {
    triggerTitleParts.push(branchLabel(activeRepo, t("git.detachedHead")));
  }
  if (hasLineStats) {
    triggerTitleParts.push(`+${totals.additions} −${totals.deletions}`);
  } else if (hasFileOnly) {
    triggerTitleParts.push(t("git.changedFiles", { count: totals.files }));
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setExpandedCommits(false);
      void summary.refetch();
      if (activeRepo && !activeRepo.error) void commits.refetch();
    }
  }

  function refresh() {
    void summary.refetch();
    if (activeRepo && !activeRepo.error) void commits.refetch();
  }

  function openWorkingDiff(rootId: string) {
    setOpen(false);
    onOpenDiff({
      key: crypto.randomUUID(),
      rootId,
      mode: "working",
    });
  }

  function openCommitDiff(rootId: string, hash: string) {
    setOpen(false);
    onOpenDiff({
      key: crypto.randomUUID(),
      rootId,
      mode: "committed",
      commit: hash,
    });
  }

  const refreshing = summary.isFetching || (open && commits.isFetching);
  const commitList = commits.data ?? [];
  const visibleCommits = expandedCommits
    ? commitList
    : commitList.slice(0, previewCommitCount);
  const hiddenCommitCount = commitList.length - visibleCommits.length;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={triggerCompact ? "icon-sm" : "sm"}
          className={cn(
            "git-status-trigger",
            !triggerCompact && "git-status-trigger-expanded",
            active && "text-foreground bg-accent",
          )}
          aria-label={t("git.status")}
          title={triggerTitleParts.join(" · ")}
        >
          <GitCompare aria-hidden="true" />
          {hasLineStats ? (
            <LineStats
              additions={totals.additions}
              deletions={totals.deletions}
              className="git-status-trigger-stats"
            />
          ) : hasFileOnly ? (
            <span className="git-status-trigger-count tabular-nums">
              {totals.files}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="git-status-popover"
        aria-label={t("git.status")}
      >
        <div className="git-status-header">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {repos.length === 1 && activeRepo
                ? rootName(activeRepo.root)
                : t("git.repositories")}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("git.refresh")}
            title={t("git.refresh")}
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw
              className={cn(refreshing && "animate-spin")}
              aria-hidden="true"
            />
          </Button>
        </div>

        {summary.isPending && !summary.data ? (
          <div className="git-status-section space-y-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        ) : summary.error && !summary.data ? (
          <div className="git-status-section text-xs text-destructive">
            {summary.error.message || t("git.loadFailed")}
          </div>
        ) : !activeRepo ? (
          <div className="git-status-section text-xs text-muted-foreground">
            {t("diff.noRepository")}
          </div>
        ) : (
          <>
            {repos.length > 1 && (
              <div
                className="git-status-repos"
                role="listbox"
                aria-label={t("git.repositories")}
              >
                {repos.map((repo) => {
                  const selected = repo.root.id === activeRepo.root.id;
                  const dirty = !repo.error && repo.files > 0;
                  const repoHasLines =
                    dirty && (repo.additions > 0 || repo.deletions > 0);
                  return (
                    <button
                      key={repo.root.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={cn("git-status-repo", selected && "selected")}
                      title={repo.root.path}
                      onClick={() => {
                        setSelectedRootId(repo.root.id);
                        setExpandedCommits(false);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {rootName(repo.root)}
                        </span>
                        <span className="git-status-repo-branch block truncate text-xs text-muted-foreground">
                          {repo.error
                            ? t("git.loadFailed")
                            : branchLabel(repo, t("git.detachedHead"))}
                        </span>
                      </span>
                      {repoHasLines ? (
                        <LineStats
                          additions={repo.additions}
                          deletions={repo.deletions}
                        />
                      ) : dirty ? (
                        <span className="git-status-repo-branch text-xs text-muted-foreground tabular-nums">
                          {t("git.changedFiles", { count: repo.files })}
                        </span>
                      ) : !repo.error ? (
                        <Check
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="git-status-section">
              <div className="git-status-branch-row">
                <GitBranch
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span
                  className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground"
                  title={branchLabel(activeRepo, t("git.detachedHead"))}
                >
                  {branchLabel(activeRepo, t("git.detachedHead"))}
                </span>
                {!!activeRepo.ahead && (
                  <span
                    className="git-status-sync"
                    title={t("git.ahead", { count: activeRepo.ahead })}
                    aria-label={t("git.ahead", { count: activeRepo.ahead })}
                  >
                    <ArrowUp className="size-3" aria-hidden="true" />
                    {activeRepo.ahead}
                  </span>
                )}
                {!!activeRepo.behind && (
                  <span
                    className="git-status-sync"
                    title={t("git.behind", { count: activeRepo.behind })}
                    aria-label={t("git.behind", { count: activeRepo.behind })}
                  >
                    <ArrowDown className="size-3" aria-hidden="true" />
                    {activeRepo.behind}
                  </span>
                )}
              </div>
              {activeRepo.upstream && (
                <div className="git-status-upstream truncate">
                  {activeRepo.upstream}
                </div>
              )}

              {activeRepo.error ? (
                <p className="mt-2 text-xs text-destructive">
                  {activeRepo.error}
                </p>
              ) : (
                <button
                  type="button"
                  className="git-status-action-row"
                  onClick={() => openWorkingDiff(activeRepo.root.id)}
                >
                  {activeRepo.files > 0 ? (
                    <FileDiff
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <Check
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {activeRepo.files > 0
                        ? t("git.uncommitted")
                        : t("git.clean")}
                    </span>
                    {activeRepo.files > 0 && (
                      <span
                        className="block truncate text-xs text-muted-foreground tabular-nums"
                        title={
                          activeRepo.truncated
                            ? t("git.statsTruncated")
                            : undefined
                        }
                      >
                        {t("git.changedFiles", { count: activeRepo.files })}
                      </span>
                    )}
                  </span>
                  {activeRepo.files > 0 ? (
                    <LineStats
                      additions={activeRepo.additions}
                      deletions={activeRepo.deletions}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t("diff.viewChanges")}
                    </span>
                  )}
                  <ChevronRight
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>

            {!activeRepo.error && (
              <div className="git-status-commits">
                <div className="git-status-section-title">
                  {t("git.recentCommits")}
                </div>
                {commits.isPending && !commits.data ? (
                  <div className="space-y-1.5 px-1 py-1">
                    <Skeleton className="h-9 w-full rounded-md" />
                    <Skeleton className="h-9 w-full rounded-md" />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                ) : commits.error ? (
                  <p className="px-2 py-1.5 text-xs text-destructive">
                    {commits.error.message}
                  </p>
                ) : visibleCommits.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {t("diff.noCommits")}
                  </p>
                ) : (
                  <>
                    <div className="git-status-commit-list">
                      {visibleCommits.map((item) => (
                        <button
                          key={item.hash}
                          type="button"
                          className="git-status-commit-row"
                          title={item.subject}
                          onClick={() =>
                            openCommitDiff(activeRepo.root.id, item.hash)
                          }
                        >
                          <span className="truncate text-[13px] text-foreground">
                            {item.subject}
                          </span>
                          <span className="git-status-commit-meta">
                            <code className="font-mono text-xs text-muted-foreground">
                              {item.hash.slice(0, 7)}
                            </code>
                            <CommitTime timestamp={item.committedAt} />
                          </span>
                        </button>
                      ))}
                    </div>
                    {(hiddenCommitCount > 0 || expandedCommits) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 w-full justify-center text-xs text-muted-foreground"
                        onClick={() => setExpandedCommits((v) => !v)}
                      >
                        {expandedCommits
                          ? t("git.showFewerCommits")
                          : t("git.showMoreCommits", {
                              count: hiddenCommitCount,
                            })}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
