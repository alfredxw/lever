import assert from "node:assert/strict";
import test from "node:test";
import { formatMessageTime } from "../src/features/chat/messageTime.ts";

test("formatMessageTime returns null for missing or invalid timestamps", () => {
  assert.equal(formatMessageTime(undefined, "zh-CN"), null);
  assert.equal(formatMessageTime("", "zh-CN"), null);
  assert.equal(formatMessageTime("not-a-date", "en-US"), null);
});

test("formatMessageTime shows 24h time for today, including midnight", () => {
  const now = new Date(2026, 10, 25, 12, 30, 0);

  const midnight = formatMessageTime(
    new Date(2026, 10, 25, 0, 5, 9).toISOString(),
    "en-US",
    { now, formatYesterday: (time) => `Yesterday ${time}` },
  );
  assert.ok(midnight);
  assert.equal(midnight.displayed, "00:05");
  assert.match(midnight.full, /2026/);
  assert.match(midnight.full, /00:05:09/);

  const evening = formatMessageTime(
    new Date(2026, 10, 25, 20, 37, 12).toISOString(),
    "zh-CN",
    { now, formatYesterday: (time) => `昨天 ${time}` },
  );
  assert.ok(evening);
  assert.equal(evening.displayed, "20:37");
  assert.match(evening.full, /2026/);
  assert.match(evening.full, /20:37:12/);
});

test("formatMessageTime shows yesterday with 24h time, including across year boundaries", () => {
  const now = new Date(2026, 10, 25, 12, 30, 0);
  const yesterdayZh = formatMessageTime(
    new Date(2026, 10, 24, 20, 37, 0).toISOString(),
    "zh-CN",
    { now, formatYesterday: (time) => `昨天 ${time}` },
  );
  assert.ok(yesterdayZh);
  assert.equal(yesterdayZh.displayed, "昨天 20:37");

  const yesterdayEn = formatMessageTime(
    new Date(2026, 10, 24, 20, 37, 0).toISOString(),
    "en-US",
    { now, formatYesterday: (time) => `Yesterday ${time}` },
  );
  assert.ok(yesterdayEn);
  assert.equal(yesterdayEn.displayed, "Yesterday 20:37");

  const newYearNow = new Date(2026, 0, 1, 8, 0, 0);
  const newYearsEve = formatMessageTime(
    new Date(2025, 11, 31, 23, 55, 0).toISOString(),
    "zh-CN",
    { now: newYearNow, formatYesterday: (time) => `昨天 ${time}` },
  );
  assert.ok(newYearsEve);
  assert.equal(newYearsEve.displayed, "昨天 23:55");
});

test("formatMessageTime includes month and day for earlier dates this year and year for other years", () => {
  const now = new Date(2026, 10, 25, 12, 30, 0);

  const sameYearZh = formatMessageTime(
    new Date(2026, 10, 20, 20, 37, 0).toISOString(),
    "zh-CN",
    { now, formatYesterday: (time) => `昨天 ${time}` },
  );
  assert.ok(sameYearZh);
  assert.equal(sameYearZh.displayed, "11月20日 20:37");
  assert.doesNotMatch(sameYearZh.displayed, /2026/);

  const sameYearEn = formatMessageTime(
    new Date(2026, 10, 20, 20, 37, 0).toISOString(),
    "en-US",
    { now, formatYesterday: (time) => `Yesterday ${time}` },
  );
  assert.ok(sameYearEn);
  assert.equal(sameYearEn.displayed, "Nov 20, 20:37");
  assert.doesNotMatch(sameYearEn.displayed, /2026/);

  const prevYearZh = formatMessageTime(
    new Date(2025, 2, 5, 9, 5, 0).toISOString(),
    "zh-CN",
    { now, formatYesterday: (time) => `昨天 ${time}` },
  );
  assert.ok(prevYearZh);
  assert.equal(prevYearZh.displayed, "2025年3月5日 09:05");

  const prevYearEn = formatMessageTime(
    new Date(2025, 2, 5, 9, 5, 0).toISOString(),
    "en-US",
    { now, formatYesterday: (time) => `Yesterday ${time}` },
  );
  assert.ok(prevYearEn);
  assert.equal(prevYearEn.displayed, "Mar 5, 2025, 09:05");
});

test("formatMessageTime falls back to date and time when formatYesterday is omitted or date is in the future", () => {
  const now = new Date(2026, 10, 25, 12, 30, 0);

  const yesterdayWithoutLabel = formatMessageTime(
    new Date(2026, 10, 24, 20, 37, 0).toISOString(),
    "zh-CN",
    { now },
  );
  assert.ok(yesterdayWithoutLabel);
  assert.equal(yesterdayWithoutLabel.displayed, "11月24日 20:37");

  const tomorrow = formatMessageTime(
    new Date(2026, 10, 26, 9, 0, 0).toISOString(),
    "zh-CN",
    { now, formatYesterday: (time) => `昨天 ${time}` },
  );
  assert.ok(tomorrow);
  assert.equal(tomorrow.displayed, "11月26日 09:00");
});
