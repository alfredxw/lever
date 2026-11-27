import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { JSONContent } from "@tiptap/core";
import type {
  Attachment,
  ComparisonInput,
  Conversation,
  MessageQuote,
  Reference,
  Selection,
  SendInput,
} from "@/api/types.gen";
import type { PermissionSource } from "@/features/runtime/permissionMapping";
import { referenceText, textPrompt } from "./prompt.ts";

export type DraftSelection = Selection & {
  permissionSource?: PermissionSource;
};

export type Draft = {
  content: JSONContent;
  topic: boolean;
  comparisonAgents?: string[];
  comparisonSelection?: Selection;
  comparisonModels?: Record<string, Selection>;
  comparisonSharedScope?: boolean;
  afterRunIds?: string[];
  sessionSelection?: DraftSelection;
  topicSelection?: DraftSelection;
  files: Attachment[];
  quote: MessageQuote | null;
  workingCopyId?: string;
  editing?: { runId: string; previous: Draft; sent?: boolean };
};

export type ComposerDraftSummary = {
  text: string;
  fileCount: number;
  firstFileName?: string;
  hasQuote: boolean;
  quoteText?: string;
  editing: boolean;
  pending: boolean;
};

type SavedDraft = Omit<Partial<Draft>, "editing"> & {
  selection?: Selection;
  text?: string;
  references?: Reference[];
  editing?: Omit<NonNullable<Draft["editing"]>, "previous"> & {
    previous: SavedDraft;
  };
};

export const defaultComposerTopic = true;

const composerPrefix = "lever:composer:";
const submissionPrefix = "lever:submission:";
const legacyDraftPrefix = "lever:draft:";
const draftEvents = new EventTarget();
const draftKeyListeners = new Set<() => void>();
const summaryCache = new Map<
  string,
  {
    rawComposer: string | null;
    rawSubmission: string | null;
    rawLegacy: string | null;
    summary: ComposerDraftSummary | null;
  }
>();
let draftKeysCache: Set<string> | null = null;
let draftKeysSnapshot: ReadonlySet<string> | null = null;
let storageListenerAttached = false;

const storageKey = (key: string) => `${composerPrefix}${key}`;
const submissionStorageKey = (key: string) => `${submissionPrefix}${key}`;
const legacyDraftStorageKey = (key: string) => `${legacyDraftPrefix}${key}`;

export function conversationDraftKey(
  conversation: Pick<Conversation, "id" | "chatId" | "kind">,
): string {
  return conversation.kind === "main" ? conversation.chatId : conversation.id;
}

function keyFromStorageKey(name: string): string | null {
  if (name.startsWith(composerPrefix)) return name.slice(composerPrefix.length);
  if (name.startsWith(submissionPrefix))
    return name.slice(submissionPrefix.length);
  if (name.startsWith(legacyDraftPrefix))
    return name.slice(legacyDraftPrefix.length);
  return null;
}

function parse<T>(raw: string | null): T | null {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readSubmission(key: string) {
  return parse<SendInput | ComparisonInput>(
    localStorage.getItem(submissionStorageKey(key)),
  );
}

function truncatePreview(text: string, limit = 120) {
  const normalized = text
    .replace(/^(?:&#32;|&#9;)/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(normalized);
  if (chars.length <= limit) return normalized;
  return chars.slice(0, limit).join("") + "…";
}

function extractPromptText(doc: JSONContent) {
  const parts: string[] = [];
  let hasReference = false;
  function visit(node: JSONContent) {
    if (node.type === "text" && node.text) {
      parts.push(node.text);
      return;
    }
    if (node.type === "reference" && node.attrs?.reference) {
      hasReference = true;
      parts.push(referenceText(node.attrs.reference as Reference));
      return;
    }
    if (node.type === "hardBreak") {
      parts.push(" ");
      return;
    }
    if (node.content) {
      const before = parts.length;
      for (const child of node.content) visit(child);
      if (parts.length > before) parts.push(" ");
    }
  }
  visit(doc);
  return { text: parts.join(""), hasReference };
}

function sameDraftSummary(
  a: ComposerDraftSummary | null,
  b: ComposerDraftSummary | null,
) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.text === b.text &&
    a.fileCount === b.fileCount &&
    a.firstFileName === b.firstFileName &&
    a.hasQuote === b.hasQuote &&
    a.quoteText === b.quoteText &&
    a.editing === b.editing &&
    a.pending === b.pending
  );
}

function hasInput(draft: Draft) {
  if (draft.editing || draft.files.length || draft.quote) return true;
  const { text, hasReference } = extractPromptText(draft.content);
  return !!(text.trim() || hasReference);
}

function restoreDraft(
  saved: SavedDraft | null,
  pending?: SendInput | ComparisonInput | null,
  legacyText = "",
): Draft {
  const comparison = pending && "agentIds" in pending ? pending : undefined;
  const send = pending && "operation" in pending ? pending : undefined;
  const draft: Draft = {
    editing: saved?.editing && {
      ...saved.editing,
      previous: restoreDraft(saved.editing.previous),
    },
    workingCopyId: saved?.content
      ? saved.workingCopyId
      : (saved?.workingCopyId ?? send?.workingCopyId),
    comparisonAgents: saved?.content
      ? saved.comparisonAgents
      : comparison?.agentIds,
    comparisonSelection: saved?.comparisonSelection,
    comparisonModels: saved?.comparisonModels,
    comparisonSharedScope: saved?.content
      ? saved.comparisonSharedScope
      : comparison?.sharedScope,
    afterRunIds: saved?.content ? saved.afterRunIds : send?.afterRunIds,
    content:
      saved?.content ??
      textPrompt(
        saved?.text ?? legacyText,
        saved?.references ?? pending?.references,
      ),
    topic:
      saved?.topic ??
      (send ? send.operation === "topic" : defaultComposerTopic),
    sessionSelection: saved?.sessionSelection,
    topicSelection: saved?.topicSelection,
    files: saved?.files ?? [],
    quote: saved?.quote === undefined ? (pending?.quote ?? null) : saved.quote,
  };
  // Old composers also saved implicit selections in their empty drafts.
  if (saved?.selection && (pending || hasInput(draft))) {
    const field =
      draft.topic && !draft.editing ? "topicSelection" : "sessionSelection";
    draft[field] ??= saved.selection;
  }
  return draft;
}

function readDraft(
  key: string,
  raw: string | null,
  pending = readSubmission(key),
) {
  return restoreDraft(
    parse<SavedDraft>(raw),
    pending,
    localStorage.getItem(legacyDraftStorageKey(key)) ?? "",
  );
}

function computeDraftSummary(
  rawComposer: string | null,
  rawSubmission: string | null,
  rawLegacy: string | null,
): ComposerDraftSummary | null {
  const pending = parse<SendInput | ComparisonInput>(rawSubmission);
  if (!rawComposer && !pending && !rawLegacy?.trim()) return null;
  const draft = restoreDraft(
    parse<SavedDraft>(rawComposer),
    pending,
    rawLegacy ?? "",
  );
  const extracted = extractPromptText(draft.content);
  const text = truncatePreview(extracted.text || pending?.text || "");
  const fileCount = draft.files.length || pending?.attachmentIds?.length || 0;
  const firstFileName = draft.files[0]?.name;
  const quote = draft.quote ?? pending?.quote ?? null;
  const hasQuote = !!quote;
  const quoteText = quote?.text ? truncatePreview(quote.text, 80) : undefined;
  const editing = !!draft.editing;
  const hasPending = !!pending;
  if (
    !text &&
    !extracted.hasReference &&
    !fileCount &&
    !hasQuote &&
    !editing &&
    !hasPending
  ) {
    return null;
  }
  return {
    text,
    fileCount,
    firstFileName,
    hasQuote,
    quoteText,
    editing,
    pending: hasPending,
  };
}

export function readComposerDraftSummary(
  key: string,
): ComposerDraftSummary | null {
  const rawComposer = localStorage.getItem(storageKey(key));
  const rawSubmission = localStorage.getItem(submissionStorageKey(key));
  const rawLegacy = localStorage.getItem(legacyDraftStorageKey(key));
  const cached = summaryCache.get(key);
  if (
    cached &&
    cached.rawComposer === rawComposer &&
    cached.rawSubmission === rawSubmission &&
    cached.rawLegacy === rawLegacy
  ) {
    return cached.summary;
  }
  if (rawComposer === null && rawSubmission === null && rawLegacy === null) {
    summaryCache.delete(key);
    return null;
  }
  const summary = computeDraftSummary(rawComposer, rawSubmission, rawLegacy);
  const stableSummary =
    cached && sameDraftSummary(cached.summary, summary)
      ? cached.summary
      : summary;
  summaryCache.set(key, {
    rawComposer,
    rawSubmission,
    rawLegacy,
    summary: stableSummary,
  });
  return stableSummary;
}

export function formatDraftPreview(
  summary: ComposerDraftSummary | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!summary) return "";
  if (summary.text) return summary.text;
  if (summary.fileCount > 0) {
    return summary.fileCount === 1 && summary.firstFileName
      ? t("agents.draftAttachment", { name: summary.firstFileName })
      : t("agents.draftAttachments", { count: summary.fileCount });
  }
  if (summary.hasQuote) {
    return summary.quoteText || t("agents.draftQuote");
  }
  if (summary.editing) {
    return t("agents.draftEditing");
  }
  return "";
}

export function hasStoredComposerInput(key: string) {
  return readComposerDraftSummary(key) !== null;
}

function scanDraftKeys(): Set<string> {
  const candidates = new Set<string>();
  for (let index = 0; index < localStorage.length; index++) {
    const name = localStorage.key(index);
    if (!name) continue;
    const key = keyFromStorageKey(name);
    if (key) candidates.add(key);
  }
  const active = new Set<string>();
  for (const key of candidates) {
    if (hasStoredComposerInput(key)) active.add(key);
  }
  return active;
}

function sameKeySet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

function notifyDraftKeyListeners() {
  for (const listener of draftKeyListeners) listener();
}

function ensureDraftKeys(): ReadonlySet<string> {
  if (!draftKeysCache || !draftKeysSnapshot) {
    draftKeysCache = scanDraftKeys();
    draftKeysSnapshot = new Set(draftKeysCache);
  }
  return draftKeysSnapshot;
}

function syncDraftKey(key: string) {
  if (!draftKeysCache) return;
  const present = hasStoredComposerInput(key);
  if (present === draftKeysCache.has(key)) return;
  if (present) draftKeysCache.add(key);
  else draftKeysCache.delete(key);
  draftKeysSnapshot = new Set(draftKeysCache);
  notifyDraftKeyListeners();
}

export function syncAllComposerDrafts() {
  const previousKeys = new Set<string>(summaryCache.keys());
  if (draftKeysCache) {
    for (const key of draftKeysCache) previousKeys.add(key);
  }
  summaryCache.clear();
  const next = scanDraftKeys();
  const changed = !draftKeysCache || !sameKeySet(draftKeysCache, next);
  draftKeysCache = next;
  if (changed || !draftKeysSnapshot) {
    draftKeysSnapshot = new Set(next);
    notifyDraftKeyListeners();
  }
  const affected = new Set<string>(previousKeys);
  for (const key of next) affected.add(key);
  for (const key of affected) draftEvents.dispatchEvent(new Event(key));
}

function attachStorageListener() {
  if (storageListenerAttached || typeof window === "undefined") return;
  storageListenerAttached = true;
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key === null) {
      syncAllComposerDrafts();
      return;
    }
    const key = keyFromStorageKey(event.key);
    if (!key) return;
    syncDraftKey(key);
    draftEvents.dispatchEvent(new Event(key));
  });
}

export function saveSubmission(
  key: string,
  input: SendInput | ComparisonInput,
) {
  localStorage.setItem(submissionStorageKey(key), JSON.stringify(input));
  syncDraftKey(key);
  draftEvents.dispatchEvent(new Event(key));
}

export function clearSubmission(key: string) {
  if (localStorage.getItem(submissionStorageKey(key)) === null) return;
  localStorage.removeItem(submissionStorageKey(key));
  syncDraftKey(key);
  draftEvents.dispatchEvent(new Event(key));
}

export function saveComposerDraft(key: string, draft: Draft) {
  localStorage.setItem(storageKey(key), JSON.stringify(draft));
  localStorage.removeItem(legacyDraftStorageKey(key));
  syncDraftKey(key);
  draftEvents.dispatchEvent(new Event(key));
}

export function clearComposerDraft(key: string) {
  const raw = localStorage.getItem(storageKey(key));
  const current = raw ? readDraft(key, raw, null) : null;
  localStorage.removeItem(submissionStorageKey(key));
  localStorage.removeItem(legacyDraftStorageKey(key));
  if (
    current &&
    (current.sessionSelection ||
      current.topicSelection ||
      current.topic !== defaultComposerTopic)
  ) {
    const cleared: Draft = {
      content: textPrompt(""),
      topic: current.topic,
      sessionSelection: current.sessionSelection,
      topicSelection: current.topicSelection,
      files: [],
      quote: null,
    };
    localStorage.setItem(storageKey(key), JSON.stringify(cleared));
  } else {
    localStorage.removeItem(storageKey(key));
  }
  syncDraftKey(key);
  draftEvents.dispatchEvent(new Event(key));
}

// Older versions kept a second draft under the expanded Chat. Keep both when
// they contain text: the older launcher draft can be recovered once Chat clears.
export function recoverTopicLauncherDraft(chatId: string) {
  const old = `new-topic:${chatId}`;
  if (!hasStoredComposerInput(old) || hasStoredComposerInput(chatId)) return;
  const pending = readSubmission(old);
  const draft = readDraft(old, localStorage.getItem(storageKey(old)), pending);
  if (pending) saveSubmission(chatId, pending);
  saveComposerDraft(chatId, { ...draft, topic: true });
  localStorage.removeItem(storageKey(old));
  localStorage.removeItem(submissionStorageKey(old));
  localStorage.removeItem(legacyDraftStorageKey(old));
  syncDraftKey(old);
  draftEvents.dispatchEvent(new Event(old));
}

export function useComposerDraft(key: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      attachStorageListener();
      draftEvents.addEventListener(key, notify);
      return () => draftEvents.removeEventListener(key, notify);
    },
    [key],
  );
  const getSnapshot = () => localStorage.getItem(storageKey(key));
  const raw = useSyncExternalStore(subscribe, getSnapshot);
  const draft = useMemo(() => readDraft(key, raw), [key, raw]);

  function updateDraft(change: Draft | ((current: Draft) => Draft)) {
    // An upload or send can finish after the original composer has unmounted.
    const latest = getSnapshot();
    const current = latest === raw ? draft : readDraft(key, latest);
    const next = typeof change === "function" ? change(current) : change;
    if (next !== current) saveComposerDraft(key, next);
  }

  return [draft, updateDraft] as const;
}

function subscribeDraftKeys(notify: () => void) {
  attachStorageListener();
  draftKeyListeners.add(notify);
  return () => {
    draftKeyListeners.delete(notify);
  };
}

export function useComposerDraftKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDraftKeys, ensureDraftKeys);
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

export function useComposerDraftSummary(
  key?: string,
): ComposerDraftSummary | null {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!key) return () => {};
      attachStorageListener();
      draftEvents.addEventListener(key, notify);
      return () => draftEvents.removeEventListener(key, notify);
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? readComposerDraftSummary(key) : null),
    [key],
  );
  return useSyncExternalStore(
    key ? subscribe : noopSubscribe,
    key ? getSnapshot : nullSnapshot,
  );
}
