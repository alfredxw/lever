import assert from "node:assert/strict";
import test from "node:test";
import type { TFunction } from "i18next";
import { displayChatTitle } from "../src/features/chat/conversationTitle.ts";

const t = ((key: string) =>
  ({
    "workspace.newChat": "新对话",
    "tasks.workItemsChat": "工作项",
  })[key] ?? key) as unknown as TFunction;

test("displayChatTitle localizes default user and workItem Chats while keeping custom names", () => {
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
