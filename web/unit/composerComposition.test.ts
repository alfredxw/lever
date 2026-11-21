import assert from "node:assert/strict";
import { test } from "node:test";
import { pinyinPreedit } from "../src/features/chat/composerComposition.ts";

function preedit(...updates: string[]) {
  return updates.reduce<string | undefined>(pinyinPreedit, "");
}

test("Pinyin boundaries can move as letters are typed or erased", () => {
  assert.equal(preedit("t", "ta", "tab", "ta’b's"), "ta'b's");
  assert.equal(preedit("s", "sf'", "sf's", "sf'sf"), "sf'sf");
  assert.equal(
    preedit("s", "sf", "sf’s", "sf’sf", "sf’s", "sf’sf", "sf’sf's"),
    "sf'sf's",
  );
});

test("literal quotes and whole candidates keep their punctuation", () => {
  assert.equal(preedit("d", "do", "don", "don'", "don't"), undefined);
  assert.equal(preedit("I", "I’", "I’m"), undefined);
  assert.equal(preedit("O’Neill"), undefined);
  assert.equal(preedit("don", "dont", "don’t"), undefined);
  assert.equal(preedit("n", "ni", "ni'h", "你好"), undefined);
});
