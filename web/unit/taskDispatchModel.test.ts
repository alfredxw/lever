import assert from "node:assert/strict";
import test from "node:test";
import {
  recentAgentSelection,
  selectionForAgentProvider,
  type RuntimePreferences,
} from "../src/features/runtime/runtimePreferences.ts";

const profile = { provider: "codex", model: "gpt-5.3-codex" };

test("recentAgentSelection returns undefined when no manual recent provider exists", () => {
  assert.equal(recentAgentSelection(profile, undefined), undefined);
  assert.equal(recentAgentSelection(profile, { models: {} }), undefined);
});

test("recentAgentSelection returns the Agent's recent model without inheriting permission", () => {
  const preferences: RuntimePreferences = {
    provider: "claude",
    models: {
      claude: { model: "claude-opus-4-6", effort: "high", fast: true },
      codex: { model: "gpt-5.4", effort: "medium", fast: false },
    },
    permissions: {
      claude: "full_access",
      codex: "full_access",
    },
  };
  const recent = recentAgentSelection(profile, preferences);
  assert.deepEqual(recent, {
    provider: "claude",
    model: "claude-opus-4-6",
    effort: "high",
    fast: true,
  });
  assert.equal("permission" in (recent ?? {}), false);
});

test("selectionForAgentProvider prefers in-picker previous choice, then remembered, then profile fallback", () => {
  const preferences: RuntimePreferences = {
    provider: "codex",
    models: {
      codex: { model: "gpt-5.4", effort: "high", fast: false },
    },
  };

  // Remembers per-provider choice when no previous in-picker choice exists.
  assert.deepEqual(selectionForAgentProvider(profile, "codex", preferences), {
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
    fast: false,
  });

  // Falls back to empty model when switching to a provider without remembered or profile defaults.
  assert.deepEqual(selectionForAgentProvider(profile, "claude", preferences), {
    provider: "claude",
    model: "",
    effort: "",
    fast: false,
  });

  // Falls back to profile model when switching back to profile provider without remembered model.
  assert.deepEqual(selectionForAgentProvider(profile, "codex", { models: {} }), {
    provider: "codex",
    model: "gpt-5.3-codex",
    effort: "",
    fast: false,
  });

  // Preserves previous choice made during the same picker session while stripping permission.
  assert.deepEqual(
    selectionForAgentProvider(profile, "claude", preferences, {
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "medium",
      fast: false,
      permission: "full_access",
    }),
    {
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "medium",
      fast: false,
    },
  );
});
