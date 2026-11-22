import assert from "node:assert/strict";
import test from "node:test";
import { createAutoSaver } from "../src/lib/autoSave.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("serializes overlapping saves and rebases queued snapshots against server response", async () => {
  type Doc = { version: number; name: string };
  const calls: Doc[] = [];
  const first = deferred<Doc>();
  const second = deferred<Doc>();
  const saved: Doc[] = [];

  const saver = createAutoSaver<Doc, Doc>({
    initialSignature: JSON.stringify({ name: "v0" }),
    debounceMs: 20,
    save: (doc) => {
      calls.push(doc);
      return calls.length === 1 ? first.promise : second.promise;
    },
    rebase: (latest, result) => ({ ...latest, version: result.version }),
    onSaved: (result) => saved.push(result),
  });

  saver.schedule(
    { version: 1, name: "v1" },
    JSON.stringify({ name: "v1" }),
    "immediate",
  );
  assert.equal(saver.getState().saving, true);
  assert.equal(saver.getState().pending, false);

  // User edits again while the first PUT is still in flight.
  saver.schedule(
    { version: 1, name: "v2" },
    JSON.stringify({ name: "v2" }),
    "immediate",
  );
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(saver.getState().pending, true);

  first.resolve({ version: 2, name: "v1" });
  await tick();
  await tick();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { version: 2, name: "v2" });

  second.resolve({ version: 3, name: "v2" });
  await tick();
  await tick();

  assert.deepEqual(saved, [
    { version: 2, name: "v1" },
    { version: 3, name: "v2" },
  ]);
  assert.deepEqual(saver.getState(), {
    saving: false,
    pending: false,
    error: null,
  });
});

test("skips redundant saves when reverting before debounce fires, but restores when reverting mid-flight", async () => {
  const calls: string[] = [];
  const pending = deferred<string>();

  const saver = createAutoSaver<string, string>({
    initialSignature: "a",
    debounceMs: 25,
    save: (value) => {
      calls.push(value);
      return calls.length === 1 ? pending.promise : Promise.resolve(value);
    },
  });

  // Revert before debounce expires -> zero requests.
  saver.schedule("b", "b", "debounced");
  assert.equal(saver.getState().pending, true);
  saver.schedule("a", "a", "debounced");
  assert.equal(saver.getState().pending, false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, []);

  // Revert while first save is in flight -> second save restores original.
  saver.schedule("b", "b", "immediate");
  await tick();
  assert.deepEqual(calls, ["b"]);
  saver.schedule("a", "a", "immediate");
  pending.resolve("b");
  await tick();
  await tick();
  assert.deepEqual(calls, ["b", "a"]);
});

test("stops retrying the same failed snapshot until retry() or a new edit", async () => {
  const calls: string[] = [];
  let shouldFail = true;
  const saver = createAutoSaver<string, string>({
    initialSignature: "init",
    save: async (value) => {
      calls.push(value);
      if (shouldFail) throw new Error("boom");
      return value;
    },
  });

  saver.schedule("bad", "bad", "immediate");
  await tick();
  await tick();
  assert.equal(calls.length, 1);
  assert.ok(saver.getState().error instanceof Error);

  // Re-scheduling the exact same failing snapshot does not loop.
  saver.schedule("bad", "bad", "immediate");
  await tick();
  assert.equal(calls.length, 1);

  // Explicit retry succeeds once server recovers.
  shouldFail = false;
  saver.retry();
  await tick();
  await tick();
  assert.deepEqual(calls, ["bad", "bad"]);
  assert.equal(saver.getState().error, null);
});

test("flushes pending debounced edits on dispose and ignores invalid cancels", async () => {
  const calls: string[] = [];
  const saver = createAutoSaver<string, string>({
    initialSignature: "init",
    debounceMs: 500,
    save: async (value) => {
      calls.push(value);
      return value;
    },
  });

  saver.schedule("typing", "typing", "debounced");
  saver.cancelPending();
  assert.equal(saver.getState().pending, false);

  saver.schedule("final", "final", "debounced");
  saver.dispose();
  await tick();
  await tick();
  assert.deepEqual(calls, ["final"]);
});

test("survives React StrictMode mount -> dispose -> mount cycle and recovers after external syncSaved", async () => {
  const calls: string[] = [];
  const saver = createAutoSaver<string, string>({
    initialSignature: "v0",
    debounceMs: 20,
    save: async (value) => {
      calls.push(value);
      return value;
    },
  });

  // StrictMode simulated double-mount
  saver.mount();
  saver.dispose();
  saver.mount();

  saver.schedule("v1", "v1", "immediate");
  await tick();
  await tick();
  assert.deepEqual(calls, ["v1"]);

  // External update moves server to v2; scheduling v2 again is a no-op.
  saver.syncSaved("v2");
  saver.schedule("v2", "v2", "immediate");
  await tick();
  assert.deepEqual(calls, ["v1"]);
});

test("waits for debounce window even if an earlier in-flight save finishes sooner", async () => {
  const calls: string[] = [];
  const first = deferred<string>();
  const saver = createAutoSaver<string, string>({
    initialSignature: "v0",
    debounceMs: 40,
    save: (value) => {
      calls.push(value);
      return calls.length === 1 ? first.promise : Promise.resolve(value);
    },
  });

  saver.schedule("v1", "v1", "immediate");
  await tick();
  assert.deepEqual(calls, ["v1"]);

  // Debounced edit arrives while v1 is in flight.
  saver.schedule("v2", "v2", "debounced");
  first.resolve("v1");
  await tick();
  await tick();
  // Should NOT fire v2 yet because debounce window hasn't elapsed.
  assert.deepEqual(calls, ["v1"]);

  // Further typing coalesces into v3 before timer expires.
  saver.schedule("v3", "v3", "debounced");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, ["v1", "v3"]);
});
