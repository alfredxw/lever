import assert from "node:assert/strict";
import test from "node:test";
import { pickFirstUnreadRun } from "../src/features/chat/unreadStart.ts";

test("pickFirstUnreadRun selects the earliest run after the previous read cursor", () => {
  const runs = [
    { id: "r1", status: "completed", unreadSequence: 10 },
    { id: "r2", status: "completed", unreadSequence: 20 },
    { id: "r3", status: "completed", unreadSequence: 30 },
  ];
  assert.deepEqual(pickFirstUnreadRun(runs, 10), {
    run: runs[1],
    matched: true,
  });
  assert.deepEqual(pickFirstUnreadRun(runs, 0), {
    run: runs[0],
    matched: true,
  });
  assert.deepEqual(pickFirstUnreadRun(runs, 25), {
    run: runs[2],
    matched: true,
  });
});

test("pickFirstUnreadRun matches a waiting_user or newly finished run even when a later run is streaming", () => {
  const runs = [
    { id: "r1", status: "completed", unreadSequence: 10 },
    { id: "r2", status: "completed", unreadSequence: 20 },
    { id: "r3", status: "running" },
  ];
  assert.deepEqual(pickFirstUnreadRun(runs, 15), {
    run: runs[1],
    matched: true,
  });

  const waiting = [
    { id: "r1", status: "completed", unreadSequence: 10 },
    { id: "r2", status: "waiting_user", unreadSequence: 18 },
  ];
  assert.deepEqual(pickFirstUnreadRun(waiting, 12), {
    run: waiting[1],
    matched: true,
  });
});

test("pickFirstUnreadRun falls back to the latest finished or waiting run for legacy history", () => {
  const runs = [
    { id: "r1", status: "completed" },
    { id: "r2", status: "completed" },
    { id: "r3", status: "running" },
  ];
  assert.deepEqual(pickFirstUnreadRun(runs, 5), {
    run: runs[1],
    matched: false,
  });
  assert.deepEqual(pickFirstUnreadRun([], 0), {
    run: undefined,
    matched: false,
  });
});
