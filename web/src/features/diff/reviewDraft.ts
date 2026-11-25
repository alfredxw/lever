import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { JSONContent } from "@tiptap/core";
import type { DiffFile, Root } from "@/api/types.gen";
import { absoluteFilePath, workspaceFilePath } from "@/features/files/filePaths";
import { selectedCode } from "./selectedCode";

export type ReviewSide = "additions" | "deletions";

export type DiffFeedbackTarget = {
  agentId: string;
  sessionId?: string;
  chatId?: string;
};

export type ReviewComment = {
  id: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  anchorText: string;
  snippet: string;
  lang: string;
  body: string;
  createdAt: number;
};

export type ViewedEntry = {
  stats: string;
  contentHash?: string;
};

export type ReviewDraft = {
  comments: ReviewComment[];
  viewed: Record<string, ViewedEntry>;
  updatedAt: number;
};

export type DraftAnchor = {
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  anchorText: string;
  snippet: string;
  lang: string;
};

const storageKey = "lever:diff-reviews";
const maxScopes = 20;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const maxSnippetChars = 4096;

export const emptyReviewDraft: ReviewDraft = {
  comments: [],
  viewed: {},
  updatedAt: 0,
};

export function reviewScopeKey({
  agentId,
  sessionId,
  rootId,
  mode,
  runId,
  commit,
  base,
  head,
}: {
  agentId: string;
  sessionId?: string;
  rootId?: string;
  mode: string;
  runId?: string;
  commit?: string;
  base?: string;
  head?: string;
}) {
  const variant =
    mode === "turn"
      ? (runId ?? "latest")
      : mode === "committed"
        ? (commit ?? "HEAD")
        : mode === "branch"
          ? `${base ?? ""}..${head ?? ""}`
          : "";
  return [agentId, sessionId ?? "", rootId ?? "", mode, variant].join(":");
}

function readAllDrafts(): Record<string, ReviewDraft> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ReviewDraft>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadReviewDraft(scopeKey: string): ReviewDraft {
  const entry = readAllDrafts()[scopeKey];
  if (!entry || typeof entry !== "object") return emptyReviewDraft;
  return {
    comments: Array.isArray(entry.comments) ? entry.comments : [],
    viewed: entry.viewed && typeof entry.viewed === "object" ? entry.viewed : {},
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
  };
}

export function saveReviewDraft(scopeKey: string, draft: ReviewDraft) {
  try {
    const all = readAllDrafts();
    const now = Date.now();
    if (
      draft.comments.length === 0 &&
      Object.keys(draft.viewed).length === 0
    ) {
      delete all[scopeKey];
    } else {
      all[scopeKey] = { ...draft, updatedAt: now };
    }
    const entries = Object.entries(all)
      .filter(([, value]) => now - (value.updatedAt ?? 0) <= maxAgeMs)
      .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
      .slice(0, maxScopes);
    if (entries.length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

export function fileStatsFingerprint(file: DiffFile) {
  return `${file.status}:${file.additions}:${file.deletions}:${file.binary ? 1 : 0}`;
}

export function patchContentHash(fileDiff: FileDiffMetadata) {
  let hash = 0x811c9dc5;
  const feed = (value: string) => {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const hunk of fileDiff.hunks) {
    feed(
      `${hunk.deletionStart},${hunk.deletionCount}:${hunk.additionStart},${hunk.additionCount}|`,
    );
  }
  for (const line of fileDiff.deletionLines) feed(line);
  feed("\0");
  for (const line of fileDiff.additionLines) feed(line);
  return (hash >>> 0).toString(16);
}

export function isFileViewed(
  viewed: Record<string, ViewedEntry>,
  file: DiffFile,
  fileDiff?: FileDiffMetadata,
) {
  const entry = viewed[file.path];
  if (!entry || entry.stats !== fileStatsFingerprint(file)) return false;
  if (fileDiff && entry.contentHash) {
    return entry.contentHash === patchContentHash(fileDiff);
  }
  return true;
}

export function anchorLineText(
  fileDiff: FileDiffMetadata,
  side: ReviewSide,
  lineNumber: number,
): string | undefined {
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      const oldCount = block.type === "context" ? block.lines : block.deletions;
      const newCount = block.type === "context" ? block.lines : block.additions;
      if (side === "deletions") {
        if (lineNumber >= oldLine && lineNumber < oldLine + oldCount) {
          const line =
            fileDiff.deletionLines[block.deletionLineIndex + (lineNumber - oldLine)];
          return line?.trim();
        }
      } else if (lineNumber >= newLine && lineNumber < newLine + newCount) {
        const line =
          fileDiff.additionLines[block.additionLineIndex + (lineNumber - newLine)];
        return line?.trim();
      }
      oldLine += oldCount;
      newLine += newCount;
    }
  }
  return undefined;
}

export function isCommentOutdated(
  comment: ReviewComment,
  fileDiff: FileDiffMetadata | undefined,
  fileExists: boolean,
) {
  if (!fileExists) return true;
  if (!fileDiff) return false;
  const current = anchorLineText(fileDiff, comment.side, comment.endLine);
  if (current === undefined) return true;
  return comment.anchorText !== "" && current !== comment.anchorText;
}

function capSnippet(text: string) {
  const trimmed = text.replace(/\r?\n$/, "");
  if (trimmed.length <= maxSnippetChars) return trimmed;
  return trimmed.slice(0, maxSnippetChars) + "\n…";
}

export function extractDraftAnchor(
  path: string,
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
  split: boolean,
): DraftAnchor | undefined {
  const parts = selectedCode(fileDiff, range, split);
  if (parts.length === 0) return undefined;
  const preferredSide: ReviewSide = range.endSide ?? range.side ?? "additions";
  const primary =
    parts.find((part) => part.side === preferredSide) ?? parts.at(-1)!;
  const snippet = capSnippet(
    parts.length === 1
      ? primary.text
      : parts.map((part) => part.text.replace(/\r?\n$/, "")).join("\n"),
  );
  return {
    path,
    side: primary.side,
    startLine: primary.start,
    endLine: primary.end,
    anchorText: anchorLineText(fileDiff, primary.side, primary.end) ?? "",
    snippet,
    lang: fileDiff.lang ?? "text",
  };
}

export function sortReviewComments(
  comments: readonly ReviewComment[],
  fileOrder: readonly string[],
) {
  const indexByPath = new Map(fileOrder.map((path, index) => [path, index]));
  return [...comments].sort((a, b) => {
    const ai = indexByPath.get(a.path) ?? Number.MAX_SAFE_INTEGER;
    const bi = indexByPath.get(b.path) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.endLine !== b.endLine) return a.endLine - b.endLine;
    return a.createdAt - b.createdAt;
  });
}

export function formatLineRange(startLine: number, endLine: number) {
  return startLine === endLine ? `L${startLine}` : `L${startLine}–L${endLine}`;
}

function displayReviewPath(path: string, root: Root, native: boolean) {
  return native
    ? (workspaceFilePath(path, root.path) ?? path)
    : absoluteFilePath({ root, path });
}

type ReviewFormatLabels = {
  header: string;
  sideLabel: (side: ReviewSide) => string;
  outdatedLabel: string;
};

export function buildReviewContent(
  comments: readonly ReviewComment[],
  root: Root,
  native: boolean,
  labels: ReviewFormatLabels,
  outdatedIds?: ReadonlySet<string>,
): JSONContent[] {
  const content: JSONContent[] = [
    {
      type: "paragraph",
      content: [{ type: "text", text: labels.header }],
    },
  ];
  comments.forEach((comment, index) => {
    const path = displayReviewPath(comment.path, root, native);
    const outdated = outdatedIds?.has(comment.id)
      ? ` (${labels.outdatedLabel})`
      : "";
    const heading = `${index + 1}. ${path} · ${labels.sideLabel(comment.side)} ${formatLineRange(comment.startLine, comment.endLine)}${outdated}`;
    content.push({
      type: "paragraph",
      content: [{ type: "text", text: heading }],
    });
    if (comment.snippet) {
      content.push({
        type: "codeBlock",
        attrs: { language: comment.lang || "text" },
        content: [{ type: "text", text: comment.snippet }],
      });
    }
    const lines = comment.body.trim().split(/\r?\n/);
    for (const line of lines) {
      if (line) {
        content.push({
          type: "paragraph",
          content: [{ type: "text", text: line }],
        });
      }
    }
  });
  content.push({ type: "paragraph" });
  return content;
}

export function buildReviewMarkdown(
  comments: readonly ReviewComment[],
  root: Root,
  native: boolean,
  labels: ReviewFormatLabels,
  outdatedIds?: ReadonlySet<string>,
) {
  const sections = [labels.header];
  comments.forEach((comment, index) => {
    const path = displayReviewPath(comment.path, root, native);
    const outdated = outdatedIds?.has(comment.id)
      ? ` (${labels.outdatedLabel})`
      : "";
    const heading = `${index + 1}. \`${path}\` · ${labels.sideLabel(comment.side)} ${formatLineRange(comment.startLine, comment.endLine)}${outdated}`;
    const parts = [heading];
    if (comment.snippet) {
      const fence = comment.snippet.includes("```") ? "````" : "```";
      parts.push(`${fence}${comment.lang || ""}\n${comment.snippet}\n${fence}`);
    }
    parts.push(comment.body.trim());
    sections.push(parts.join("\n"));
  });
  return sections.join("\n\n");
}
