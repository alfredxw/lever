import assert from "node:assert/strict";
import test from "node:test";
import type { Question } from "../src/api/types.gen.ts";
import {
  buildQuestionAnswers,
  deriveQuestionProgress,
  formatQuestionCountdown,
  remainingQuestionTimeoutSeconds,
  resolveQuestionAnswer,
  setQuestionCustomAnswer,
  toggleQuestionOption,
  type QuestionDraftAnswer,
} from "../src/features/chat/questionState.ts";

const singleChoice: Question = {
  id: "auth",
  header: "Auth",
  text: "Choose authentication method",
  multiple: false,
  options: [
    { id: "oauth", label: "OAuth", description: "Browser sign-in" },
    { id: "token", label: "Token", description: "Static API key" },
  ],
};

const choiceOnly: Question = {
  ...singleChoice,
  id: "mode",
  allowCustom: false,
};

const multiOptional: Question = {
  id: "areas",
  header: "Areas",
  text: "Select optional areas",
  multiple: true,
  allowCustom: false,
  required: false,
  options: [
    { id: "ui", label: "UI" },
    { id: "api", label: "API" },
  ],
};

const prefilledText: Question = {
  id: "notes",
  header: "Notes",
  text: "Edit release notes",
  multiple: false,
  required: false,
  initialAnswer: "Initial text",
  options: [],
};

test("single-select toggles cleanly and replaces custom answer", () => {
  let draft: QuestionDraftAnswer = {};
  draft = setQuestionCustomAnswer(singleChoice, draft, "Custom SSO");
  assert.deepEqual(resolveQuestionAnswer(singleChoice, draft), ["Custom SSO"]);

  draft = toggleQuestionOption(singleChoice, draft, "oauth");
  assert.deepEqual(resolveQuestionAnswer(singleChoice, draft), ["oauth"]);
  assert.equal(draft.customAnswer, "");

  draft = toggleQuestionOption(singleChoice, draft, "token");
  assert.deepEqual(resolveQuestionAnswer(singleChoice, draft), ["token"]);
});

test("typing custom answer clears selection only when non-empty and respects allowCustom=false", () => {
  let draft = toggleQuestionOption(singleChoice, undefined, "oauth");
  draft = setQuestionCustomAnswer(singleChoice, draft, "   ");
  assert.deepEqual(resolveQuestionAnswer(singleChoice, draft), ["oauth"]);

  draft = setQuestionCustomAnswer(singleChoice, draft, "mTLS");
  assert.deepEqual(resolveQuestionAnswer(singleChoice, draft), ["mTLS"]);
  assert.equal(draft.selectedOptionIds, undefined);

  const blocked = setQuestionCustomAnswer(choiceOnly, undefined, "ignored");
  assert.equal(resolveQuestionAnswer(choiceOnly, blocked), null);
});

test("multi-select preserves selection order and optional multi-select allows empty selection", () => {
  assert.deepEqual(resolveQuestionAnswer(multiOptional, undefined), []);
  let draft = toggleQuestionOption(multiOptional, undefined, "api");
  draft = toggleQuestionOption(multiOptional, draft, "ui");
  assert.deepEqual(resolveQuestionAnswer(multiOptional, draft), ["api", "ui"]);
  draft = toggleQuestionOption(multiOptional, draft, "api");
  assert.deepEqual(resolveQuestionAnswer(multiOptional, draft), ["ui"]);
  draft = toggleQuestionOption(multiOptional, draft, "ui");
  assert.deepEqual(resolveQuestionAnswer(multiOptional, draft), []);
});

test("initialAnswer seeds untouched draft and stays empty once cleared", () => {
  assert.deepEqual(resolveQuestionAnswer(prefilledText, undefined), [
    "Initial text",
  ]);
  const cleared = setQuestionCustomAnswer(prefilledText, undefined, "");
  assert.deepEqual(resolveQuestionAnswer(prefilledText, cleared), []);
  assert.deepEqual(buildQuestionAnswers([prefilledText], { notes: cleared }), {});
});

test("buildQuestionAnswers skips optional questions and rejects missing required ones", () => {
  const optionalSingle: Question = {
    ...choiceOnly,
    id: "optional-single",
    required: false,
  };
  const questions = [choiceOnly, multiOptional, optionalSingle, prefilledText];
  assert.equal(buildQuestionAnswers(questions, {}), null);

  const answers = buildQuestionAnswers(questions, {
    mode: { selectedOptionIds: ["oauth"], touched: true },
  });
  assert.deepEqual(answers, {
    mode: ["oauth"],
    areas: [],
    notes: ["Initial text"],
  });
});

test("deriveQuestionProgress clamps index and computes advance/completion flags", () => {
  const questions = [singleChoice, multiOptional];
  const initial = deriveQuestionProgress(questions, {}, 0);
  assert.equal(initial.questionIndex, 0);
  assert.equal(initial.canAdvance, false);
  assert.equal(initial.isLastQuestion, false);
  assert.equal(initial.isComplete, false);

  const answeredFirst = deriveQuestionProgress(
    questions,
    { auth: { selectedOptionIds: ["oauth"], touched: true } },
    0,
  );
  assert.equal(answeredFirst.canAdvance, true);
  assert.equal(answeredFirst.isComplete, true);

  const clamped = deriveQuestionProgress(
    questions,
    { auth: { selectedOptionIds: ["oauth"], touched: true } },
    99,
  );
  assert.equal(clamped.questionIndex, 1);
  assert.equal(clamped.isLastQuestion, true);
  assert.equal(clamped.canAdvance, true);
});

test("question countdown helpers compute and format remaining time", () => {
  assert.equal(remainingQuestionTimeoutSeconds(undefined, 1000), null);
  assert.equal(remainingQuestionTimeoutSeconds("invalid", 1000), null);
  assert.equal(
    remainingQuestionTimeoutSeconds("2026-11-28T00:01:00.000Z", Date.parse("2026-11-28T00:00:00.200Z")),
    60,
  );
  assert.equal(
    remainingQuestionTimeoutSeconds("2026-11-28T00:00:00.000Z", Date.parse("2026-11-28T00:00:05.000Z")),
    0,
  );
  assert.equal(formatQuestionCountdown(0), "0:00");
  assert.equal(formatQuestionCountdown(7), "0:07");
  assert.equal(formatQuestionCountdown(180), "3:00");
  assert.equal(formatQuestionCountdown(3661), "1:01:01");
});
