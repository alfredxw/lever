import assert from "node:assert/strict";
import test from "node:test";
import {
  companionPane,
  defaultOpenPane,
  locateChatPane,
  primaryTabPane,
  resolveTopicPanes,
  type PaneTab,
} from "../src/components/workbench/workspacePanes.ts";

test("defaultOpenPane fills an empty main pane even when activePane is side", () => {
  const onlySide: PaneTab[] = [{ id: "topic:t1", pane: "side" }];
  assert.equal(defaultOpenPane(onlySide, "side", "chat-1"), "main");
  assert.equal(defaultOpenPane(onlySide, "side", "files"), "main");
  // Existing side tab stays in side; explicit side requests stay in side.
  assert.equal(defaultOpenPane(onlySide, "side", "topic:t1"), "side");
  assert.equal(defaultOpenPane(onlySide, "side", "draft", "side"), "side");

  // Once main has tabs, unspecified opens still follow activePane.
  const split: PaneTab[] = [
    { id: "chat-1", pane: "main" },
    { id: "files", pane: "side" },
  ];
  assert.equal(defaultOpenPane(split, "side", "files:a"), "side");
  assert.equal(defaultOpenPane(split, "main", "files:a"), "main");
  assert.equal(defaultOpenPane(split, "side", "chat-1"), "main");
});

test("primaryTabPane keeps open Chats in place and opens new Chats in main", () => {
  const split: PaneTab[] = [
    { id: "chat-1", pane: "main" },
    { id: "topic:t1", pane: "side" },
  ];
  assert.equal(primaryTabPane(split, "chat-2"), "main");
  assert.equal(primaryTabPane(split, "chat-2", "side"), "side");

  const movedChat: PaneTab[] = [{ id: "chat-1", pane: "side" }];
  assert.equal(primaryTabPane(movedChat, "chat-1"), "side");
  assert.equal(primaryTabPane(movedChat, "chat-2"), "main");
});

test("companionPane opens opposite the originating pane or fills an empty main pane", () => {
  const split: PaneTab[] = [
    { id: "chat-1", pane: "main" },
    { id: "topic:t1", pane: "side" },
  ];
  assert.equal(companionPane(split, "main"), "side");
  assert.equal(companionPane(split, "side"), "main");
  assert.equal(companionPane(split), "side");
  assert.equal(companionPane([{ id: "topic:t1", pane: "side" }]), "main");
  assert.equal(companionPane([]), "main");
});

test("resolveTopicPanes separates colliding Chat and Topic tabs when revealing in Chat", () => {
  // Canonical closed or normal split cases.
  assert.deepEqual(
    resolveTopicPanes({
      tabs: [],
      chatId: "chat-1",
      topicTabId: "topic:t1",
      revealInChat: true,
    }),
    { chatPane: "main", topicPane: "side" },
  );
  assert.deepEqual(
    resolveTopicPanes({
      tabs: [{ id: "chat-1", pane: "main" }],
      chatId: "chat-1",
      topicTabId: "topic:t1",
      revealInChat: true,
    }),
    { chatPane: "main", topicPane: "side" },
  );

  // Colliding in side or main separates them into main (Chat) + side (Topic).
  assert.deepEqual(
    resolveTopicPanes({
      tabs: [
        { id: "chat-1", pane: "side" },
        { id: "topic:t1", pane: "side" },
      ],
      chatId: "chat-1",
      topicTabId: "topic:t1",
      revealInChat: true,
    }),
    { chatPane: "main", topicPane: "side" },
  );
  assert.deepEqual(
    resolveTopicPanes({
      tabs: [
        { id: "chat-1", pane: "main" },
        { id: "topic:t1", pane: "main" },
      ],
      chatId: "chat-1",
      topicTabId: "topic:t1",
      revealInChat: true,
    }),
    { chatPane: "main", topicPane: "side" },
  );

  // Already in opposite panes preserves their homes.
  assert.deepEqual(
    resolveTopicPanes({
      tabs: [
        { id: "chat-1", pane: "side" },
        { id: "topic:t1", pane: "main" },
      ],
      chatId: "chat-1",
      topicTabId: "topic:t1",
      revealInChat: true,
    }),
    { chatPane: "side", topicPane: "main" },
  );

  // Without revealInChat, clicking an already-moved Topic keeps its pane.
  assert.deepEqual(
    resolveTopicPanes({
      tabs: [
        { id: "chat-1", pane: "main" },
        { id: "topic:t1", pane: "main" },
      ],
      chatId: "chat-1",
      topicTabId: "topic:t1",
      revealInChat: false,
    }),
    { chatPane: undefined, topicPane: "main" },
  );
});

test("locateChatPane opens parent Chat opposite an open source Topic or in main", () => {
  assert.equal(
    locateChatPane({
      tabs: [{ id: "topic:t1", pane: "side" }],
      chatId: "chat-1",
      sourceTopicTabId: "topic:t1",
    }),
    "main",
  );
  assert.equal(
    locateChatPane({
      tabs: [{ id: "topic:t1", pane: "main" }],
      chatId: "chat-1",
      sourceTopicTabId: "topic:t1",
    }),
    "side",
  );
  // Colliding parent Chat in the same pane moves to the opposite pane.
  assert.equal(
    locateChatPane({
      tabs: [
        { id: "topic:t1", pane: "side" },
        { id: "chat-1", pane: "side" },
      ],
      chatId: "chat-1",
      sourceTopicTabId: "topic:t1",
    }),
    "main",
  );
  // Without an open source Topic, default to main even if another side tab exists.
  assert.equal(
    locateChatPane({
      tabs: [{ id: "topic:other", pane: "side" }],
      chatId: "chat-1",
      sourceTopicTabId: "topic:t1",
    }),
    "main",
  );
});
