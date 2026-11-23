import assert from "node:assert/strict";
import test from "node:test";
import type { TFunction } from "i18next";
import {
  displayChatTitle,
  formatChannelOrigin,
} from "../src/features/chat/conversationTitle.ts";

const t = ((key: string) =>
  ({
    "workspace.newChat": "新对话",
    "tasks.worksChat": "工作",
    "tasks.workItemsChat": "工作项",
    "personal.sourceDm": "私聊",
    "personal.sourceGroup": "群聊",
  })[key] ?? key) as unknown as TFunction;

test("displayChatTitle localizes default user, works, and workItem Chats while keeping custom names", () => {
  assert.equal(
    displayChatTitle({ source: "user", title: "New chat" }, t),
    "新对话",
  );
  assert.equal(
    displayChatTitle(
      { source: "user", title: "New chat", titleIsCustom: true },
      t,
    ),
    "New chat",
  );
  assert.equal(
    displayChatTitle({ source: "works", title: "Works" }, t),
    "工作",
  );
  assert.equal(
    displayChatTitle(
      { source: "works", title: "Works", titleIsCustom: true },
      t,
    ),
    "Works",
  );
  assert.equal(
    displayChatTitle(
      { source: "works", title: "日常任务", titleIsCustom: true },
      t,
    ),
    "日常任务",
  );
  assert.equal(
    displayChatTitle({ source: "workItem", title: "Work items" }, t),
    "工作项",
  );
  assert.equal(
    displayChatTitle(
      { source: "workItem", title: "Work items", titleIsCustom: true },
      t,
    ),
    "Work items",
  );
  assert.equal(
    displayChatTitle(
      { source: "workItem", title: "我的待办", titleIsCustom: true },
      t,
    ),
    "我的待办",
  );
  assert.equal(
    displayChatTitle({ source: "taskSource", title: "example/alpha" }, t),
    "example/alpha",
  );
});

test("formatChannelOrigin formats named and unnamed group and DM sources", () => {
  assert.equal(formatChannelOrigin(undefined, t), "");
  assert.equal(
    formatChannelOrigin(
      {
        channel: "larkx",
        chatId: "300",
        chatName: "研发群",
        kind: "group",
        command: "/ai",
      },
      t,
    ),
    "研发群 · /ai",
  );
  assert.equal(
    formatChannelOrigin(
      {
        channel: "larkx",
        chatId: "400",
        chatName: "张三",
        kind: "dm",
        command: "/ai",
      },
      t,
    ),
    "私聊 · 张三 · /ai",
  );
  assert.equal(
    formatChannelOrigin(
      { channel: "larkx", chatId: "300", kind: "group", command: "/审查" },
      t,
    ),
    "群聊 · 300 · /审查",
  );
  assert.equal(
    formatChannelOrigin({ channel: "larkx", chatId: "400", kind: "dm" }, t),
    "私聊 · 400",
  );
});
