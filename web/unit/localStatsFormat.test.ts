import test from "node:test";
import assert from "node:assert/strict";
import {
  computeWindowPace,
  fmtAxisTokens,
  fmtAxisUsd,
  fmtPct,
  fmtTokens,
  fmtUsd,
  formatSlotLabel,
  providerAccent,
} from "../src/features/usage/format.ts";

test("formats token, currency, and percentage values cleanly", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(850), "850");
  assert.equal(fmtTokens(12_400), "12.4K");
  assert.equal(fmtTokens(852_100_000), "852.1M");
  assert.equal(fmtTokens(2_719_406_898), "2.72B");

  assert.equal(fmtAxisTokens(0), "0");
  assert.equal(fmtAxisTokens(2_000_000), "2M");
  assert.equal(fmtAxisTokens(1_500_000_000), "1.5B");

  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(0.004), "$0.004");
  assert.equal(fmtUsd(24.1), "$24.10");
  assert.equal(fmtUsd(1240.8), "$1,241");
  assert.equal(fmtAxisUsd(0), "$0");
  assert.equal(fmtAxisUsd(50), "$50");

  assert.equal(fmtPct(0), "0%");
  assert.equal(fmtPct(0.0002), "<0.1%");
  assert.equal(fmtPct(0.875), "87.5%");
  assert.equal(fmtPct(0.9), "90%");
  assert.equal(fmtPct(1), "100%");
});

test("computeWindowPace calculates elapsed time tick and pace status", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  // 5h window (300m), resets in 2h (120m) => 60% elapsed
  const fast = computeWindowPace(
    {
      id: "primary",
      usedPercent: 72,
      minutes: 300,
      resetsAt: "2026-11-27T14:00:00Z",
    },
    now,
  );
  assert.equal(fast.usedPercent, 72);
  assert.equal(fast.remainingPercent, 28);
  assert.equal(fast.elapsedPercent, 60);
  assert.equal(fast.delta, 12);
  assert.equal(fast.status, "fast");

  const ample = computeWindowPace(
    {
      id: "secondary",
      usedPercent: 40,
      minutes: 300,
      resetsAt: "2026-11-27T14:00:00Z",
    },
    now,
  );
  assert.equal(ample.delta, -20);
  assert.equal(ample.status, "ok");

  const noReset = computeWindowPace({ id: "primary", usedPercent: 55 }, now);
  assert.equal(noReset.elapsedPercent, null);
  assert.equal(noReset.delta, null);
  assert.equal(noReset.status, "steady");
});

test("formatSlotLabel and providerAccent handle hourly, daily, and fallback cases", () => {
  assert.equal(formatSlotLabel("2026-11-27T15:00", "hour"), "15:00");
  assert.equal(formatSlotLabel("2026-11-27", "day"), "11/27");
  assert.equal(providerAccent("claude"), "var(--usage-clay)");
  assert.equal(providerAccent("codex"), "var(--usage-blue)");
  assert.equal(providerAccent("antigravity"), "var(--usage-violet)");
  assert.equal(providerAccent("pi"), "var(--usage-teal)");
});
