import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  clearComposerDraft,
  clearSubmission,
  conversationDraftKey,
  formatDraftPreview,
  hasStoredComposerInput,
  readComposerDraftSummary,
  saveComposerDraft,
  saveSubmission,
  syncAllComposerDrafts,
  type Draft,
} from "../src/features/chat/composerDraft.ts";
import { textPrompt } from "../src/features/chat/prompt.ts";

class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  get length() {
    return this.entries.size;
  }
  clear() {
    this.entries.clear();
  }
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.entries.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
  setItem(key: string, value: string) {
    this.entries.set(key, String(value));
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});

function emptyDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    content: textPrompt(""),
    topic: true,
    files: [],
    quote: null,
    ...overrides,
  };
}

beforeEach(() => {
  storage.clear();
  syncAllComposerDrafts();
});

test("conversationDraftKey maps main conversations to chatId and topics to session id", () => {
  assert.equal(
    conversationDraftKey({ id: "sess-main", chatId: "chat-1", kind: "main" }),
    "chat-1",
  );
  assert.equal(
    conversationDraftKey({ id: "sess-topic", chatId: "chat-1", kind: "topic" }),
    "sess-topic",
  );
});

test("empty and metadata-only drafts are ignored while real input is summarized", () => {
  saveComposerDraft(
    "chat-empty",
    emptyDraft({
      content: textPrompt("   \n\t  "),
      topic: true,
      sessionSelection: {
        provider: "codex",
        model: "gpt-5",
        effort: "high",
        fast: false,
      },
    }),
  );
  assert.equal(hasStoredComposerInput("chat-empty"), false);
  assert.equal(readComposerDraftSummary("chat-empty"), null);

  saveComposerDraft(
    "chat-text",
    emptyDraft({ content: textPrompt("继续排查\n  内存泄漏问题") }),
  );
  assert.equal(hasStoredComposerInput("chat-text"), true);
  const first = readComposerDraftSummary("chat-text");
  assert.deepEqual(first, {
    text: "继续排查 内存泄漏问题",
    fileCount: 0,
    firstFileName: undefined,
    hasQuote: false,
    quoteText: undefined,
    editing: false,
    pending: false,
  });

  // Changing model metadata without changing draft content preserves summary reference.
  saveComposerDraft(
    "chat-text",
    emptyDraft({
      content: textPrompt("继续排查\n  内存泄漏问题"),
      sessionSelection: {
        provider: "claude",
        model: "sonnet",
        effort: "",
        fast: false,
      },
    }),
  );
  assert.equal(readComposerDraftSummary("chat-text"), first);
});

test("detects references, attachments, quotes, edits, legacy drafts, and pending submissions", () => {
  saveComposerDraft(
    "ref-only",
    emptyDraft({
      content: textPrompt("", [
        { kind: "file", name: "src/App.tsx", path: "/repo/src/App.tsx" },
      ]),
    }),
  );
  assert.equal(readComposerDraftSummary("ref-only")?.text, "@src/App.tsx");

  saveComposerDraft(
    "files-only",
    emptyDraft({
      files: [
        {
          id: "att-1",
          name: "screenshot.png",
          mediaType: "image/png",
          size: 1200,
        },
      ],
    }),
  );
  assert.equal(readComposerDraftSummary("files-only")?.fileCount, 1);
  assert.equal(
    readComposerDraftSummary("files-only")?.firstFileName,
    "screenshot.png",
  );

  saveComposerDraft(
    "quote-only",
    emptyDraft({
      quote: {
        role: "assistant",
        text: "Earlier explanation",
        sessionId: "sess-1",
        runId: "run-1",
      },
    }),
  );
  assert.equal(readComposerDraftSummary("quote-only")?.hasQuote, true);
  assert.equal(
    readComposerDraftSummary("quote-only")?.quoteText,
    "Earlier explanation",
  );

  saveComposerDraft(
    "edit-only",
    emptyDraft({
      editing: { runId: "run-2", previous: emptyDraft(), sent: true },
    }),
  );
  assert.equal(readComposerDraftSummary("edit-only")?.editing, true);

  storage.setItem("lever:draft:legacy-1", "旧草稿");
  assert.equal(readComposerDraftSummary("legacy-1")?.text, "旧草稿");

  saveSubmission("pending-1", {
    commandId: "cmd-1",
    chatId: "pending-1",
    operation: "main",
    text: "待重试消息",
    attachmentIds: [],
    selection: { provider: "codex", model: "gpt-5", effort: "", fast: false },
  });
  assert.equal(readComposerDraftSummary("pending-1")?.pending, true);
  assert.equal(readComposerDraftSummary("pending-1")?.text, "待重试消息");
  clearSubmission("pending-1");
  assert.equal(readComposerDraftSummary("pending-1"), null);
});

test("clearComposerDraft clears unsent input and preserves explicit model selections", () => {
  const selection = {
    provider: "codex",
    model: "gpt-5",
    effort: "medium",
    fast: false,
  };
  saveComposerDraft(
    "chat-sel",
    emptyDraft({
      content: textPrompt("半截草稿"),
      sessionSelection: selection,
      editing: {
        runId: "run-1",
        previous: emptyDraft({ content: textPrompt("old") }),
      },
    }),
  );
  saveSubmission("chat-sel", {
    commandId: "cmd-2",
    chatId: "chat-sel",
    operation: "main",
    text: "半截草稿",
    attachmentIds: [],
    selection,
  });
  assert.equal(hasStoredComposerInput("chat-sel"), true);

  clearComposerDraft("chat-sel");
  assert.equal(hasStoredComposerInput("chat-sel"), false);
  assert.equal(storage.getItem("lever:submission:chat-sel"), null);
  const kept = JSON.parse(storage.getItem("lever:composer:chat-sel") ?? "null");
  assert.deepEqual(kept?.sessionSelection, selection);
  assert.equal(kept?.editing, undefined);

  saveComposerDraft(
    "draft:agent-1",
    emptyDraft({ content: textPrompt("新对话草稿") }),
  );
  clearComposerDraft("draft:agent-1");
  assert.equal(hasStoredComposerInput("draft:agent-1"), false);
  assert.equal(storage.getItem("lever:composer:draft:agent-1"), null);

  saveComposerDraft(
    "chat-continuous",
    emptyDraft({ content: textPrompt("连续对话草稿"), topic: false }),
  );
  clearComposerDraft("chat-continuous");
  assert.equal(hasStoredComposerInput("chat-continuous"), false);
  const keptMode = JSON.parse(
    storage.getItem("lever:composer:chat-continuous") ?? "null",
  );
  assert.equal(keptMode?.topic, false);
});

test("formatDraftPreview falls back cleanly across draft content kinds", () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key}:${JSON.stringify(options ?? {})}`;
  assert.equal(
    formatDraftPreview(
      {
        text: "实际正文",
        fileCount: 2,
        firstFileName: "a.png",
        hasQuote: true,
        quoteText: "引用",
        editing: true,
        pending: false,
      },
      t,
    ),
    "实际正文",
  );
  assert.equal(
    formatDraftPreview(
      {
        text: "",
        fileCount: 1,
        firstFileName: "a.png",
        hasQuote: false,
        editing: false,
        pending: false,
      },
      t,
    ),
    'agents.draftAttachment:{"name":"a.png"}',
  );
  assert.equal(
    formatDraftPreview(
      {
        text: "",
        fileCount: 3,
        firstFileName: "a.png",
        hasQuote: false,
        editing: false,
        pending: false,
      },
      t,
    ),
    'agents.draftAttachments:{"count":3}',
  );
  assert.equal(
    formatDraftPreview(
      {
        text: "",
        fileCount: 0,
        hasQuote: true,
        quoteText: "被引用内容",
        editing: false,
        pending: false,
      },
      t,
    ),
    "被引用内容",
  );
  assert.equal(
    formatDraftPreview(
      {
        text: "",
        fileCount: 0,
        hasQuote: false,
        editing: true,
        pending: false,
      },
      t,
    ),
    "agents.draftEditing:{}",
  );
});
