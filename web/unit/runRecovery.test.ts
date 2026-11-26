import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canContinueRun,
  canRecoverRun,
} from "../src/features/chat/runRecovery.ts";
import type { Run, Session } from "../src/api/types.gen.ts";

function makeSession(overrides: Partial<Session> = {}): Pick<Session, "nativeId" | "selection"> {
  return {
    nativeId: "native-1",
    selection: { provider: "antigravity", model: "default", permission: "ask" },
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<Run> = {},
): Pick<
  Run,
  | "status"
  | "items"
  | "input"
  | "attachments"
  | "references"
  | "quote"
  | "selection"
  | "channel"
  | "superseded"
> {
  return {
    status: "failed",
    items: [{ id: "m1", kind: "text", text: "partial", status: "failed" }],
    input: "finish the change",
    attachments: [],
    references: [],
    quote: undefined,
    selection: { provider: "antigravity", model: "default", permission: "ask" },
    channel: undefined,
    superseded: false,
    ...overrides,
  };
}

test("canRecoverRun accepts only paused, failed, and interrupted statuses", () => {
  assert.equal(canRecoverRun("paused"), true);
  assert.equal(canRecoverRun("failed"), true);
  assert.equal(canRecoverRun("interrupted"), true);
  assert.equal(canRecoverRun("completed"), false);
  assert.equal(canRecoverRun("running"), false);
  assert.equal(canRecoverRun("unknown"), false);
});

test("canContinueRun distinguishes partial-output continuation from pre-output retry", () => {
  const session = makeSession();
  assert.equal(canContinueRun(makeRun(), session), true);
  assert.equal(canContinueRun(makeRun({ status: "interrupted" }), session), true);
  assert.equal(canContinueRun(makeRun({ status: "paused", items: [] }), session), true);

  // Pre-output failure (e.g. session/resume timeout) retries in place instead of continuing.
  assert.equal(canContinueRun(makeRun({ items: [] }), session), false);
  // Missing native session or switched provider cannot continue in place.
  assert.equal(canContinueRun(makeRun(), makeSession({ nativeId: "" })), false);
  assert.equal(
    canContinueRun(
      makeRun(),
      makeSession({ selection: { provider: "codex", model: "", permission: "ask" } }),
    ),
    false,
  );
  // Standalone slash commands retry instead of continuing, unless quoted/attached.
  assert.equal(canContinueRun(makeRun({ input: "/compact" }), session), false);
  assert.equal(
    canContinueRun(
      makeRun({
        input: "/compact",
        quote: { runId: "r0", role: "user", text: "earlier" },
      }),
      session,
    ),
    true,
  );
  // Superseded or channel turns cannot continue.
  assert.equal(canContinueRun(makeRun({ superseded: true }), session), false);
  assert.equal(
    canContinueRun(makeRun({ channel: { status: "failed" } }), session),
    false,
  );
});
