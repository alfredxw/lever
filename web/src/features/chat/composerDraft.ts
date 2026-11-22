import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { JSONContent } from "@tiptap/core";
import type {
  Attachment,
  ComparisonInput,
  MessageQuote,
  Reference,
  Selection,
  SendInput,
} from "@/api/types.gen";
import type { PermissionSource } from "@/features/runtime/permissionMapping";
import { serializePrompt, textPrompt } from "./prompt";

export type DraftSelection = Selection & {
  permissionSource?: PermissionSource;
};

type Draft = {
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

type SavedDraft = Omit<Partial<Draft>, "editing"> & {
  selection?: Selection;
  text?: string;
  references?: Reference[];
  editing?: Omit<NonNullable<Draft["editing"]>, "previous"> & {
    previous: SavedDraft;
  };
};

const draftEvents = new EventTarget();
const storageKey = (key: string) => `lever:composer:${key}`;

function parse<T>(raw: string | null): T | null {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readSubmission(key: string) {
  return parse<SendInput | ComparisonInput>(
    localStorage.getItem(`lever:submission:${key}`),
  );
}

function hasInput(draft: Draft) {
  if (draft.editing || draft.files.length || draft.quote) return true;
  const prompt = serializePrompt(draft.content);
  return !!(prompt.text.trim() || prompt.references.length);
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
    topic: saved?.topic ?? (!!comparison || send?.operation === "topic"),
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
    localStorage.getItem(`lever:draft:${key}`) ?? "",
  );
}

export function hasStoredComposerInput(key: string) {
  if (readSubmission(key)) return true;
  const raw = localStorage.getItem(storageKey(key));
  if (!raw) return !!localStorage.getItem(`lever:draft:${key}`)?.trim();
  return hasInput(readDraft(key, raw, null));
}

export function saveComposerDraft(key: string, draft: Draft) {
  localStorage.setItem(storageKey(key), JSON.stringify(draft));
  localStorage.removeItem(`lever:draft:${key}`);
  draftEvents.dispatchEvent(new Event(key));
}

// Older versions kept a second draft under the expanded Chat. Keep both when
// they contain text: the older launcher draft can be recovered once Chat clears.
export function recoverTopicLauncherDraft(chatId: string) {
  const old = `new-topic:${chatId}`;
  if (!hasStoredComposerInput(old) || hasStoredComposerInput(chatId)) return;
  const pending = readSubmission(old);
  const draft = readDraft(old, localStorage.getItem(storageKey(old)), pending);
  if (pending)
    localStorage.setItem(`lever:submission:${chatId}`, JSON.stringify(pending));
  saveComposerDraft(chatId, { ...draft, topic: true });
  localStorage.removeItem(storageKey(old));
  localStorage.removeItem(`lever:submission:${old}`);
  localStorage.removeItem(`lever:draft:${old}`);
}

export function useComposerDraft(key: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
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
