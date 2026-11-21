import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchComposerTrigger,
  rankMentionGroups,
  searchComposerOptions,
} from "../src/features/chat/composerSearch.ts";

test("an exact note title is selected before tasks mentioning that note", () => {
  const board = {
    options: [
      { id: "card", name: "Verify callback", description: "Review decisions" },
    ],
  };
  const notes = {
    options: [{ id: "note", name: "Review decisions", description: "" }],
  };
  assert.deepEqual(rankMentionGroups([board, notes], "Review decisions"), [
    notes,
    board,
  ]);
  assert.deepEqual(rankMentionGroups([board, notes], ""), [board, notes]);
});

function skill(name: string, description = "") {
  return { id: `skill:${name}`, name: `/${name}`, description };
}

test("slash search ranks names, descriptions and abbreviations together", () => {
  const options = [
    skill("r-e-v-i-e-w"),
    skill("help", "Review"),
    skill("xxreview"),
    skill("a-review"),
    skill("reviewer"),
    skill("review"),
  ];
  assert.deepEqual(
    searchComposerOptions(options, " /ReView ").map(({ name }) => name),
    ["/review", "/reviewer", "/a-review", "/xxreview", "/help", "/r-e-v-i-e-w"],
  );
  const model = {
    id: "command:model",
    command: "model",
    name: "/model",
    description: "选择模型",
  };
  assert.deepEqual(searchComposerOptions([model, ...options], "模型"), [model]);
});

test("abbreviations favor compact names and do not fuzzily match descriptions", () => {
  const options = [
    skill("gh-fix-ci"),
    skill("browser", "Get files checked"),
    skill("github"),
    skill("g-f-c"),
  ];
  assert.deepEqual(
    searchComposerOptions(options, "gfc").map(({ name }) => name),
    ["/g-f-c", "/gh-fix-ci"],
  );
  assert.deepEqual(searchComposerOptions(options, "cfg"), []);
  assert.deepEqual(searchComposerOptions(options, "missing"), []);
});

test("same-name skills remain selectable with commands winning equal scores", () => {
  const customModel = skill("model");
  const command = { ...customModel, id: "command:model", command: "model" };
  const otherModel = { ...customModel, id: "skill:other-model" };
  const options = [customModel, otherModel, command];
  assert.deepEqual(searchComposerOptions(options, "model"), [
    command,
    customModel,
    otherModel,
  ]);
  assert.deepEqual(searchComposerOptions(options, "/"), options);
});

test("mention triggers ignore standalone @ followed by space or clause punctuation", () => {
  const standalone = "lever 好像没实际支持 @ 其他Ag";
  assert.equal(matchComposerTrigger(standalone, standalone.length + 1), null);

  const sentence = "lever 好像没实际支持 @ 其他Agent? 或者只支持艾特";
  assert.equal(matchComposerTrigger(sentence, sentence.length + 1), null);

  const bare = "lever 好像没实际支持 @";
  assert.deepEqual(matchComposerTrigger(bare, bare.length + 1), {
    kind: "mention",
    prefix: "@",
    query: "",
    start: bare.length,
    end: bare.length + 1,
  });

  for (const text of [
    "lever 好像没实际支持 @ ",
    "lever 好像没实际支持 @其他Agent? 或者只支持艾特",
    "lever 好像没实际支持@其他Agent？或者只支持艾特",
    "前面写了个@，后面已经不艾特了",
    "提到了@foo，然后继续写",
    "（@foo）继续写",
    "fixture@example.invalid",
    `@a ${"b".repeat(100)}`,
  ]) {
    assert.equal(matchComposerTrigger(text, text.length + 1), null, text);
  }
});

test("mention and command triggers still match multi-word titles, paths, and slash commands after @", () => {
  const note = "[wire] 对照@Review decisions";
  assert.deepEqual(matchComposerTrigger(note, note.length + 1), {
    kind: "mention",
    prefix: "@",
    query: "Review decisions",
    start: note.indexOf("@") + 1,
    end: note.length + 1,
  });

  const file = "看看🙂 @docs/design notes.md";
  assert.deepEqual(matchComposerTrigger(file, file.length + 1), {
    kind: "mention",
    prefix: "@",
    query: "docs/design notes.md",
    start: file.indexOf("@") + 1,
    end: file.length + 1,
  });

  const slashAfterMention = "@foo /chat";
  assert.deepEqual(
    matchComposerTrigger(slashAfterMention, slashAfterMention.length + 1),
    {
      kind: "command",
      prefix: "/",
      query: "chat",
      start: slashAfterMention.indexOf("/") + 1,
      end: slashAfterMention.length + 1,
    },
  );
});
