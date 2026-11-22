import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompactCommitTime,
  summarizeGitRoots,
} from "../src/features/diff/gitSummary.ts";

test("summarizeGitRoots sums valid roots, skips errors, and preserves truncation", () => {
  assert.deepEqual(summarizeGitRoots(undefined), {
    files: 0,
    additions: 0,
    deletions: 0,
    truncated: false,
  });

  assert.deepEqual(
    summarizeGitRoots([
      {
        root: { id: "a", path: "/repo-a" },
        files: 2,
        additions: 10,
        deletions: 3,
      },
      {
        root: { id: "broken", path: "/repo-b" },
        files: 99,
        additions: 500,
        deletions: 100,
        error: "git status failed",
      },
      {
        root: { id: "c", path: "/repo-c" },
        files: 1,
        additions: 4,
        deletions: 0,
        truncated: true,
      },
    ]),
    {
      files: 3,
      additions: 14,
      deletions: 3,
      truncated: true,
    },
  );
});

test("formatCompactCommitTime handles invalid timestamps and same-day vs prior-year dates", () => {
  assert.equal(formatCompactCommitTime("not-a-date", "en-US"), null);

  const now = new Date(2026, 10, 21, 15, 0, 0);
  const sameDay = formatCompactCommitTime(
    new Date(2026, 10, 21, 9, 30, 0).toISOString(),
    "en-US",
    now,
  );
  assert.ok(sameDay);
  assert.match(sameDay.displayed, /9:30/);
  assert.ok(sameDay.full.length > 0);

  const priorYear = formatCompactCommitTime(
    new Date(2025, 2, 14, 12, 0, 0).toISOString(),
    "en-US",
    now,
  );
  assert.ok(priorYear);
  assert.match(priorYear.displayed, /2025/);
});
