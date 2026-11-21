import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONContent } from "@tiptap/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import {
  markdownPrompt,
  preservePromptWhitespace,
  referenceText,
  serializePrompt,
  textPrompt,
} from "../src/features/chat/prompt.ts";

test("common Markdown formatting survives parsing and sending", () => {
  const source = [
    "# 标题",
    "**粗体** *斜体* ~~删除~~ `a_b` [链接](https://example.com)",
    "> 引用",
    "- 第一项\n  - 嵌套项\n- 第二项",
    "3. 第三项\n4. 第四项",
    "```ts\nconst x = '<tag> & **literal**';\n```",
  ].join("\n\n");
  const doc = markdownPrompt(source);
  const result = serializePrompt(doc);
  assert.equal(result.text, source);
  assert.deepEqual(result.references, []);
  assert.deepEqual(markdownPrompt(result.text), doc);
});

test("code containing backticks keeps valid fences", () => {
  for (const source of [
    "``a ` b``",
    "`` `edge` ``",
    "````md\n```js\nconst x = 1;\n```\n````",
  ]) {
    const doc = markdownPrompt(source);
    assert.deepEqual(markdownPrompt(serializePrompt(doc).text), doc);
  }
});

test("pasted indentation stays editable text beside fenced code", () => {
  const indented = '            "level": "*",';
  const continuation = '"ids": [\n\t9007199254740993001\n        ],';
  const code = '    {"level": "*"}';
  const fenced = ["```json", code, "```"].join("\n");
  const doc = markdownPrompt(
    ["看看 {", indented, continuation, fenced].join("\n\n"),
  );
  assert.deepEqual(
    doc.content?.map((node) => node.type),
    ["paragraph", "paragraph", "paragraph", "codeBlock"],
  );
  assert.equal(doc.content?.[1].content?.[0].text, indented);
  assert.equal(doc.content?.[2].content?.[0].text, continuation);
  assert.equal(doc.content?.[3].content?.[0].text, code);
  assert.deepEqual(markdownPrompt(serializePrompt(doc).text), doc);
});

test("indented paragraphs stay literal when sent and edited", () => {
  const doc = textPrompt('看看 {\n            "level": "*",\n\t"ids": [],\n}');
  assert.deepEqual(markdownPrompt(serializePrompt(doc).text), doc);
});

test("user Markdown renders indentation after paragraph starts and line breaks", () => {
  const doc = markdownPrompt(
    '看看 {\n\n            "level": "*",\n\n"object_type": "uid",\n"ids": [  \n\t9007199254740993001\n        ],\n}',
  );
  const html = renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        remarkPlugins: [
          ...Object.values(defaultRemarkPlugins),
          preservePromptWhitespace,
        ],
      },
      serializePrompt(doc).text,
    ),
  );
  assert.doesNotMatch(html, /<pre\b/);
  assert.match(html, /<p> {12}&quot;level&quot;: &quot;\*&quot;,<\/p>/);
  assert.ok(
    html.includes(
      "<p>&quot;object_type&quot;: &quot;uid&quot;,\n&quot;ids&quot;: [\n\t9007199254740993001\n        ],\n}</p>",
    ),
  );
});

test("reference ranges include formatting, nested lists and UTF-16 characters", () => {
  const ref = {
    kind: "file",
    name: "docs/design notes.md",
    path: "/scope/docs/design notes.md",
  };
  const skill = {
    kind: "skill",
    name: "review",
    path: "/skills/review",
    provider: "codex",
  };
  const token = (reference: typeof ref | typeof skill): JSONContent => ({
    type: "reference",
    attrs: { reference },
  });
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [
          { type: "text", text: "看看🙂 \ufffc ", marks: [{ type: "bold" }] },
          token(ref),
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  token(skill),
                  { type: "text", text: " 再看 " },
                  token(ref),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const before = JSON.stringify(doc);
  const { text, references } = serializePrompt(doc);
  assert.equal(
    text,
    "## **看看🙂 \ufffc** @docs/design notes.md\n\n- $review 再看 @docs/design notes.md",
  );
  assert.equal(references.length, 3);
  assert.ok(references[0].start! < references[1].start!);
  assert.ok(references[1].start! < references[2].start!);
  for (const reference of references) {
    assert.equal(
      text.slice(reference.start, reference.end),
      referenceText(reference),
    );
  }
  assert.equal(JSON.stringify(doc), before);
});

test("unsupported Markdown is kept as editable source instead of dropping content", () => {
  for (const source of [
    "# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    "before ![diagram](./diagram.png) after",
    "- [x] 已完成\n- [ ] 待处理",
    "<button>保留源码</button>",
  ]) {
    assert.deepEqual(markdownPrompt(source), textPrompt(source));
  }
});

test("literal syntax and legacy text drafts remain literal after a Markdown round trip", () => {
  const source = "[wire] **not a mark** <tag> & raw_path";
  const doc = textPrompt(source);
  assert.deepEqual(markdownPrompt(serializePrompt(doc).text), doc);
});

test("empty input remains an editable empty document", () => {
  assert.deepEqual(markdownPrompt(""), textPrompt(""));
  assert.equal(serializePrompt(textPrompt("")).text, "");
});
