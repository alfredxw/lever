import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderInfo } from "../src/api/types.gen.ts";
import {
  liveUsageWindows,
  normalizeUsageResponse,
  resolveSubscriptions,
  usageSources,
} from "../src/features/runtime/subscriptionUsageModel.ts";

function providerInfo(overrides: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: "codex",
    pluginId: "lever.codex",
    contributionId: "codex",
    type: "codex",
    name: "Codex",
    command: "",
    args: [],
    enabled: true,
    available: true,
    path: "/usr/local/bin/codex",
    version: "0.144.6",
    installed: true,
    reportsUsage: true,
    auth: "cli",
    capabilities: {
      modes: [],
      approvals: true,
      questions: true,
      images: true,
      mcp: true,
      directoryContext: true,
    },
    ...overrides,
  };
}

test("normalizeUsageResponse accepts both ProviderUsage and legacy UsageWindow arrays", () => {
  const win = { id: "primary", minutes: 300, usedPercent: 40 };
  assert.deepEqual(normalizeUsageResponse(undefined), undefined);
  assert.deepEqual(normalizeUsageResponse(null), { windows: [] });
  assert.deepEqual(normalizeUsageResponse([win]), { windows: [win] });
  assert.deepEqual(
    normalizeUsageResponse({
      windows: [win],
      sampledAt: "2026-11-25T07:00:00Z",
      stale: true,
    }),
    {
      windows: [win],
      sampledAt: "2026-11-25T07:00:00Z",
      stale: true,
    },
  );
});

test("liveUsageWindows drops already-reset windows while keeping active and reset-free ones", () => {
  const now = Date.parse("2026-11-25T10:00:00Z");
  const windows = liveUsageWindows(
    [
      { id: "past", usedPercent: 95, resetsAt: "2026-11-25T09:59:00Z" },
      { id: "exact", usedPercent: 80, resetsAt: "2026-11-25T10:00:00Z" },
      { id: "future", usedPercent: 30, resetsAt: "2026-11-25T12:00:00Z" },
      { id: "none", usedPercent: 10 },
    ],
    now,
  );
  assert.deepEqual(
    windows.map((w) => w.id),
    ["future", "none"],
  );
});

test("resolveSubscriptions unifies loading, stale, error, and empty semantics across providers", () => {
  const now = Date.parse("2026-11-25T10:00:00Z");
  const codex = providerInfo({ id: "codex", type: "codex", name: "Codex" });
  const claude = providerInfo({
    id: "claude",
    pluginId: "lever.claude",
    contributionId: "claude",
    type: "claude",
    name: "Claude",
  });
  const agy = providerInfo({
    id: "antigravity",
    pluginId: "lever.antigravity",
    contributionId: "antigravity",
    type: "antigravity",
    name: "Antigravity",
  });

  // Loading shows progress for all providers.
  const loading = resolveSubscriptions(
    [codex, agy],
    [
      { isPending: true, isError: false },
      { isPending: true, isError: false },
    ],
    now,
  );
  assert.deepEqual(
    loading.map((s) => [s.provider.id, s.notice]),
    [
      ["codex", "usage.loading"],
      ["antigravity", "usage.loading"],
    ],
  );

  // First-ever errors show provider-appropriate error messages instead of silently hiding Codex/Claude.
  const errors = resolveSubscriptions(
    [codex, claude, agy],
    [
      { isPending: false, isError: true },
      { isPending: false, isError: true },
      { isPending: false, isError: true },
    ],
    now,
  );
  assert.deepEqual(
    errors.map((s) => [s.provider.id, s.notice]),
    [
      ["codex", "usage.readFailed"],
      ["claude", "usage.readFailed"],
      ["antigravity", "usage.readFailedAgy"],
    ],
  );

  // Stale backend response keeps windows and marks usage.lastReading.
  const stale = resolveSubscriptions(
    [codex],
    [
      {
        data: {
          windows: [
            {
              id: "primary",
              minutes: 300,
              usedPercent: 45,
              resetsAt: "2026-11-25T13:00:00Z",
            },
          ],
          sampledAt: "2026-11-25T09:00:00Z",
          stale: true,
        },
        isPending: false,
        isError: false,
      },
    ],
    now,
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0].notice, "usage.lastReading");
  assert.equal(stale[0].stale, true);
  assert.equal(stale[0].windows[0].usedPercent, 45);

  // Confirmed empty windows hide Codex/Claude (e.g. API key) while keeping Antigravity noAllowance.
  const empty = resolveSubscriptions(
    [codex, claude, agy],
    [
      { data: { windows: [] }, isPending: false, isError: false },
      { data: { windows: [] }, isPending: false, isError: false },
      { data: { windows: [] }, isPending: false, isError: false },
    ],
    now,
  );
  assert.deepEqual(
    empty.map((s) => [s.provider.id, s.notice]),
    [["antigravity", "usage.noAllowance"]],
  );
});

test("usageSources deduplicates identical native profiles", () => {
  const first = providerInfo({
    id: "codex-1",
    configPath: "/tmp/codex-home",
  });
  const duplicate = providerInfo({
    id: "codex-2",
    configPath: "/tmp/codex-home",
  });
  const other = providerInfo({
    id: "codex-3",
    configPath: "/tmp/codex-work",
  });
  assert.deepEqual(
    usageSources([first, duplicate, other]).map((p) => p.id),
    ["codex-1", "codex-3"],
  );
});
