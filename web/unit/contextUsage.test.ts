import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveContextMeterSnapshot,
  formatTokenCount,
} from "../src/features/chat/contextUsage.ts";

test("deriveContextMeterSnapshot returns null when usage is missing or empty", () => {
  assert.equal(deriveContextMeterSnapshot(undefined), null);
  assert.equal(deriveContextMeterSnapshot({ used: 0, window: 0 }), null);
  assert.equal(deriveContextMeterSnapshot({ used: -1, window: 1000 }), null);
});

test("deriveContextMeterSnapshot supports known window, thresholds, and levels", () => {
  const normal = deriveContextMeterSnapshot({
    used: 40_000,
    window: 200_000,
    autoCompactThreshold: 117_000,
    promptCacheExpiresAt: 1_800_000_000_000,
  });
  assert.deepEqual(normal, {
    used: 40_000,
    window: 200_000,
    percent: 20,
    ratio: 0.2,
    level: "normal",
    autoCompactThreshold: 117_000,
    autoCompactTickPercent: 58.5,
    promptCacheExpiresAt: 1_800_000_000_000,
  });

  const warn = deriveContextMeterSnapshot({ used: 80_000, window: 100_000 });
  assert.equal(warn?.level, "warn");
  assert.equal(warn?.percent, 80);

  const critical = deriveContextMeterSnapshot({ used: 95_000, window: 100_000 });
  assert.equal(critical?.level, "critical");
  assert.equal(critical?.percent, 95);

  const emptyWithWindow = deriveContextMeterSnapshot({ used: 0, window: 200_000 });
  assert.equal(emptyWithWindow?.percent, 0);
  assert.equal(emptyWithWindow?.window, 200_000);
});

test("deriveContextMeterSnapshot supports used-only usage without context window", () => {
  const usedOnly = deriveContextMeterSnapshot({ used: 24_120, window: 0 });
  assert.deepEqual(usedOnly, {
    used: 24_120,
    window: null,
    percent: null,
    ratio: null,
    level: "normal",
    autoCompactThreshold: null,
    autoCompactTickPercent: null,
    promptCacheExpiresAt: 0,
  });
});

test("formatTokenCount matches compact token formatting", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(710), "710");
  assert.equal(formatTokenCount(1_500), "1.5k");
  assert.equal(formatTokenCount(2_000), "2k");
  assert.equal(formatTokenCount(24_120), "24k");
  assert.equal(formatTokenCount(200_000), "200k");
  assert.equal(formatTokenCount(1_000_000), "1M");
  assert.equal(formatTokenCount(1_500_000), "1.5M");
});
