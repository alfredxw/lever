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
  type DiffLineAnnotation,
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
  MessageSquarePlus,
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
import { useEventCallback } from "@/hooks/useEventCallback";
import { DiffStats, type TurnSelection } from "./TurnChanges";
import { selectedCode } from "./selectedCode";
import { DiffFileTree, prepareDiffFileTree } from "./DiffFileTree";
import { BranchPicker } from "./BranchPicker";
import { useGitRoots } from "./useGitRoots";
import {
  formatCompactCommitTime,
  type DiffTarget,
} from "./useGitSummary";
import {
  buildReviewContent,
  buildReviewMarkdown,
  extractDraftAnchor,
  fileStatsFingerprint,
  isCommentOutdated,
  isFileViewed,
  loadReviewDraft,
  patchContentHash,
  reviewScopeKey,
  saveReviewDraft,
  sortReviewComments,
  type DiffFeedbackTarget,
  type DraftAnchor,
  type ReviewComment,
  type ReviewDraft,
  type ReviewSide,
} from "./reviewDraft";
import {
  ReviewAnnotationSlot,
  ReviewControls,
  type ReviewAnnotationMetadata,
} from "./ReviewAnnotation";

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
[data-utility-button]:focus,
[data-utility-button]:focus-visible {
  outline: none;
  box-shadow: none;
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
  reviewChatId,
  openFile,
  initialTurn,
  target,
  onFeedback,
}: {
  agent: Agent;
  dark: boolean;
  canReview: boolean;
  reviewChatId?: string;
  openFile: (root: Root, path: string) => void;
  initialTurn?: TurnSelection;
  target?: DiffTarget;
  onFeedback: (
    target: DiffFeedbackTarget,
    content: JSONContent[],
  ) => Promise<void>;
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
  const [draftAnchor, setDraftAnchor] = useState<DraftAnchor>();
  const [editingCommentId, setEditingCommentId] = useState<string>();
  const [replying, setReplying] = useState(false);
  const viewer = useRef<CodeViewHandle<ReviewAnnotationMetadata>>(null);
  const pendingReveal = useRef<string>(undefined);
  const pendingRevealLine = useRef<{
    path: string;
    lineNumber: number;
    side: ReviewSide;
  }>(undefined);
  const suppressNextSelection = useRef(false);
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
  const turnLabel = initialTurn ? t("diff.thisTurn") : t("diff.turn");
  const scopeLabel = reviewingTurn ? turnLabel : t(`diff.${mode}`);
  const canFeedback = !agent.archived;
  const feedbackTarget: DiffFeedbackTarget = initialTurn?.sessionId
    ? { agentId: agent.id, sessionId: initialTurn.sessionId }
    : sessionId
      ? { agentId: agent.id, sessionId }
      : reviewChatId
        ? { agentId: agent.id, chatId: reviewChatId }
        : { agentId: agent.id };
  const scopeKey = reviewScopeKey({
    agentId: agent.id,
    sessionId: initialTurn?.sessionId ?? sessionId,
    rootId: root?.id,
    mode,
    runId: review?.runId,
    commit: mode === "committed" ? commit : undefined,
    base: mode === "branch" ? branchRefs.base : undefined,
    head: mode === "branch" ? branchRefs.head : undefined,
  });
  const [reviewState, setReviewState] = useState<{
    key: string;
    draft: ReviewDraft;
  }>(() => ({ key: scopeKey, draft: loadReviewDraft(scopeKey) }));
  const reviewDraft =
    reviewState.key === scopeKey
      ? reviewState.draft
      : loadReviewDraft(scopeKey);
  useEffect(() => {
    setReviewState({ key: scopeKey, draft: loadReviewDraft(scopeKey) });
    setDraftAnchor(undefined);
    setEditingCommentId(undefined);
  }, [scopeKey]);
  function updateReviewDraft(updater: (previous: ReviewDraft) => ReviewDraft) {
    setReviewState((previous) => {
      const current =
        previous.key === scopeKey
          ? previous.draft
          : loadReviewDraft(scopeKey);
      const next = updater(current);
      saveReviewDraft(scopeKey, next);
      return { key: scopeKey, draft: next };
    });
  }
  const fileOrder = useMemo(() => files.map((file) => file.path), [files]);
  const sortedComments = useMemo(
    () => sortReviewComments(reviewDraft.comments, fileOrder),
    [reviewDraft.comments, fileOrder],
  );
  const outdatedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const comment of sortedComments) {
      if (
        isCommentOutdated(
          comment,
          patches.get(comment.path),
          filesByPath.has(comment.path),
        )
      ) {
        ids.add(comment.id);
      }
    }
    return ids;
  }, [sortedComments, patches, filesByPath]);
  const viewedPaths = useMemo(() => {
    const viewed = new Set<string>();
    for (const file of files) {
      if (isFileViewed(reviewDraft.viewed, file, patches.get(file.path))) {
        viewed.add(file.path);
      }
    }
    return viewed;
  }, [files, patches, reviewDraft.viewed]);
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of sortedComments) {
      counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
    }
    return counts;
  }, [sortedComments]);
  const annotationsByPath = useMemo(() => {
    const grouped = new Map<
      string,
      Map<
        string,
        {
          side: ReviewSide;
          lineNumber: number;
          comments: ReviewComment[];
          draft?: DraftAnchor;
        }
      >
    >();
    const ensureSlot = (path: string, side: ReviewSide, lineNumber: number) => {
      let slots = grouped.get(path);
      if (!slots) {
        slots = new Map();
        grouped.set(path, slots);
      }
      const key = `${side}:${lineNumber}`;
      let slot = slots.get(key);
      if (!slot) {
        slot = { side, lineNumber, comments: [] };
        slots.set(key, slot);
      }
      return slot;
    };
    for (const comment of sortedComments) {
      if (outdatedIds.has(comment.id)) continue;
      ensureSlot(comment.path, comment.side, comment.endLine).comments.push(
        comment,
      );
    }
    if (draftAnchor) {
      ensureSlot(
        draftAnchor.path,
        draftAnchor.side,
        draftAnchor.endLine,
      ).draft = draftAnchor;
    }
    const result = new Map<
      string,
      { annotations: DiffLineAnnotation<ReviewAnnotationMetadata>[]; key: string }
    >();
    for (const [path, slots] of grouped) {
      const annotations: DiffLineAnnotation<ReviewAnnotationMetadata>[] = [];
      const keyParts: string[] = [];
      for (const slot of slots.values()) {
        annotations.push({
          side: slot.side,
          lineNumber: slot.lineNumber,
          metadata: { comments: slot.comments, draft: slot.draft },
        });
        keyParts.push(
          `${slot.side}:${slot.lineNumber}:${slot.comments
            .map(
              (c) =>
                `${c.id}:${c.id === editingCommentId ? 1 : 0}:${c.body}`,
            )
            .join(",")}:${
            slot.draft
              ? `${slot.draft.startLine}-${slot.draft.endLine}`
              : ""
          }`,
        );
      }
      result.set(path, { annotations, key: keyParts.join("|") });
    }
    return result;
  }, [sortedComments, outdatedIds, draftAnchor, editingCommentId]);
  const itemVersion = useRef(0);
  const itemVersionCache = useRef(
    new Map<
      string,
      {
        fileDiff?: FileDiffMetadata;
        collapsed: boolean;
        annotationsKey: string;
        binary: boolean;
        label: string;
        version: number;
      }
    >(),
  );
  const items = useMemo<CodeViewItem<ReviewAnnotationMetadata>[]>(() => {
    // CodeView applies controlled content, collapse, and annotation changes by version.
    const nextCache = new Map(itemVersionCache.current);
    const activeIds = new Set<string>();
    const result = displayed.map((file) => {
      activeIds.add(file.path);
      const fileDiff = patches.get(file.path);
      const isCollapsed = collapsed.has(file.path);
      const annotationEntry = annotationsByPath.get(file.path);
      const annotationsKey = annotationEntry?.key ?? "";
      const binary = !!file.binary;
      const label =
        fileDiff?.hunks.length && !binary
          ? ""
          : t(binary ? "diff.binary" : "diff.metadata");
      const cached = nextCache.get(file.path);
      const version =
        cached &&
        cached.fileDiff === fileDiff &&
        cached.collapsed === isCollapsed &&
        cached.annotationsKey === annotationsKey &&
        cached.binary === binary &&
        cached.label === label
          ? cached.version
          : ++itemVersion.current;
      nextCache.set(file.path, {
        fileDiff,
        collapsed: isCollapsed,
        annotationsKey,
        binary,
        label,
        version,
      });
      const item = {
        id: file.path,
        collapsed: isCollapsed,
        version,
      };
      return fileDiff?.hunks.length && !binary
        ? {
            ...item,
            type: "diff" as const,
            fileDiff,
            ...(annotationEntry ? { annotations: annotationEntry.annotations } : {}),
          }
        : {
            ...item,
            type: "file" as const,
            file: {
              name: file.path,
              lang: "text" as const,
              contents: label,
            },
          };
    });
    for (const key of nextCache.keys()) {
      if (!activeIds.has(key)) nextCache.delete(key);
    }
    itemVersionCache.current = nextCache;
    return result;
  }, [displayed, patches, collapsed, annotationsByPath, t]);
  useLayoutEffect(() => {
    if (!viewer.current) return;
    const lineTarget = pendingRevealLine.current;
    if (lineTarget && (!singleFile || activePath === lineTarget.path)) {
      if (patches.has(lineTarget.path)) {
        pendingRevealLine.current = undefined;
        viewer.current.scrollTo({
          type: "line",
          id: lineTarget.path,
          lineNumber: lineTarget.lineNumber,
          side: lineTarget.side,
          align: "center",
          behavior: "instant",
        });
        return;
      }
    }
    const path = pendingReveal.current;
    if (!path) return;
    pendingReveal.current = undefined;
    viewer.current.scrollTo({
      type: "item",
      id: path,
      align: "start",
      behavior: "instant",
    });
  }, [items, selected, singleFile, activePath, patches]);
  useEffect(() => setSelection(undefined), [patch, mode, root?.id]);
  function openDraftForRange(
    path: string,
    fileDiff: FileDiffMetadata,
    range: SelectedLineRange,
  ) {
    if (!canFeedback) return;
    const anchor = extractDraftAnchor(path, fileDiff, range, prefs.split);
    if (!anchor) return;
    setSelection(undefined);
    setEditingCommentId(undefined);
    setCollapsed((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
    setDraftAnchor(anchor);
  }
  const handleGutterUtilityClick = useEventCallback(
    (
      range: SelectedLineRange,
      context: { item: CodeViewItem<ReviewAnnotationMetadata> },
    ) => {
      if (!canFeedback || context.item.type !== "diff") return;
      suppressNextSelection.current = true;
      openDraftForRange(context.item.id, context.item.fileDiff, range);
    },
  );
  const codeViewOptions = useMemo(
    () => ({
      diffStyle: (prefs.split ? "split" : "unified") as "split" | "unified",
      themeType: (dark ? "dark" : "light") as "dark" | "light",
      overflow: (prefs.wrap ? "wrap" : "scroll") as "wrap" | "scroll",
      lineDiffType: "word" as const,
      expandUnchanged: prefs.full,
      enableLineSelection: canFeedback,
      enableGutterUtility: canFeedback,
      onGutterUtilityClick: canFeedback ? handleGutterUtilityClick : undefined,
      stickyHeaders: true,
      pointerEventsOnScroll: true,
      itemMetrics: diffMetrics,
      layout: diffLayout,
      unsafeCSS: diffCSS,
    }),
    [prefs.split, prefs.wrap, prefs.full, dark, canFeedback, handleGutterUtilityClick],
  );
  function saveDraftComment(anchor: DraftAnchor, body: string) {
    const comment: ReviewComment = {
      id: crypto.randomUUID(),
      path: anchor.path,
      side: anchor.side,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      anchorText: anchor.anchorText,
      snippet: anchor.snippet,
      lang: anchor.lang,
      body,
      createdAt: Date.now(),
    };
    updateReviewDraft((previous) => ({
      ...previous,
      comments: [...previous.comments, comment],
    }));
    setDraftAnchor(undefined);
  }
  function saveEditedComment(id: string, body: string) {
    updateReviewDraft((previous) => ({
      ...previous,
      comments: previous.comments.map((comment) =>
        comment.id === id ? { ...comment, body } : comment,
      ),
    }));
    setEditingCommentId(undefined);
  }
  function deleteComment(id: string) {
    updateReviewDraft((previous) => ({
      ...previous,
      comments: previous.comments.filter((comment) => comment.id !== id),
    }));
    if (editingCommentId === id) setEditingCommentId(undefined);
  }
  function clearComments() {
    const removed = reviewDraft.comments;
    if (removed.length === 0) return;
    updateReviewDraft((previous) => ({ ...previous, comments: [] }));
    setDraftAnchor(undefined);
    setEditingCommentId(undefined);
    toast.success(t("diff.commentsCleared", { count: removed.length }), {
      action: {
        label: t("diff.undoSubmit"),
        onClick: () =>
          updateReviewDraft((previous) => ({
            ...previous,
            comments: [
              ...removed,
              ...previous.comments.filter(
                (item) => !removed.some((old) => old.id === item.id),
              ),
            ],
          })),
      },
    });
  }
  function toggleViewed(file: (typeof files)[number]) {
    const fileDiff = patches.get(file.path);
    const currentlyViewed = viewedPaths.has(file.path);
    updateReviewDraft((previous) => {
      const viewed = { ...previous.viewed };
      if (currentlyViewed) {
        delete viewed[file.path];
      } else {
        viewed[file.path] = {
          stats: fileStatsFingerprint(file),
          ...(fileDiff ? { contentHash: patchContentHash(fileDiff) } : {}),
        };
      }
      return { ...previous, viewed };
    });
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (currentlyViewed) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }
  function jumpToComment(comment: ReviewComment) {
    if (!filesByPath.has(comment.path)) return;
    if (!visible.some((file) => file.path === comment.path)) setFilter("");
    setSelected(comment.path);
    setCollapsed((previous) => {
      if (!previous.has(comment.path)) return previous;
      const next = new Set(previous);
      next.delete(comment.path);
      return next;
    });
    if (outdatedIds.has(comment.id)) {
      pendingReveal.current = comment.path;
      return;
    }
    pendingRevealLine.current = {
      path: comment.path,
      lineNumber: comment.endLine,
      side: comment.side,
    };
  }
  function reviewFormatLabels() {
    return {
      header: t("diff.reviewHeader", {
        scope: scopeLabel,
        count: sortedComments.length,
      }),
      sideLabel: (side: ReviewSide) =>
        t(side === "deletions" ? "diff.oldSide" : "diff.newSide"),
      outdatedLabel: t("diff.commentOutdated"),
    };
  }
  async function submitReview() {
    if (!root || sortedComments.length === 0 || !canFeedback) return;
    const submitted = [...sortedComments];
    const content = buildReviewContent(
      submitted,
      root,
      !!native,
      reviewFormatLabels(),
      outdatedIds,
    );
    setReplying(true);
    try {
      await onFeedback(feedbackTarget, content);
      updateReviewDraft((previous) => ({ ...previous, comments: [] }));
      setDraftAnchor(undefined);
      setEditingCommentId(undefined);
      toast.success(t("diff.reviewLoaded", { count: submitted.length }), {
        action: {
          label: t("diff.undoSubmit"),
          onClick: () =>
            updateReviewDraft((previous) => ({
              ...previous,
              comments: [
                ...submitted,
                ...previous.comments.filter(
                  (item) => !submitted.some((old) => old.id === item.id),
                ),
              ],
            })),
        },
      });
    } catch {
      // onFeedback already reports the error toast.
    } finally {
      setReplying(false);
    }
  }
  function copyReview() {
    if (!root || sortedComments.length === 0) return;
    const markdown = buildReviewMarkdown(
      sortedComments,
      root,
      !!native,
      reviewFormatLabels(),
      outdatedIds,
    );
    void navigator.clipboard.writeText(markdown).then(
      () => toast.success(t("diff.reviewCopied")),
      (error) => toast.error(String(error)),
    );
  }
  async function feedback() {
    if (!selection || !root || !canFeedback) return;
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
                scope: scopeLabel,
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
      await onFeedback(feedbackTarget, content);
    } catch {
      // onFeedback already reports the error toast.
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
          <div className="diff-toolbar-end">
            <ReviewControls
              comments={sortedComments}
              outdatedIds={outdatedIds}
              submitting={replying}
              canSubmit={canFeedback && !!root}
              onJump={jumpToComment}
              onDelete={deleteComment}
              onClearAll={clearComments}
              onCopy={copyReview}
              onSubmit={() => void submitReview()}
            />
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
                    if (suppressNextSelection.current) {
                      suppressNextSelection.current = false;
                      setSelection(undefined);
                      return;
                    }
                    const file = next && patches.get(next.id);
                    setSelection(
                      file?.hunks.length && next
                        ? { file, range: next.range }
                        : undefined,
                    );
                  }}
                  options={codeViewOptions}
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
                  renderAnnotation={(annotation) =>
                    annotation.metadata ? (
                      <ReviewAnnotationSlot
                        metadata={annotation.metadata}
                        editingId={editingCommentId}
                        onStartEdit={(id) => {
                          setDraftAnchor(undefined);
                          setEditingCommentId(id);
                        }}
                        onCancelEdit={() => setEditingCommentId(undefined)}
                        onSaveEdit={saveEditedComment}
                        onDelete={deleteComment}
                        onSaveDraft={saveDraftComment}
                        onCancelDraft={() => setDraftAnchor(undefined)}
                      />
                    ) : null
                  }
                  renderCustomHeader={({ id }) => {
                    const file = filesByPath.get(id);
                    if (!file) return null;
                    const fileDiff = patches.get(id);
                    const fileViewed = viewedPaths.has(id);
                    const fileTarget = native
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
                          fileDiff &&
                          selection.file === fileDiff && (
                            <div className="diff-selection-actions">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  openDraftForRange(
                                    id,
                                    fileDiff,
                                    selection.range,
                                  )
                                }
                              >
                                <MessageSquarePlus />
                                {t("diff.addComment")}
                              </Button>
                              <ToolbarButton
                                label={t("diff.feedback")}
                                disabled={replying}
                                onClick={() => void feedback()}
                              >
                                <MessageSquareQuote />
                              </ToolbarButton>
                            </div>
                          )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="diff-viewed-toggle"
                          aria-pressed={fileViewed}
                          aria-label={t(
                            fileViewed ? "diff.markUnviewed" : "diff.markViewed",
                          )}
                          title={t(
                            fileViewed ? "diff.markUnviewed" : "diff.markViewed",
                          )}
                          onClick={() => toggleViewed(file)}
                        >
                          <Check />
                          <span>{t("diff.viewed")}</span>
                        </Button>
                        {file.status !== "D" && fileTarget && (
                          <ToolbarButton
                            label={t("diff.openFile")}
                            onClick={() =>
                              openFile(fileTarget.root, fileTarget.path)
                            }
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
                <span>
                  {viewedPaths.size > 0
                    ? `${viewedPaths.size}/${files.length}`
                    : files.length}
                </span>
                {!singleFile && navigation}
              </div>
              <DiffFileTree
                tree={fileTree}
                selected={activePath}
                viewed={viewedPaths}
                commentCounts={commentCounts}
                onSelect={reveal}
              />
            </aside>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
