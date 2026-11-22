import { WorkspaceSession, scopeParams } from "@/features/worktrees/scope";
import { useTranslation } from "react-i18next";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  parsePatchFiles,
  type CodeViewItem,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { JSONContent } from "@tiptap/core";
import {
  CodeView,
  type CodeViewHandle,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  EyeOff,
  FileCode2,
  FileText,
  Folders,
  GitCompare,
  MoreHorizontal,
  MessageSquareQuote,
  RefreshCw,
  Rows3,
  TextCursorInput,
  WrapText,
} from "lucide-react";
import { toast } from "sonner";
import type {
  Agent,
  DiffResult,
  GitBranches,
  GitCommit,
  Root,
  TurnReview,
} from "@/api/types.gen";
import { api, queryClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { ErrorNotice, Loading } from "@/components/common";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import {
  absoluteFilePath,
  resolveWorkspaceFile,
  rootName,
  workspaceFilePath,
} from "@/features/files/filePaths";
import { DiffStats, type TurnSelection } from "./TurnChanges";
import { selectedCode } from "./selectedCode";
import { DiffFileTree, prepareDiffFileTree } from "./DiffFileTree";
import { BranchPicker } from "./BranchPicker";
import { useGitRoots } from "./useGitRoots";
import {
  formatCompactCommitTime,
  type DiffTarget,
} from "./useGitSummary";

const defaults = {
  split: false,
  wrap: true,
  words: true,
  full: false,
  whitespace: false,
  sidebar: true,
};
const diffMetrics = { lineHeight: 21, diffHeaderHeight: 44 };
const diffLayout = { paddingTop: 0, paddingBottom: 0, gap: 0 };
const workerPoolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: 2,
};
const highlighterOptions = { lineDiffType: "word" as const };
// Hiding word emphasis is a display setting; keep the shared highlight cache.
const hiddenWordDiffs = {
  "--diffs-bg-addition-emphasis-override": "transparent",
  "--diffs-bg-deletion-emphasis-override": "transparent",
} as CSSProperties;
// Equal-width columns must not resize as different wrapped lines are mounted.
const diffCSS = `
[data-diff-type="split"][data-overflow="wrap"] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}
`;
function readPreferences(): typeof defaults {
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem("lever:diff-preferences") ?? "{}"),
    };
  } catch {
    return defaults;
  }
}

export default function Diff({
  agent,
  dark,
  canReview,
  openFile,
  initialTurn,
  target,
  onFeedback,
}: {
  agent: Agent;
  dark: boolean;
  canReview: boolean;
  openFile: (root: Root, path: string) => void;
  initialTurn?: TurnSelection;
  target?: DiffTarget;
  onFeedback: (sessionId: string, content: JSONContent[]) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const sessionId = useContext(WorkspaceSession);
  const gitRoots = useGitRoots(agent.id, agent.profile.roots, sessionId);
  const [rootID, setRootID] = useState(
    initialTurn?.rootId ?? target?.rootId ?? agent.profile.primaryRootId,
  );
  const [mode, setMode] = useState(
    initialTurn ? "turn" : (target?.mode ?? "working"),
  );
  const [commit, setCommit] = useState(target?.commit ?? "HEAD");
  const [branchSelections, setBranchSelections] = useState<
    Record<string, { base: string; head: string }>
  >({});
  const [prefs, setPrefs] = useState(readPreferences);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(initialTurn?.path ?? "");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<{
    file: FileDiffMetadata;
    range: SelectedLineRange;
  }>();
  const [replying, setReplying] = useState(false);
  const viewer = useRef<CodeViewHandle<undefined>>(null);
  const pendingReveal = useRef<string>(undefined);
  const reviewingTurn = mode === "turn";
  const [latestReview, setLatestReview] = useState<TurnReview>();
  const changes = useQuery({
    queryKey: ["changes", agent.id, sessionId, initialTurn?.runId, canReview],
    enabled: canReview && reviewingTurn && (!!initialTurn || !latestReview),
    queryFn: ({ signal }) =>
      api<TurnReview>(
        `/agents/${agent.id}/changes?${new URLSearchParams({ ...scopeParams(sessionId), run: initialTurn?.runId ?? "" })}`,
        undefined,
        "GET",
        signal,
      ),
  });
  // A later completion must not switch files beneath an open review. Refresh
  // explicitly resolves the latest run again.
  useEffect(() => {
    if (
      reviewingTurn &&
      !initialTurn &&
      !latestReview &&
      changes.data?.runId &&
      !changes.isFetching
    )
      setLatestReview(changes.data);
  }, [
    reviewingTurn,
    initialTurn,
    latestReview,
    changes.data,
    changes.isFetching,
  ]);
  const review =
    reviewingTurn && !initialTurn
      ? (latestReview ?? changes.data)
      : changes.data;
  const native = reviewingTurn ? review?.turnDiff : undefined;
  const roots = native
    ? [native.root]
    : reviewingTurn
      ? (review?.changes.map((change) => change.root) ?? [])
      : (gitRoots.data ?? []);
  const root =
    roots.find((r) => r.id === rootID) ??
    roots.find((r) => r.id === agent.profile.primaryRootId) ??
    roots[0];
  const branches = useQuery({
    queryKey: ["branches", agent.id, root?.id, root?.path, sessionId],
    enabled: !!root && mode === "branch",
    queryFn: ({ signal }) =>
      api<GitBranches>(
        `/agents/${agent.id}/branches?${new URLSearchParams({ root: root!.id, ...scopeParams(sessionId) })}`,
        undefined,
        "GET",
        signal,
      ),
  });
  const rootKey = `${root?.id}:${root?.path}`;
  const branchRefs = branchSelections[rootKey] ?? {
    base: branches.data?.defaultBase ?? "",
    head: branches.data?.current || branches.data?.defaultBase || "",
  };
  const branchReady =
    mode !== "branch" || !!(branchRefs.base && branchRefs.head);
  function chooseBranch(side: "base" | "head", ref: string) {
    setBranchSelections((previous) => ({
      ...previous,
      [rootKey]: { ...(previous[rootKey] ?? branchRefs), [side]: ref },
    }));
  }
  const commits = useQuery({
    queryKey: ["commits", agent.id, root?.id, root?.path, sessionId],
    enabled: false,
    queryFn: ({ signal }) =>
      api<GitCommit[]>(
        `/agents/${agent.id}/commits?${new URLSearchParams({ root: root!.id, ...scopeParams(sessionId) })}`,
        undefined,
        "GET",
        signal,
      ),
  });
  const change =
    reviewingTurn && !native
      ? review?.changes.find((c) => c.root.id === root?.id)
      : undefined;
  const turnAvailable = native
    ? native.reported && !native.error
    : !!change?.after && !change.error;
  const canFetchDiff =
    !!root &&
    branchReady &&
    (!reviewingTurn || (turnAvailable && !!review?.runId));
  const diffParams = {
    root: root?.id ?? "",
    mode,
    base: mode === "branch" ? branchRefs.base : "",
    head: mode === "branch" ? branchRefs.head : commit,
    run: reviewingTurn ? (review?.runId ?? "") : "",
    full: String(!native && prefs.full),
    ignoreWhitespace: String(!native && prefs.whitespace),
  };
  const diffKey = [
    "diff",
    agent.id,
    root?.path,
    diffParams,
    change?.after,
    sessionId,
  ];
  function fetchDiff(signal: AbortSignal, path = "") {
    return api<DiffResult>(
      `/agents/${agent.id}/diff?${new URLSearchParams({ ...diffParams, ...scopeParams(sessionId), path })}`,
      undefined,
      "GET",
      signal,
    );
  }
  const query = useQuery({
    queryKey: diffKey,
    enabled: canFetchDiff,
    queryFn: ({ signal }) => fetchDiff(signal),
  });
  const files = useMemo(() => query.data?.files ?? [], [query.data?.files]);
  const fileTree = useMemo(() => {
    const needle = filter.toLowerCase();
    return prepareDiffFileTree(
      files.filter((file) => file.path.toLowerCase().includes(needle)),
    );
  }, [files, filter]);
  const visible = fileTree.files;
  const activeIndex = Math.max(
    0,
    visible.findIndex((file) => file.path === selected),
  );
  const activePath = visible[activeIndex]?.path;
  const singleFile = query.data?.singleFile === true;
  const displayed = useMemo(
    () => (singleFile ? visible.slice(activeIndex, activeIndex + 1) : visible),
    [singleFile, visible, activeIndex],
  );
  const fileQuery = useQuery({
    queryKey: [...diffKey, "file", activePath, query.dataUpdatedAt],
    enabled: singleFile && !!activePath && canFetchDiff,
    queryFn: ({ signal }) => fetchDiff(signal, activePath!),
    gcTime: 0,
  });
  const patch = (singleFile ? fileQuery.data?.patch : query.data?.patch) ?? "";
  useEffect(() => {
    localStorage.setItem("lever:diff-preferences", JSON.stringify(prefs));
  }, [prefs]);
  const parsed = useMemo(() => {
    try {
      // Refreshes need new cache keys even when the file paths stay the same.
      return {
        files: parsePatchFiles(patch, crypto.randomUUID(), true).flatMap(
          (p) => p.files,
        ),
        error: null,
      };
    } catch (error) {
      return { files: [], error };
    }
  }, [patch]);
  const singlePath = singleFile ? activePath : undefined;
  const patches = useMemo(() => {
    const useNativePaths =
      native && parsed.files.length === (singlePath ? 1 : files.length);
    return new Map(
      parsed.files.map((file, index) => {
        // Codex can emit unquoted names with significant whitespace. Its file
        // index and the renderer consume the same ordered patch sections.
        const path = useNativePaths
          ? (singlePath ?? files[index]?.path ?? file.name)
          : file.name;
        return [
          path,
          file.name === path
            ? file
            : {
                ...file,
                name: path,
                prevName: file.prevName === file.name ? path : file.prevName,
              },
        ];
      }),
    );
  }, [parsed.files, native, singlePath, files]);
  const filesByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const itemVersion = useRef(0);
  const items = useMemo<CodeViewItem[]>(() => {
    // CodeView applies controlled content and collapse changes by version.
    const version = ++itemVersion.current;
    return displayed.map((file) => {
      const fileDiff = patches.get(file.path);
      const item = {
        id: file.path,
        collapsed: collapsed.has(file.path),
        version,
      };
      return fileDiff?.hunks.length && !file.binary
        ? { ...item, type: "diff", fileDiff }
        : {
            ...item,
            type: "file",
            file: {
              name: file.path,
              lang: "text",
              contents: t(file.binary ? "diff.binary" : "diff.metadata"),
            },
          };
    });
  }, [displayed, patches, collapsed, t]);
  useLayoutEffect(() => {
    const path = pendingReveal.current;
    if (!path || !viewer.current) return;
    pendingReveal.current = undefined;
    viewer.current.scrollTo({
      type: "item",
      id: path,
      align: "start",
      behavior: "instant",
    });
  }, [items, selected]);
  useEffect(() => setSelection(undefined), [patch, mode, root?.id]);
  const canFeedback =
    reviewingTurn && !!initialTurn?.sessionId && !agent.archived;
  async function feedback() {
    if (!selection || !initialTurn || !root) return;
    const content: JSONContent[] = selectedCode(
      selection.file,
      selection.range,
      prefs.split,
    ).flatMap((part) => {
      const text = part.text.replace(/\r?\n$/, "");
      return [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: t("diff.quoteSource", {
                path: native
                  ? (workspaceFilePath(part.path, root.path) ?? part.path)
                  : absoluteFilePath({ root, path: part.path }),
                side: t(
                  part.side === "deletions" ? "diff.oldSide" : "diff.newSide",
                ),
                lines:
                  part.start === part.end
                    ? part.start
                    : `${part.start}–${part.end}`,
              }),
            },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: selection.file.lang ?? "text" },
          ...(text ? { content: [{ type: "text", text }] } : {}),
        },
      ];
    });
    content.push({ type: "paragraph" });
    setReplying(true);
    try {
      await onFeedback(initialTurn.sessionId, content);
    } finally {
      setReplying(false);
    }
  }
  const allCollapsed =
    displayed.length > 0 && displayed.every((file) => collapsed.has(file.path));
  const initialRevealed = useRef<TurnSelection>(undefined);
  useEffect(() => {
    if (initialRevealed.current === initialTurn || !initialTurn) return;
    if (!reviewingTurn) {
      setMode("turn");
      return;
    }
    if (rootID !== initialTurn.rootId) {
      setRootID(initialTurn.rootId);
      return;
    }
    if (changes.isPending || (canFetchDiff && query.isPending)) return;
    setFilter("");
    if (initialTurn.path && filesByPath.has(initialTurn.path)) {
      reveal(initialTurn.path);
    }
    initialRevealed.current = initialTurn;
  }, [
    filesByPath,
    query.isPending,
    changes.isPending,
    canFetchDiff,
    initialTurn,
    reviewingTurn,
    rootID,
  ]);
  const appliedTarget = useRef<string | undefined>(target?.key);
  useEffect(() => {
    if (!target || appliedTarget.current === target.key) return;
    appliedTarget.current = target.key;
    setRootID(target.rootId);
    setMode(target.mode);
    if (target.mode === "committed" && target.commit) setCommit(target.commit);
    setFilter("");
    setSelected("");
    setCollapsed(new Set());
    void queryClient.invalidateQueries({ queryKey: ["diff", agent.id] });
  }, [target, agent.id]);
  function reveal(path: string) {
    pendingReveal.current = path;
    setSelected(path);
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
  }
  function toggle(path: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function refresh() {
    if (!reviewingTurn) {
      void gitRoots.refetch();
      void queryClient.invalidateQueries({
        queryKey: ["git-summary", agent.id],
      });
    } else if (canReview)
      void changes.refetch().then(({ data, isSuccess }) => {
        if (!initialTurn && isSuccess) setLatestReview(data);
      });
    if (root && mode === "branch") void branches.refetch();
    if (canFetchDiff) void query.refetch();
  }
  const unavailable = reviewingTurn && !turnAvailable;
  const noRepository = !reviewingTurn && gitRoots.data?.length === 0;
  const turnError = native ? native.error : change?.error;
  const error = reviewingTurn
    ? (changes.error ??
      (turnError ? new Error(turnError) : null) ??
      query.error)
    : ((!gitRoots.data ? gitRoots.error : null) ??
      (mode === "branch" ? branches.error : null) ??
      query.error);
  const loading =
    !error &&
    ((reviewingTurn ? canReview && changes.isPending : gitRoots.isPending) ||
      (mode === "branch" && !!root && branches.isPending) ||
      (canFetchDiff && query.isPending));
  const turnLabel = initialTurn ? t("diff.thisTurn") : t("diff.turn");
  const scopeLabel = reviewingTurn ? turnLabel : t(`diff.${mode}`);
  const navigation = (
    <>
      <ToolbarButton
        label={t("diff.previous")}
        disabled={activeIndex <= 0}
        onClick={() => reveal(visible[activeIndex - 1].path)}
      >
        <ArrowUp />
      </ToolbarButton>
      <ToolbarButton
        label={t("diff.next")}
        disabled={!activePath || activeIndex >= visible.length - 1}
        onClick={() => reveal(visible[activeIndex + 1].path)}
      >
        <ArrowDown />
      </ToolbarButton>
    </>
  );
  return (
    <TooltipProvider>
      <div className="diff-panel">
        <header className="diff-toolbar">
          <div className="diff-scope-pill">
            {roots.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="diff-project-trigger"
                    aria-label={t("diff.directory")}
                    title={root?.path}
                  >
                    <span className="truncate">{root && rootName(root)}</span>
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="diff-menu">
                  <DropdownMenuRadioGroup
                    value={root?.id}
                    onValueChange={(id) => {
                      setRootID(id);
                      setCommit("HEAD");
                      setFilter("");
                      setSelected("");
                      setCollapsed(new Set());
                    }}
                  >
                    {roots.map((item) => (
                      <DropdownMenuRadioItem
                        key={item.id}
                        value={item.id}
                        title={item.path}
                      >
                        <span className="truncate">{rootName(item)}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={t("diff.scope")}>
                  {scopeLabel}
                  {mode === "committed" && (
                    <code className="diff-commit-hash">
                      {commit.slice(0, 7)}
                    </code>
                  )}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="diff-menu">
                <DropdownMenuRadioGroup
                  value={mode}
                  onValueChange={(value) => {
                    if (!reviewingTurn) setLatestReview(undefined);
                    setMode(value);
                    setFilter("");
                  }}
                >
                  <DropdownMenuRadioItem value="turn">
                    {turnLabel}
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {["working", "unstaged", "staged"].map((value) => (
                    <DropdownMenuRadioItem value={value} key={value}>
                      {t(`diff.${value}`)}
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuSub
                    onOpenChange={(open) => {
                      if (open && root) void commits.refetch();
                    }}
                  >
                    <DropdownMenuSubTrigger disabled={!root}>
                      {t("diff.committed")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="diff-menu diff-commit-menu">
                      <DropdownMenuGroup>
                        {commits.isFetching && !commits.data ? (
                          <DropdownMenuItem disabled>
                            {t("common.loading")}
                          </DropdownMenuItem>
                        ) : commits.error ? (
                          <DropdownMenuItem disabled>
                            {commits.error.message}
                          </DropdownMenuItem>
                        ) : commits.data?.length ? (
                          commits.data.map((commit) => {
                            const committed = commit.committedAt
                              ? formatCompactCommitTime(
                                  commit.committedAt,
                                  i18n.language,
                                )
                              : null;
                            return (
                              <DropdownMenuItem
                                key={commit.hash}
                                onSelect={() => {
                                  setMode("committed");
                                  setCommit(commit.hash);
                                  setFilter("");
                                }}
                              >
                                <code className="text-xs text-muted-foreground">
                                  {commit.hash.slice(0, 7)}
                                </code>
                                <span className="min-w-0 flex-1 truncate">
                                  {commit.subject}
                                </span>
                                {committed && (
                                  <time
                                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                                    dateTime={commit.committedAt}
                                    title={committed.full}
                                  >
                                    {committed.displayed}
                                  </time>
                                )}
                                {mode === "committed" &&
                                  diffParams.head === commit.hash && (
                                    <Check className="shrink-0" />
                                  )}
                              </DropdownMenuItem>
                            );
                          })
                        ) : (
                          <DropdownMenuItem disabled>
                            {t("diff.noCommits")}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuRadioItem value="branch">
                    {t("diff.branch")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {!unavailable && !query.error && query.data && (
              <DiffStats files={files} />
            )}
          </div>
          {mode === "branch" && (
            <div
              className="diff-branch-pill"
              role="group"
              aria-label={t("diff.branchComparison")}
            >
              <BranchPicker
                label={t("diff.base")}
                value={branchRefs.base}
                branches={branches.data?.branches ?? []}
                onChange={(ref) => chooseBranch("base", ref)}
              />
              <ArrowRight aria-hidden="true" />
              <BranchPicker
                label={t("diff.head")}
                value={branchRefs.head}
                branches={branches.data?.branches ?? []}
                onChange={(ref) => chooseBranch("head", ref)}
              />
            </div>
          )}
          <div className="diff-toolbar-actions">
            {singleFile && (
              <>
                <span
                  className="diff-file-position"
                  aria-label={t("diff.filePosition")}
                >
                  {visible.length ? activeIndex + 1 : 0} / {visible.length}
                </span>
                {navigation}
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("diff.options")}
                  title={t("diff.options")}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="diff-menu">
                <DropdownMenuGroup>
                  <DropdownMenuCheckboxItem
                    disabled={!!native}
                    checked={!native && prefs.full}
                    onCheckedChange={(full) =>
                      setPrefs((p) => ({ ...p, full }))
                    }
                  >
                    <FileText />
                    {t("diff.full")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={prefs.words}
                    onCheckedChange={(words) =>
                      setPrefs((p) => ({ ...p, words }))
                    }
                  >
                    <TextCursorInput />
                    {t("diff.words")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    disabled={!!native}
                    checked={!native && prefs.whitespace}
                    onCheckedChange={(whitespace) =>
                      setPrefs((p) => ({ ...p, whitespace }))
                    }
                  >
                    <EyeOff />
                    {t("diff.whitespace")}
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!patch}
                    onSelect={() => {
                      void navigator.clipboard.writeText(patch).then(
                        () => toast.success(t("diff.copied")),
                        (error) => toast.error(String(error)),
                      );
                    }}
                  >
                    <Copy />
                    {t(singleFile ? "diff.copyFile" : "diff.copy")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <ToolbarButton label={t("diff.refresh")} onClick={refresh}>
              <RefreshCw
                className={
                  query.isFetching || changes.isFetching
                    ? "animate-spin"
                    : undefined
                }
              />
            </ToolbarButton>
            <ToolbarButton
              label={t("diff.wrap")}
              active={prefs.wrap}
              onClick={() => setPrefs((p) => ({ ...p, wrap: !p.wrap }))}
            >
              <WrapText />
            </ToolbarButton>
            <ToolbarButton
              label={allCollapsed ? t("diff.expand") : t("diff.collapse")}
              active={allCollapsed}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  for (const file of displayed) {
                    if (allCollapsed) next.delete(file.path);
                    else next.add(file.path);
                  }
                  return next;
                })
              }
            >
              {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
            </ToolbarButton>
            <ToolbarButton
              label={prefs.split ? t("diff.unified") : t("diff.split")}
              active={prefs.split}
              onClick={() => setPrefs((p) => ({ ...p, split: !p.split }))}
            >
              {prefs.split ? <Rows3 /> : <Columns2 />}
            </ToolbarButton>
            <ToolbarButton
              label={t("diff.fileList")}
              active={prefs.sidebar}
              onClick={() => setPrefs((p) => ({ ...p, sidebar: !p.sidebar }))}
            >
              <Folders />
            </ToolbarButton>
          </div>
        </header>
        <div className="diff-body">
          <div className="diff-viewer">
            <WorkerPoolContextProvider
              poolOptions={workerPoolOptions}
              highlighterOptions={highlighterOptions}
            >
              {loading ? (
                <Loading />
              ) : error ? (
                <ErrorNotice error={error} retry={refresh} />
              ) : noRepository ? (
                <div className="workspace-empty">
                  <GitCompare />
                  <h2>{t("diff.noRepository")}</h2>
                </div>
              ) : unavailable ? (
                <div className="workspace-empty">
                  <GitCompare />
                  <h2>
                    {t(
                      review?.runId ? "diff.noTurnDiff" : "diff.noFinishedTurn",
                    )}
                  </h2>
                </div>
              ) : mode === "branch" && !branchReady ? (
                <div className="workspace-empty">
                  <GitCompare />
                  <h2>{t("diff.noBranches")}</h2>
                </div>
              ) : parsed.error ? (
                <div className="diff-scroll">
                  <ErrorNotice error={parsed.error} />
                  <pre className="raw-diff">{patch}</pre>
                </div>
              ) : !files.length ? (
                <div className="workspace-empty">
                  <Check size={28} strokeWidth={1.4} />
                  <h2>{t("diff.empty")}</h2>
                </div>
              ) : !visible.length ? (
                <div className="workspace-empty">
                  <h2>{t("diff.noMatches")}</h2>
                </div>
              ) : singleFile && fileQuery.isPending ? (
                <Loading />
              ) : singleFile && fileQuery.error ? (
                <ErrorNotice
                  error={fileQuery.error}
                  retry={() => void fileQuery.refetch()}
                />
              ) : (
                <CodeView
                  ref={viewer}
                  className="diff-scroll"
                  style={prefs.words ? undefined : hiddenWordDiffs}
                  key={singleFile ? activePath : "all"}
                  items={items}
                  selectedLines={
                    selection &&
                    patches.get(selection.file.name) === selection.file
                      ? { id: selection.file.name, range: selection.range }
                      : null
                  }
                  onSelectedLinesChange={(next) => {
                    const file = next && patches.get(next.id);
                    setSelection(
                      file?.hunks.length && next
                        ? { file, range: next.range }
                        : undefined,
                    );
                  }}
                  options={{
                    diffStyle: prefs.split ? "split" : "unified",
                    themeType: dark ? "dark" : "light",
                    overflow: prefs.wrap ? "wrap" : "scroll",
                    lineDiffType: "word",
                    expandUnchanged: prefs.full,
                    enableLineSelection: canFeedback,
                    stickyHeaders: true,
                    pointerEventsOnScroll: true,
                    itemMetrics: diffMetrics,
                    layout: diffLayout,
                    unsafeCSS: diffCSS,
                  }}
                  onScroll={(scrollTop, instance) => {
                    if (singleFile) return;
                    let path = visible[0]?.path;
                    for (const file of visible) {
                      const top = instance.getTopForItem(file.path);
                      if (
                        top === undefined ||
                        top > scrollTop + diffMetrics.diffHeaderHeight
                      )
                        break;
                      path = file.path;
                    }
                    if (path && path !== selected) setSelected(path);
                  }}
                  renderCustomHeader={({ id }) => {
                    const file = filesByPath.get(id);
                    if (!file) return null;
                    const patch = patches.get(id);
                    const target = native
                      ? resolveWorkspaceFile(
                          id,
                          native.root.path,
                          agent.profile.roots,
                        )
                      : root &&
                          agent.profile.roots.some(
                            (r) => r.id === root.id && r.path === root.path,
                          )
                        ? { root, path: id }
                        : null;
                    return (
                      <header className="diff-file-header" data-path={id}>
                        <Button
                          variant="ghost"
                          className="diff-file-title"
                          aria-expanded={!collapsed.has(id)}
                          onClick={() => toggle(id)}
                        >
                          {collapsed.has(id) ? (
                            <ChevronRight />
                          ) : (
                            <ChevronDown />
                          )}
                          <FileCode2 />
                          <span className="truncate" title={id}>
                            {id}
                          </span>
                        </Button>
                        <DiffStats files={[file]} />
                        {canFeedback &&
                          selection &&
                          selection.file === patch && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={replying}
                              onClick={() => void feedback()}
                            >
                              <MessageSquareQuote />
                              {t("diff.feedback")}
                            </Button>
                          )}
                        {file.status !== "D" && target && (
                          <ToolbarButton
                            label={t("diff.openFile")}
                            onClick={() => openFile(target.root, target.path)}
                          >
                            <FileText />
                          </ToolbarButton>
                        )}
                      </header>
                    );
                  }}
                />
              )}
            </WorkerPoolContextProvider>
          </div>
          {prefs.sidebar && (
            <aside
              className="diff-file-sidebar"
              aria-label={t("diff.fileList")}
            >
              <Input
                className="diff-filter"
                aria-label={t("diff.filter")}
                placeholder={t("diff.filter")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="diff-list-heading">
                <span>{t("diff.changedFiles")}</span>
                <span>{files.length}</span>
                {!singleFile && navigation}
              </div>
              <DiffFileTree
                tree={fileTree}
                selected={activePath}
                onSelect={reveal}
              />
            </aside>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
