import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "@/api/types.gen";
import {
  deriveLiveActivity,
  formatToolTarget,
  liveThoughtLine,
  shouldAutoExpandThinking,
  thoughtSummary,
} from "../src/features/chat/runActivityLogic.ts";

function item(overrides: Partial<Item> & Pick<Item, "id" | "kind">): Item {
  return {
    title: "",
    text: "",
    status: "completed",
    ...overrides,
  };
}

test("liveThoughtLine extracts headings, latest sections, and CJK/English sentences", () => {
  assert.equal(
    liveThoughtLine(
      'Found the cause: the repo has no commits, so `git worktree add` fails with "invalid reference: main." Now checking the UI.',
    ),
    'Found the cause: the repo has no commits, so git worktree add fails with "invalid reference: main."',
  );
  assert.equal(
    liveThoughtLine("I read ThreadLaunchService.ts — it skips the fetch. Next step."),
    "I read ThreadLaunchService.ts — it skips the fetch.",
  );
  assert.equal(
    liveThoughtLine("**Narrowing dispatch files**\n\nI should check the adapter. Then more."),
    "Narrowing dispatch files",
  );
  assert.equal(
    liveThoughtLine(
      "**Inspecting ACP adapter**\n\nChecking acp.go.\n\n**Designing live thinking row**\n\nUpdating RunActivity.",
    ),
    "Designing live thinking row",
  );
  assert.equal(
    liveThoughtLine(
      "先检查 acp.go 的解析逻辑。\n\n已经定位到问题：RunActivity 只展示单行截断。下一步调整展示逻辑。",
    ),
    "已经定位到问题：RunActivity 只展示单行截断。",
  );
  assert.equal(
    liveThoughtLine("- Checking [the docs](https://x.dev) for **limits**"),
    "Checking the docs for limits",
  );
  assert.equal(
    liveThoughtLine("This is *really* ~~not~~ _fine_ in snake_case_names."),
    "This is really not fine in snake_case_names.",
  );
  assert.equal(liveThoughtLine("   "), "");
});

test("thoughtSummary keeps opening heading or first sentence for settled entries", () => {
  assert.equal(
    thoughtSummary("**Inspecting ACP**\n\nDetails.\n\n**Second step**\n\nMore."),
    "Inspecting ACP",
  );
  assert.equal(
    thoughtSummary("Review the **input**.\n\nCompare the results."),
    "Review the input.",
  );
});

test("formatToolTarget drops generic tool names and preserves concrete targets", () => {
  assert.equal(formatToolTarget({ title: "Read" }, "read"), "");
  assert.equal(formatToolTarget({ title: "Running view_file" }, "read"), "");
  assert.equal(
    formatToolTarget({ title: "internal/provider/acp.go" }, "read"),
    "internal/provider/acp.go",
  );
  assert.equal(
    formatToolTarget({ title: "rg Greeting\n--hidden" }, "search"),
    "rg Greeting",
  );
  assert.equal(
    formatToolTarget({ title: "Inspect workspace" }, "other"),
    "Inspect workspace",
  );
  assert.equal(
    formatToolTarget({ title: "Running html_render" }, "other"),
    "html_render",
  );
  assert.equal(
    formatToolTarget({ title: "Run mcp_example_html_render" }, "other"),
    "mcp_example_html_render",
  );
  assert.equal(formatToolTarget({ title: "Tool call" }, "other"), "");
});

test("shouldAutoExpandThinking only opens Antigravity during pure streaming thought", () => {
  const streamingThought = item({
    id: "r1",
    kind: "reasoning",
    text: "Inspecting files...",
    status: "running",
  });
  const doneThought = { ...streamingThought, status: "completed" };
  const secondStreamingThought = item({
    id: "r2",
    kind: "reasoning",
    text: "Checking edge cases...",
    status: "running",
  });
  const runningTool = item({
    id: "t1",
    kind: "tool",
    title: "internal/provider/acp.go",
    toolAction: "read",
    status: "running",
  });

  assert.equal(
    shouldAutoExpandThinking([streamingThought], {
      autoExpandThinking: true,
      live: true,
      runStatus: "running",
    }),
    true,
  );
  assert.equal(
    shouldAutoExpandThinking([doneThought, secondStreamingThought], {
      autoExpandThinking: true,
      live: true,
      runStatus: "running",
    }),
    true,
  );
  // Codex / non-Antigravity never auto-expands.
  assert.equal(
    shouldAutoExpandThinking([streamingThought], {
      autoExpandThinking: false,
      live: true,
      runStatus: "running",
    }),
    false,
  );
  // Once a tool appears, pure thinking has ended.
  assert.equal(
    shouldAutoExpandThinking([doneThought, runningTool], {
      autoExpandThinking: true,
      live: true,
      runStatus: "running",
    }),
    false,
  );
  // Once reasoning finishes (e.g. launching a subagent or waiting for answer), collapse.
  assert.equal(
    shouldAutoExpandThinking([doneThought], {
      autoExpandThinking: true,
      live: true,
      runStatus: "running",
    }),
    false,
  );
  // Settled / waiting_user never auto-expands.
  assert.equal(
    shouldAutoExpandThinking([streamingThought], {
      autoExpandThinking: true,
      live: false,
      runStatus: "completed",
    }),
    false,
  );
  assert.equal(
    shouldAutoExpandThinking([streamingThought], {
      autoExpandThinking: true,
      live: true,
      runStatus: "waiting_user",
    }),
    false,
  );
});

test("deriveLiveActivity tracks single-line tool, post-tool gap, thinking, and subagent states", () => {
  const thought1 = item({
    id: "r1",
    kind: "reasoning",
    text: "First idea.",
    status: "completed",
  });
  const runningThought = item({
    id: "r2",
    kind: "reasoning",
    text: "**Checking RunActivity**\n\nInspecting layout.",
    status: "running",
  });
  const runningSearch = item({
    id: "t1",
    kind: "tool",
    title: "rg Greeting",
    toolAction: "search",
    status: "running",
  });

  // Active streaming thought provides thoughtLine for collapsed single-line trigger.
  const thinking = deriveLiveActivity([thought1, runningThought], {
    live: true,
    runStatus: "running",
  });
  assert.equal(thinking.mode, "thinking");
  assert.equal(thinking.running, true);
  assert.equal(thinking.thoughtLine, "Checking RunActivity");

  // Active tool takes over the single-line status cleanly.
  const duringTool = deriveLiveActivity([thought1, runningSearch], {
    live: true,
    runStatus: "running",
  });
  assert.equal(duringTool.mode, "active_tool");
  assert.equal(duringTool.running, true);
  assert.equal(duringTool.liveTool?.id, "t1");
  assert.equal(duringTool.thoughtLine, "");

  // Completed tool stays live during the gap before the next step instead of flashing back.
  const doneSearch = { ...runningSearch, status: "completed" };
  const afterTool = deriveLiveActivity([thought1, doneSearch], {
    live: true,
    runStatus: "running",
  });
  assert.equal(afterTool.mode, "completed_tool_live");
  assert.equal(afterTool.running, true);
  assert.equal(afterTool.liveTool?.id, "t1");

  // Failed tool falls back to thinking while the run continues.
  const failedTool = item({
    id: "t2",
    kind: "tool",
    title: "go test",
    toolAction: "command",
    status: "failed",
  });
  const afterFailure = deriveLiveActivity([thought1, failedTool], {
    live: true,
    runStatus: "running",
  });
  assert.equal(afterFailure.mode, "thinking");
  assert.equal(afterFailure.thoughtLine, "");

  // Waiting on running subagents surfaces subagent wait.
  const waitingSubagents = deriveLiveActivity([], {
    live: true,
    runStatus: "running",
    runningSubagents: 2,
  });
  assert.equal(waitingSubagents.mode, "waiting_subagents");
  assert.equal(waitingSubagents.running, true);

  // Settled state clears running flags.
  const settled = deriveLiveActivity([thought1, doneSearch], {
    live: false,
    runStatus: "completed",
  });
  assert.equal(settled.mode, "settled");
  assert.equal(settled.running, false);
  assert.equal(settled.thoughtLine, "");
});
