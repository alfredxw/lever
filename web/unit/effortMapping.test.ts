import assert from "node:assert/strict";
import test from "node:test";
import {
  isMeaningfulEffortSource,
  resolveEffort,
} from "../src/features/runtime/effortMapping.ts";

const carbon = {
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
};

const neon = {
  efforts: ["low", "medium", "high", "xhigh"],
  defaultEffort: "medium",
};

const gpt = {
  efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  defaultEffort: "medium",
};

const gptNoUltra = {
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "medium",
};

const opus47 = {
  efforts: ["low", "medium", "high", "max"],
  defaultEffort: "",
};

const piModel = {
  efforts: ["off", "minimal", "low", "medium", "high"],
  defaultEffort: "medium",
};

const codexWithNone = {
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  defaultEffort: "medium",
};

const singleEffort = {
  efforts: ["low"],
  defaultEffort: "low",
};

const noEffort = {
  efforts: [],
  defaultEffort: "",
};

const customAcp = {
  efforts: ["balanced", "deep"],
  defaultEffort: "balanced",
};

test("switching from a model's standard ceiling maps to the target model's standard ceiling, never ultra", () => {
  // Carbon (top=high) -> GPT (top=max, ultra separate) => max
  assert.equal(
    resolveEffort({ effort: "high", efforts: carbon.efforts }, gpt),
    "max",
  );
  // Neon (top=xhigh) -> GPT (top=max, ultra separate) => max
  assert.equal(
    resolveEffort({ effort: "xhigh", efforts: neon.efforts }, gpt),
    "max",
  );
  // Carbon (top=high) -> Neon (top=xhigh) => xhigh
  assert.equal(
    resolveEffort({ effort: "high", efforts: carbon.efforts }, neon),
    "xhigh",
  );
  // Neon (top=xhigh) -> Carbon (top=high) => high
  assert.equal(
    resolveEffort({ effort: "xhigh", efforts: neon.efforts }, carbon),
    "high",
  );
  // GPT (top=max) -> Neon (top=xhigh) => xhigh
  assert.equal(
    resolveEffort({ effort: "max", efforts: gpt.efforts }, neon),
    "xhigh",
  );
  // GPT (top=max) -> Carbon (top=high) => high
  assert.equal(
    resolveEffort({ effort: "max", efforts: gpt.efforts }, carbon),
    "high",
  );
  // Carbon (top=high) -> Claude Opus 4.7 (top=max) => max
  assert.equal(
    resolveEffort({ effort: "high", efforts: carbon.efforts }, opus47),
    "max",
  );
  // Pi (top=high) -> GPT (top=max, ultra separate) => max
  assert.equal(
    resolveEffort({ effort: "high", efforts: piModel.efforts }, gpt),
    "max",
  );
  // Custom ACP (top=deep) -> GPT => max, and GPT max -> Custom ACP => deep
  assert.equal(
    resolveEffort({ effort: "deep", efforts: customAcp.efforts }, gpt),
    "max",
  );
  assert.equal(
    resolveEffort({ effort: "max", efforts: gpt.efforts }, customAcp),
    "deep",
  );
});

test("ultra stays separate as an explicit multi-agent tier and steps down to standard ceiling when unsupported", () => {
  assert.equal(
    resolveEffort({ effort: "ultra", efforts: gpt.efforts }, codexWithNone),
    "ultra",
  );
  assert.equal(
    resolveEffort({ effort: "ultra", efforts: gpt.efforts }, gptNoUltra),
    "max",
  );
  assert.equal(
    resolveEffort({ effort: "ultra", efforts: gpt.efforts }, neon),
    "xhigh",
  );
  assert.equal(
    resolveEffort({ effort: "ultra", efforts: gpt.efforts }, carbon),
    "high",
  );
});

test("non-ceiling standard efforts preserve their level without spurious escalation or drop", () => {
  // Low and medium stay low and medium even when minimal/off exist on target.
  assert.equal(
    resolveEffort({ effort: "low", efforts: carbon.efforts }, codexWithNone),
    "low",
  );
  assert.equal(
    resolveEffort({ effort: "medium", efforts: carbon.efforts }, gpt),
    "medium",
  );
  assert.equal(
    resolveEffort({ effort: "low", efforts: gpt.efforts }, piModel),
    "low",
  );
  // Non-ceiling high on Neon stays high on GPT.
  assert.equal(
    resolveEffort({ effort: "high", efforts: neon.efforts }, gpt),
    "high",
  );
  // Non-ceiling xhigh on GPT maps to high (not max) on Opus 4.7 which has [low, medium, high, max].
  assert.equal(
    resolveEffort({ effort: "xhigh", efforts: gpt.efforts }, opus47),
    "high",
  );
  // Non-ceiling xhigh on GPT clamps to high on Carbon [low, medium, high].
  assert.equal(
    resolveEffort({ effort: "xhigh", efforts: gpt.efforts }, carbon),
    "high",
  );
  // Minimal maps to low when target lacks minimal.
  assert.equal(
    resolveEffort({ effort: "minimal", efforts: piModel.efforts }, carbon),
    "low",
  );
});

test("off/none, empty, single-option, and no-effort models behave predictably", () => {
  assert.equal(
    resolveEffort({ effort: "off", efforts: piModel.efforts }, codexWithNone),
    "none",
  );
  assert.equal(
    resolveEffort({ effort: "none", efforts: codexWithNone.efforts }, piModel),
    "off",
  );
  assert.equal(
    resolveEffort({ effort: "off", efforts: piModel.efforts }, carbon),
    "low",
  );
  // Single-option source model is NOT treated as a ceiling habit.
  assert.equal(
    resolveEffort({ effort: "low", efforts: singleEffort.efforts }, gpt),
    "low",
  );
  assert.equal(isMeaningfulEffortSource("low", singleEffort.efforts), false);
  assert.equal(isMeaningfulEffortSource("high", carbon.efforts), true);
  // Single-option target model always selects its only effort.
  assert.equal(
    resolveEffort({ effort: "max", efforts: gpt.efforts }, singleEffort),
    "low",
  );
  // No-effort target returns empty string.
  assert.equal(
    resolveEffort({ effort: "max", efforts: gpt.efforts }, noEffort),
    "",
  );
  // Empty source effort falls back to target defaultEffort.
  assert.equal(resolveEffort("", gpt), "medium");
  assert.equal(resolveEffort(undefined, opus47), "");
});

test("normalization handles extra_high / mixed case and returns target's exact effort ID", () => {
  const mixedTarget = {
    efforts: ["Low", "Medium", "High", "Extra_High"],
    defaultEffort: "Medium",
  };
  assert.equal(
    resolveEffort({ effort: "high", efforts: carbon.efforts }, mixedTarget),
    "Extra_High",
  );
  assert.equal(
    resolveEffort({ effort: "Extra_High", efforts: mixedTarget.efforts }, gpt),
    "max",
  );
});
