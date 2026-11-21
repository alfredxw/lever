import { useCallback, useSyncExternalStore } from "react";
import type { Request } from "@/api/types.gen";

// Keep partial answers for the lifetime of the request, even when its
// conversation leaves the workbench's bounded cache of mounted panels.
type Answers = Record<string, string | string[]>;
const empty: Answers = {};
const drafts = new Map<string, Answers>();
const changes = new EventTarget();

export function hasQuestionDraft(id: string) {
  return drafts.has(id);
}

export function pruneQuestionDrafts(pending: Request[]) {
  for (const id of drafts.keys()) {
    if (!pending.some((request) => request.id === id)) {
      drafts.delete(id);
      changes.dispatchEvent(new Event(id));
    }
  }
}

export function useQuestionDraft(id: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      changes.addEventListener(id, notify);
      return () => changes.removeEventListener(id, notify);
    },
    [id],
  );
  const answers = useSyncExternalStore(
    subscribe,
    () => drafts.get(id) ?? empty,
  );

  function setAnswer(question: string, value: string | string[]) {
    const next = { ...drafts.get(id) };
    if (value.length) next[question] = value;
    else delete next[question];
    if (Object.keys(next).length) drafts.set(id, next);
    else drafts.delete(id);
    changes.dispatchEvent(new Event(id));
  }

  return [answers, setAnswer] as const;
}
