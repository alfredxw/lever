import { useCallback, useSyncExternalStore } from "react";
import type { Question, Request } from "@/api/types.gen";
import {
  setQuestionCustomAnswer,
  toggleQuestionOption,
  type QuestionRequestDraft,
} from "./questionState";

// Keep partial answers and step position for the lifetime of the request, even
// when its conversation leaves the workbench's bounded cache of mounted panels.
const emptyDraft: QuestionRequestDraft = { answers: {}, questionIndex: 0 };
const drafts = new Map<string, QuestionRequestDraft>();
const changes = new EventTarget();

function notify(id: string) {
  changes.dispatchEvent(new Event(id));
}

function isEmptyDraft(draft: QuestionRequestDraft) {
  return (
    draft.questionIndex === 0 && Object.keys(draft.answers).length === 0
  );
}

export function hasQuestionDraft(id: string) {
  return drafts.has(id);
}

export function pruneQuestionDrafts(pending: Request[]) {
  for (const id of drafts.keys()) {
    if (!pending.some((request) => request.id === id)) {
      drafts.delete(id);
      notify(id);
    }
  }
}

export function useQuestionDraft(id: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      changes.addEventListener(id, listener);
      return () => changes.removeEventListener(id, listener);
    },
    [id],
  );
  const draft = useSyncExternalStore(
    subscribe,
    () => drafts.get(id) ?? emptyDraft,
  );

  const update = useCallback(
    (updater: (current: QuestionRequestDraft) => QuestionRequestDraft) => {
      const current = drafts.get(id) ?? emptyDraft;
      const next = updater(current);
      if (isEmptyDraft(next)) drafts.delete(id);
      else drafts.set(id, next);
      notify(id);
    },
    [id],
  );

  const toggleOption = useCallback(
    (question: Question, optionId: string) => {
      update((current) => ({
        ...current,
        answers: {
          ...current.answers,
          [question.id]: toggleQuestionOption(
            question,
            current.answers[question.id],
            optionId,
          ),
        },
      }));
    },
    [update],
  );

  const setCustomAnswer = useCallback(
    (question: Question, value: string) => {
      update((current) => ({
        ...current,
        answers: {
          ...current.answers,
          [question.id]: setQuestionCustomAnswer(
            question,
            current.answers[question.id],
            value,
          ),
        },
      }));
    },
    [update],
  );

  const setQuestionIndex = useCallback(
    (questionIndex: number) => {
      update((current) =>
        current.questionIndex === questionIndex
          ? current
          : { ...current, questionIndex },
      );
    },
    [update],
  );

  return { draft, toggleOption, setCustomAnswer, setQuestionIndex } as const;
}
