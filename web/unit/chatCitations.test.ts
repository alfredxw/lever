import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/api/types.gen.ts";
import {
  CITATION_SENTINEL_END,
  CITATION_SENTINEL_START,
  citationDomain,
  insertCitationSentinels,
  resolveDisplayCitations,
  stripCitationMarkers,
} from "../src/features/chat/chatCitations.ts";

test("stripCitationMarkers cleans cite markers while keeping code and visualize markers", () => {
  const input = [
    "[打开团队密钥页面](https://appstoreconnect.apple.com/access/integrations/api) \uE200cite\uE202turn3view0\uE202turn2search0\uE201",
    "继续即可。\uE200cite\uE202turn590795search2\uE201",
    "inline `\uE200cite\uE202turn1search0\uE201` kept",
    "```",
    "\uE200cite\uE202turn1search0\uE201",
    "```",
    '\uE200visualize\uE202{"path":"/tmp/chart.html"}\uE201',
  ].join("\n");

  const expected = [
    "[打开团队密钥页面](https://appstoreconnect.apple.com/access/integrations/api)",
    "继续即可。",
    "inline `\uE200cite\uE202turn1search0\uE201` kept",
    "```",
    "\uE200cite\uE202turn1search0\uE201",
    "```",
    '\uE200visualize\uE202{"path":"/tmp/chart.html"}\uE201',
  ].join("\n");

  assert.equal(stripCitationMarkers(input), expected);
});

test("stripCitationMarkers holds back partial streaming cite tokens without touching visualize", () => {
  assert.equal(stripCitationMarkers("准备完成。 \uE200", true), "准备完成。");
  assert.equal(stripCitationMarkers("准备完成。 \uE200ci", true), "准备完成。");
  assert.equal(
    stripCitationMarkers("准备完成。 \uE200cite\uE202turn1search", true),
    "准备完成。",
  );
  assert.equal(
    stripCitationMarkers('\uE200visualize\uE202{"path":"/tmp/a.html"}', true),
    '\uE200visualize\uE202{"path":"/tmp/a.html"}',
  );
});

test("resolveDisplayCitations resolves legacy search_service tool items", () => {
  const tools: Item[] = [
    {
      id: "call_1",
      kind: "tool",
      title: "codex_apps / search_service.web_run",
      status: "completed",
      text: JSON.stringify(
        {
          _meta: {
            raw_messages: [
              {
                content: {
                  ref_id: "turn3view0",
                  title: "App Store Connect API - Get started",
                  url: "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/",
                },
                metadata: {
                  sonic_browser_tool: {
                    content: {
                      turn2search0: {
                        link_labels: { "0": "Nested" },
                        title: "Apple Developer Program Roles",
                        url: "https://developer.apple.com/help/account/access/roles",
                      },
                      turnBad: {
                        title: "Evil",
                        url: "javascript:alert(1)",
                      },
                    },
                  },
                },
              },
            ],
          },
        },
        null,
        2,
      ),
    },
    {
      id: "call_2",
      kind: "tool",
      title: "codex_apps / search_service.web_run",
      status: "completed",
      text: "Synchronizing code signing identities (https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates)\n【turn1search0】 snippet",
    },
  ];

  const text =
    "步骤一。[打开页面](https://appstoreconnect.apple.com) \uE200cite\uE202turn3view0\uE202turn2search0\uE202turnBad\uE201\n" +
    "步骤二。\uE200cite\uE202turn1search0\uE201\n" +
    "无来源。\uE200cite\uE202turn999search0\uE201";

  const resolved = resolveDisplayCitations(text, undefined, tools, false);
  assert.equal(
    resolved.text,
    "步骤一。[打开页面](https://appstoreconnect.apple.com)\n步骤二。\n无来源。",
  );
  assert.equal(resolved.citations.length, 2);
  assert.deepEqual(resolved.citations[0], {
    offset: "步骤一。[打开页面](https://appstoreconnect.apple.com)".length,
    sources: [
      {
        title: "App Store Connect API - Get started",
        url: "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/",
      },
      {
        title: "Apple Developer Program Roles",
        url: "https://developer.apple.com/help/account/access/roles",
      },
    ],
  });
  assert.deepEqual(resolved.citations[1], {
    offset: "步骤一。[打开页面](https://appstoreconnect.apple.com)\n步骤二。"
      .length,
    sources: [
      {
        title: "Synchronizing code signing identities",
        url: "https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates",
      },
    ],
  });
});

test("insertCitationSentinels merges offsets, filters unsafe URLs, and skips code spans", () => {
  const text = "Hello `code` world.";
  const { markdown, citations } = insertCitationSentinels(text, [
    {
      offset: 8, // inside `code`
      sources: [{ title: "Skip", url: "https://example.com/skip" }],
    },
    {
      offset: text.length,
      sources: [
        { title: "Unsafe", url: "file:///etc/passwd" },
        { title: "One", url: "https://www.example.com/one" },
      ],
    },
    {
      offset: text.length,
      sources: [
        { title: "Duplicate", url: "https://www.example.com/one" },
        { title: "Two", url: "https://docs.example.org/two" },
      ],
    },
  ]);

  assert.equal(
    markdown,
    `Hello \`code\` world.${CITATION_SENTINEL_START}0${CITATION_SENTINEL_END}`,
  );
  assert.equal(citations.length, 1);
  assert.deepEqual(citations[0].sources, [
    { title: "One", url: "https://www.example.com/one" },
    { title: "Two", url: "https://docs.example.org/two" },
  ]);
  assert.equal(citationDomain("https://www.example.com/one"), "example.com");
  assert.equal(
    citationDomain("https://developer.apple.com/docs"),
    "developer.apple.com",
  );
});
