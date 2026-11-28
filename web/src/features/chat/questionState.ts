import type { Question } from "@/api/types.gen";

export type QuestionDraftAnswer = {
  selectedOptionIds?: string[];
  customAnswer?: string;
  touched?: boolean;
};

export type QuestionRequestDraft = {
  answers: Record<string, QuestionDraftAnswer>;
  questionIndex: number;
};

export type QuestionProgress = {
  questionIndex: number;
  activeQuestion: Question | null;
  activeDraft: QuestionDraftAnswer | undefined;
  selectedOptionIds: string[];
  customAnswer: string;
  usingCustomAnswer: boolean;
  resolvedAnswer: string[] | null;
  answeredCount: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isComplete: boolean;
};

export function allowsCustomAnswer(question: Question): boolean {
  return question.allowCustom !== false;
}

export function isQuestionRequired(question: Question): boolean {
  return question.required !== false;
}

export function remainingQuestionTimeoutSeconds(
  expiresAt: string | undefined,
  nowMs = Date.now(),
): number | null {
  if (!expiresAt) return null;
  const deadlineMs = Date.parse(expiresAt);
  if (!Number.isFinite(deadlineMs)) return null;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

export function formatQuestionCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${minutes}:${pad(secs)}`;
}

export function normalizeSelectedOptionIds(
  question: Question,
  values: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const valid = new Set(question.options.map((option) => option.id));
  const out: string[] = [];
  for (const value of values) {
    if (valid.has(value) && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

export function effectiveCustomAnswer(
  question: Question,
  draft: QuestionDraftAnswer | undefined,
): string {
  if (!allowsCustomAnswer(question)) return "";
  if (draft?.touched || draft?.customAnswer !== undefined) {
    return draft.customAnswer ?? "";
  }
  return question.initialAnswer ?? "";
}

export function hasCustomAnswerValue(
  question: Question,
  draft: QuestionDraftAnswer | undefined,
): boolean {
  const custom = effectiveCustomAnswer(question, draft);
  return question.initialAnswer !== undefined
    ? custom.length > 0
    : custom.trim().length > 0;
}

export function resolveQuestionAnswer(
  question: Question,
  draft: QuestionDraftAnswer | undefined,
): string[] | null {
  if (allowsCustomAnswer(question)) {
    const custom = effectiveCustomAnswer(question, draft);
    if (question.initialAnswer !== undefined) {
      if (custom.length > 0) return [custom];
    } else if (custom.trim().length > 0) {
      return [custom.trim()];
    }
  }

  if (question.options.length === 0) {
    return isQuestionRequired(question) ? null : [];
  }

  const selected = normalizeSelectedOptionIds(
    question,
    draft?.selectedOptionIds,
  );
  if (selected.length > 0) {
    return selected;
  }
  if (question.multiple && !isQuestionRequired(question)) {
    return [];
  }
  return null;
}

export function toggleQuestionOption(
  question: Question,
  draft: QuestionDraftAnswer | undefined,
  optionId: string,
): QuestionDraftAnswer {
  if (!question.options.some((option) => option.id === optionId)) {
    return draft ?? {};
  }
  if (question.multiple) {
    const current = normalizeSelectedOptionIds(
      question,
      draft?.selectedOptionIds,
    );
    const next = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId];
    return {
      touched: true,
      customAnswer: "",
      ...(next.length > 0 ? { selectedOptionIds: next } : {}),
    };
  }
  return {
    touched: true,
    customAnswer: "",
    selectedOptionIds: [optionId],
  };
}

export function setQuestionCustomAnswer(
  question: Question,
  draft: QuestionDraftAnswer | undefined,
  value: string,
): QuestionDraftAnswer {
  if (!allowsCustomAnswer(question)) {
    return draft ?? {};
  }
  const keepSelected =
    question.initialAnswer === undefined && value.trim().length === 0;
  const selected = keepSelected
    ? normalizeSelectedOptionIds(question, draft?.selectedOptionIds)
    : [];
  return {
    touched: true,
    customAnswer: value,
    ...(selected.length > 0 ? { selectedOptionIds: selected } : {}),
  };
}

export function buildQuestionAnswers(
  questions: readonly Question[],
  draftAnswers: Record<string, QuestionDraftAnswer>,
): Record<string, string[]> | null {
  const result: Record<string, string[]> = {};
  for (const question of questions) {
    const resolved = resolveQuestionAnswer(question, draftAnswers[question.id]);
    if (resolved === null) {
      if (!isQuestionRequired(question)) continue;
      return null;
    }
    if (resolved.length > 0) {
      result[question.id] = resolved;
    } else if (question.multiple && !isQuestionRequired(question)) {
      result[question.id] = [];
    }
  }
  return result;
}

export function deriveQuestionProgress(
  questions: readonly Question[],
  draftAnswers: Record<string, QuestionDraftAnswer>,
  questionIndex: number,
): QuestionProgress {
  const normalizedIndex =
    questions.length === 0
      ? 0
      : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedIndex] ?? null;
  const activeDraft = activeQuestion
    ? draftAnswers[activeQuestion.id]
    : undefined;
  const customAnswer = activeQuestion
    ? effectiveCustomAnswer(activeQuestion, activeDraft)
    : "";
  const usingCustomAnswer = activeQuestion
    ? hasCustomAnswerValue(activeQuestion, activeDraft)
    : false;
  const selectedOptionIds =
    activeQuestion && !usingCustomAnswer
      ? normalizeSelectedOptionIds(activeQuestion, activeDraft?.selectedOptionIds)
      : [];
  const resolvedAnswer = activeQuestion
    ? resolveQuestionAnswer(activeQuestion, activeDraft)
    : null;
  const answeredCount = questions.reduce(
    (count, question) =>
      resolveQuestionAnswer(question, draftAnswers[question.id]) !== null
        ? count + 1
        : count,
    0,
  );
  const isLastQuestion =
    questions.length === 0 || normalizedIndex >= questions.length - 1;
  const canAdvance =
    activeQuestion !== null &&
    (resolvedAnswer !== null || !isQuestionRequired(activeQuestion));
  return {
    questionIndex: normalizedIndex,
    activeQuestion,
    activeDraft,
    selectedOptionIds,
    customAnswer,
    usingCustomAnswer,
    resolvedAnswer,
    answeredCount,
    isLastQuestion,
    canAdvance,
    isComplete: buildQuestionAnswers(questions, draftAnswers) !== null,
  };
}
