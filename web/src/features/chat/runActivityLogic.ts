import type { Item, ToolAction } from "@/api/types.gen";

export type Action = ToolAction | "other";

export const THOUGHT_PREVIEW_SOURCE_MAX_LENGTH = 16_384;

const genericToolNames = new Set([
  "bash",
  "command",
  "execute_command",
  "run_command",
  "shell",
  "edit",
  "edit_file",
  "client_edit_file",
  "file changes",
  "multiedit",
  "multi_replace_file_content",
  "notebookedit",
  "replace_file_content",
  "write",
  "write_file",
  "write_to_file",
  "ls",
  "list_dir",
  "list directory",
  "list files",
  "read",
  "read file",
  "read_file",
  "view_file",
  "client_view_file",
  "view_file_outline",
  "view_code_item",
  "find",
  "find_by_name",
  "glob",
  "grep",
  "grep_search",
  "search",
  "search_files",
  "search_web",
  "toolsearch",
  "websearch",
  "web search",
]);

export function toolAction(item: Pick<Item, "toolAction" | "title">): Action {
  switch (item.toolAction) {
    case "command":
    case "edit":
    case "list":
    case "read":
    case "search":
      return item.toolAction;
  }
  // Claude and Pi use tool names as titles. These also cover older entries.
  switch (item.title.trim().toLowerCase()) {
    case "bash":
      return "command";
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "write":
    case "file changes":
      return "edit";
    case "ls":
      return "list";
    case "read":
      return "read";
    case "find":
    case "glob":
    case "grep":
    case "search":
    case "toolsearch":
    case "websearch":
    case "web search":
      return "search";
    default:
      return "other";
  }
}

export function activityDisplayStatus({
  status,
  exitCode,
}: Pick<Item, "status" | "exitCode">) {
  return status === "failed" && exitCode !== undefined && exitCode > 0
    ? "completed"
    : status;
}

export function formatToolTarget(
  item: Pick<Item, "title">,
  action: Action,
): string {
  const firstLine =
    item.title
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  let compact = firstLine.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (action !== "other") {
    const normalized = compact
      .toLowerCase()
      .replace(/\?$/, "")
      .replace(/^(?:running|run)\s+/, "");
    if (genericToolNames.has(normalized)) return "";
  } else {
    const bareTool = /^(?:running|run)\s+([a-z0-9_.:/-]+)\??$/i.exec(compact);
    if (bareTool) compact = bareTool[1];
    if (compact.toLowerCase() === "tool call") return "";
  }
  return compact;
}

function flattenThoughtMarkdown(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text: string): string {
  // CJK sentences end in full-width punctuation without a following space;
  // ASCII sentence marks require whitespace or end-of-string so file names stay intact.
  const end = /[.?!]["'”’)]?(?=\s|$)|[。！？]["'”’）」』]?/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

function extractBoldHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^\*\*([^*\r\n]+)\*\*$/.exec(trimmed);
    if (match) {
      const cleaned = flattenThoughtMarkdown(match[1]);
      if (cleaned) headings.push(cleaned);
    }
  }
  return headings;
}

function stripFencedCodeBlocks(markdown: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(rawLine);
  }
  return lines.join("\n");
}

function boundHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}

function boundTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit).replace(/^[\uDC00-\uDFFF]/, "");
  const nextLine = tail.indexOf("\n");
  return nextLine >= 0 && nextLine < tail.length - 1
    ? tail.slice(nextLine + 1)
    : tail;
}

/** Settled single-line summary for collapsed historical reasoning entries. */
export function thoughtSummary(text: string): string {
  const source = boundHead(text.trimStart(), THOUGHT_PREVIEW_SOURCE_MAX_LENGTH);
  if (!source) return "";
  const openingHeading = /^\*\*([^*\r\n]+)\*\*[ \t]*(?:\r?\n|$)/.exec(
    source,
  )?.[1];
  if (openingHeading !== undefined) {
    return flattenThoughtMarkdown(openingHeading);
  }
  const flattened = flattenThoughtMarkdown(stripFencedCodeBlocks(source));
  return firstSentence(flattened);
}

/**
 * Live thought preview shown above the active status line during a running turn.
 * Prefers the latest bold-only section heading (common in Gemini / Antigravity and
 * Codex summaries), otherwise extracts the first sentence of the latest prose paragraph.
 */
export function liveThoughtLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const source = boundTail(trimmed, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH);
  const headings = extractBoldHeadings(source);
  if (headings.length > 0) {
    return headings[headings.length - 1];
  }
  const prose = stripFencedCodeBlocks(source);
  const paragraphs = prose
    .split(/\r?\n[ \t]*\r?\n+/)
    .map((paragraph) => flattenThoughtMarkdown(paragraph))
    .filter(Boolean);
  const latestParagraph = paragraphs[paragraphs.length - 1] ?? "";
  return firstSentence(latestParagraph);
}

export function shouldAutoExpandThinking(
  items: Item[],
  {
    autoExpandThinking,
    live,
    runStatus,
  }: {
    autoExpandThinking: boolean;
    live: boolean;
    runStatus: string;
  },
): boolean {
  if (!autoExpandThinking || !live || runStatus !== "running") return false;
  if (items.length === 0) return false;
  if (!items.every((item) => item.kind === "reasoning")) return false;
  const last = items[items.length - 1];
  return last.status === "running" && last.text.trim() !== "";
}

export type LiveActivityMode =
  | "active_tool"
  | "completed_tool_live"
  | "thinking"
  | "waiting_subagents"
  | "settled";

export type LiveActivityState = {
  mode: LiveActivityMode;
  running: boolean;
  counts: Map<Action, number>;
  hasReasoning: boolean;
  activeTool?: Item;
  liveTool?: Item;
  activeReasoning?: Item;
  thoughtLine: string;
};

export function deriveLiveActivity(
  items: Item[],
  {
    live,
    runStatus,
    runningSubagents = 0,
  }: {
    live: boolean;
    runStatus: string;
    runningSubagents?: number;
  },
): LiveActivityState {
  const counts = new Map<Action, number>();
  let activeTool: Item | undefined;
  let hasReasoning = false;
  for (const item of items) {
    if (item.kind === "reasoning") {
      hasReasoning = true;
      continue;
    }
    if (item.kind !== "tool") continue;
    if (runStatus === "running" && item.status === "running") {
      activeTool = item;
    }
    const action = toolAction(item);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }

  const lastItem = items.at(-1);
  const activeReasoning =
    live &&
    runStatus === "running" &&
    lastItem?.kind === "reasoning" &&
    lastItem.status === "running" &&
    lastItem.text.trim()
      ? lastItem
      : undefined;

  if (!live) {
    return {
      mode: "settled",
      running: false,
      counts,
      hasReasoning,
      activeTool: undefined,
      liveTool: undefined,
      activeReasoning: undefined,
      thoughtLine: "",
    };
  }

  const thoughtLine = activeReasoning
    ? liveThoughtLine(activeReasoning.text)
    : "";
  if (activeTool) {
    return {
      mode: "active_tool",
      running: true,
      counts,
      hasReasoning,
      activeTool,
      liveTool: activeTool,
      activeReasoning,
      thoughtLine: "",
    };
  }
  if (activeReasoning) {
    return {
      mode: "thinking",
      running: true,
      counts,
      hasReasoning,
      activeTool: undefined,
      liveTool: undefined,
      activeReasoning,
      thoughtLine,
    };
  }
  if (
    lastItem?.kind === "tool" &&
    activityDisplayStatus(lastItem) === "completed"
  ) {
    return {
      mode: "completed_tool_live",
      running: true,
      counts,
      hasReasoning,
      activeTool: undefined,
      liveTool: lastItem,
      activeReasoning: undefined,
      thoughtLine: "",
    };
  }
  if (runningSubagents > 0) {
    return {
      mode: "waiting_subagents",
      running: true,
      counts,
      hasReasoning,
      activeTool: undefined,
      liveTool: undefined,
      activeReasoning: undefined,
      thoughtLine: "",
    };
  }
  return {
    mode: "thinking",
    running: true,
    counts,
    hasReasoning,
    activeTool: undefined,
    liveTool: undefined,
    activeReasoning: undefined,
    thoughtLine: "",
  };
}

// Keep consecutive activity together until there is a visible message.
export function responseParts(items: Item[]) {
  const parts: (Item | Item[])[] = [];
  for (const item of items) {
    if (
      (item.kind === "reasoning" || item.kind === "text") &&
      !item.text.trim()
    ) {
      continue;
    }
    const previous = parts.at(-1);
    if (item.kind === "text" || item.kind === "user") parts.push(item);
    else if (Array.isArray(previous)) previous.push(item);
    else parts.push([item]);
  }
  return parts;
}
