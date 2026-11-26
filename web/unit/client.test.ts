import assert from "node:assert/strict";
import { test } from "node:test";
import { connectEvents, queryClient } from "../src/api/client.ts";
import { observeAgentNotifications } from "../src/features/agents/desktopNotifications.ts";
import type {
  Event,
  Overview,
  Run,
  SessionRuns,
} from "../src/api/types.gen.ts";

function mockRunStream() {
  const originalEventSource = globalThis.EventSource;
  let receive: ((message: { data: string }) => void) | undefined;
  class Stream {
    set onmessage(callback: typeof receive) {
      receive = callback;
    }
    addEventListener() {}
    close() {}
  }
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  const close = connectEvents(1);
  return {
    send(event: Event) {
      receive!({ data: JSON.stringify(event) });
    },
    close() {
      close();
      queryClient.clear();
      globalThis.EventSource = originalEventSource;
    },
  };
}

const run: Run = {
  id: "run",
  agentId: "agent",
  chatId: "chat",
  sessionId: "session",
  sequence: 1,
  input: "Latest request",
  status: "running",
  createdAt: "2026-11-06T00:00:00Z",
  selection: { provider: "codex", model: "", effort: "", fast: false },
  attachments: [],
  items: [],
  handoff: false,
};

test("quiet successes suppress desktop alerts while attention and foreground results are delivered once", () => {
  const kinds: string[] = [];
  const observe = observeAgentNotifications((notice) =>
    kinds.push(notice.kind),
  );
  const conversation = {
    id: "session",
    chatId: "chat",
    agentId: "agent",
    kind: "main",
    title: "Chat",
    messageAt: "",
    unreadSequence: 0,
  };
  function result(id: string, status: string, quiet: boolean) {
    observe({
      sequence: 1,
      type: "run",
      conversation,
      run: { ...run, id, status, quiet },
    });
  }
  result("routine", "completed", true);
  result("problem", "unknown", true);
  result("problem", "failed", true);
  result("problem", "failed", true);
  result("manual", "completed", false);
  observe({
    sequence: 2,
    type: "request",
    conversation,
    request: {
      id: "ask",
      runId: "routine",
      chatId: "chat",
      sessionId: "session",
      status: "pending",
      kind: "input",
      title: "Input",
      detail: "",
      questions: [],
    },
  });
  assert.deepEqual(kinds, ["unknown", "failed", "completed", "input"]);
});

test("a completion keeps its sidebar result when an older overview fetch is cancelled", async () => {
  const stream = mockRunStream();
  const overview: Overview = {
    cursor: 1,
    agents: [],
    chats: [
      {
        id: "chat",
        agentId: "agent",
        title: "First request",
        source: "user",
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
      },
    ],
    conversations: [
      {
        id: run.sessionId,
        chatId: run.chatId,
        agentId: run.agentId,
        kind: "main",
        title: "First request",
        preview: run.input,
        messageAt: run.createdAt,
        unreadSequence: 0,
      },
    ],
    runs: [run],
    requests: [],
    dataDir: "",
    deviceId: "local",
    deviceName: "",
    platform: "",
  };
  queryClient.setQueryData(["overview"], overview);
  try {
    let resolveSnapshot!: (value: Overview) => void;
    const pending = queryClient
      .fetchQuery({
        queryKey: ["overview"],
        staleTime: 0,
        queryFn: () =>
          new Promise<Overview>((resolve) => {
            resolveSnapshot = resolve;
          }),
      })
      .catch(() => undefined);
    const event: Event = {
      type: "run",
      sequence: 2,
      chatId: run.chatId,
      run: { ...run, status: "completed", finishedAt: "2026-11-06T00:00:01Z" },
      conversation: {
        ...overview.conversations[0],
        preview: "Latest reply",
        messageAt: "2026-11-06T00:00:01Z",
        unreadSequence: 2,
      },
    };
    stream.send(event);
    resolveSnapshot(overview);
    await pending;
    const current = queryClient.getQueryData<Overview>(["overview"])!;
    assert.deepEqual(current.conversations[0], event.conversation);
    assert.deepEqual(current.runs, []);
  } finally {
    stream.close();
  }
});

test("a streamed run updates its loaded page and leaves unseen history invalidated", async () => {
  const stream = mockRunStream();
  const key = ["session", run.sessionId];
  const older = { runs: [{ ...run, id: "older" }], cursor: 1 };
  const history = {
    pages: [{ runs: [run], cursor: 2 }, older],
    pageParams: [0, 2],
  };
  queryClient.setQueryData(key, history);
  try {
    const changed = {
      ...run,
      items: [
        {
          id: "answer",
          kind: "text",
          text: "Streaming",
          title: "",
          status: "running",
        },
      ],
    };
    stream.send({ type: "run", sequence: 3, run: changed });
    const updated = queryClient.getQueryData<{ pages: SessionRuns[] }>(key)!;
    assert.deepEqual(updated.pages[0].runs, [changed]);
    assert.equal(updated.pages[1], older);
    await queryClient.invalidateQueries({ queryKey: key, refetchType: "none" });
    stream.send({ type: "run", sequence: 4, run: { ...run, id: "new" } });
    assert.equal(queryClient.getQueryData(key), updated);
    assert.equal(queryClient.getQueryState(key)?.isInvalidated, true);
  } finally {
    stream.close();
  }
});

test("provider-usage events invalidate usage queries independently of providers and overview", () => {
  const stream = mockRunStream();
  queryClient.setQueryData(["overview"], { cursor: 1 });
  queryClient.setQueryData(["providers"], []);
  queryClient.setQueryData(["provider-usage", "codex"], { windows: [] });
  try {
    stream.send({ type: "providers", sequence: 2 });
    assert.equal(
      queryClient.getQueryState(["providers"])?.isInvalidated,
      true,
    );
    assert.equal(
      queryClient.getQueryState(["provider-usage", "codex"])?.isInvalidated,
      false,
    );

    queryClient.setQueryData(["overview"], { cursor: 2 });
    stream.send({ type: "provider-usage", sequence: 3 });
    assert.equal(
      queryClient.getQueryState(["provider-usage", "codex"])?.isInvalidated,
      true,
    );
    assert.equal(
      queryClient.getQueryState(["overview"])?.isInvalidated,
      false,
    );
  } finally {
    stream.close();
  }
});
