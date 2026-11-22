import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultWaitRunIds,
  dependencyProgress,
  listWaitableRuns,
  sharesDirectory,
} from "../src/features/chat/waitRuns.ts";
import type { Agent, Overview, Run, Scope } from "../src/api/types.gen.ts";

function makeAgent(id: string, name: string, path: string): Agent {
  return {
    id,
    name,
    archived: false,
    createdAt: "",
    updatedAt: "",
    profile: {
      roots: [{ id: `root-${id}`, path }],
      primaryRootId: `root-${id}`,
      instructions: "",
      provider: "codex",
      model: "",
      permission: "ask",
      skills: [],
      delegations: [],
    },
  };
}

function makeRun(overrides: Partial<Run> & Pick<Run, "id" | "sessionId" | "chatId" | "agentId" | "status" | "sequence">): Run {
  return {
    input: "",
    selection: { provider: "codex", model: "", effort: "", fast: false },
    attachments: [],
    handoff: false,
    items: [],
    createdAt: "",
    ...overrides,
  };
}

test("sharesDirectory matches exact roots and subpaths without matching sibling worktrees", () => {
  assert.equal(sharesDirectory(["/code/lever"], ["/code/lever/"]), true);
  assert.equal(sharesDirectory(["/code/lever"], ["/code/lever/web"]), true);
  assert.equal(sharesDirectory(["/code/lever/web"], ["/code/lever"]), true);
  assert.equal(sharesDirectory(["/code/lever"], ["/code/lever-wt1"]), false);
  assert.equal(sharesDirectory(["/code/lever"], ["/code/other"]), false);
  assert.equal(
    sharesDirectory(["C:\\Work\\Repo\\"], ["c:/work/repo/pkg"]),
    true,
  );
});

test("listWaitableRuns and defaultWaitRunIds preselect only same-directory active runs", () => {
  const scope: Scope = {
    roots: [{ id: "r1", path: "/repo/lever" }],
    primaryRootId: "r1",
  };
  const overview: Pick<Overview, "agents" | "chats" | "conversations" | "runs"> = {
    agents: [
      makeAgent("a1", "Coder", "/repo/lever"),
      makeAgent("a2", "Reviewer", "/repo/lever"),
      makeAgent("a3", "Other", "/repo/other"),
    ],
    chats: [
      { id: "c1", agentId: "a1", title: "Main", source: "user", createdAt: "", updatedAt: "" },
      { id: "c2", agentId: "a2", title: "Review", source: "user", createdAt: "", updatedAt: "" },
      { id: "c3", agentId: "a3", title: "Other Chat", source: "user", createdAt: "", updatedAt: "" },
    ],
    conversations: [
      { id: "s1", chatId: "c1", agentId: "a1", kind: "topic", title: "Fix auth", preview: "", messageAt: "", unreadSequence: 0 },
      { id: "s2", chatId: "c2", agentId: "a2", kind: "topic", title: "Add tests", preview: "", messageAt: "", unreadSequence: 0 },
    ],
    runs: [
      makeRun({ id: "r-other", sessionId: "s3", chatId: "c3", agentId: "a3", status: "running", sequence: 1, input: "other repo", scopePaths: ["/repo/other"] }),
      makeRun({ id: "r-wt", sessionId: "s-wt", chatId: "c1", agentId: "a1", status: "running", sequence: 2, input: "worktree task", scopePaths: ["/repo/lever-wt1"] }),
      makeRun({ id: "r-same-1", sessionId: "s1", chatId: "c1", agentId: "a1", status: "running", sequence: 3, input: "fix auth", scopePaths: ["/repo/lever"] }),
      makeRun({ id: "r-same-2", sessionId: "s2", chatId: "c2", agentId: "a2", status: "waiting_user", sequence: 4, input: "add tests", scopePaths: ["/repo/lever"] }),
      makeRun({ id: "r-same-queued", sessionId: "s4", chatId: "c1", agentId: "a1", status: "queued", sequence: 5, input: "later", scopePaths: ["/repo/lever"] }),
      makeRun({ id: "r-quiet", sessionId: "s5", chatId: "c1", agentId: "a1", status: "running", sequence: 6, quiet: true, scopePaths: ["/repo/lever"] }),
      makeRun({ id: "r-unknown", sessionId: "s6", chatId: "c1", agentId: "a1", status: "unknown", sequence: 7, scopePaths: ["/repo/lever"] }),
    ],
  };

  const candidates = listWaitableRuns(overview, scope);
  assert.deepEqual(
    candidates.map((item) => ({ id: item.run.id, sameScope: item.sameScope, title: item.title })),
    [
      { id: "r-same-1", sameScope: true, title: "Fix auth" },
      { id: "r-same-2", sameScope: true, title: "Add tests" },
      { id: "r-same-queued", sameScope: true, title: "later" },
      { id: "r-other", sameScope: false, title: "other repo" },
      { id: "r-wt", sameScope: false, title: "worktree task" },
    ],
  );
  assert.deepEqual(defaultWaitRunIds(candidates), ["r-same-1", "r-same-2"]);

  // Excluding current session and editing run works cleanly.
  const filtered = listWaitableRuns(overview, scope, {
    excludeSessionId: "s1",
    excludeRunId: "r-same-queued",
  });
  assert.deepEqual(
    filtered.map((item) => item.run.id),
    ["r-same-2", "r-other", "r-wt"],
  );
});

test("dependencyProgress counts completed, blocked, and pending dependencies", () => {
  assert.deepEqual(
    dependencyProgress([
      { runId: "1", sessionId: "s1", chatId: "c1", agentId: "a1", title: "A", status: "completed" },
      { runId: "2", sessionId: "s2", chatId: "c1", agentId: "a1", title: "B", status: "running" },
      { runId: "3", sessionId: "s3", chatId: "c1", agentId: "a1", title: "C", status: "failed" },
    ]),
    { total: 3, completed: 1, blocked: 1, pending: 1 },
  );
});
