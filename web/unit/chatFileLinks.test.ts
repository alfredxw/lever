import assert from "node:assert/strict";
import test from "node:test";
import {
  chatFileTarget,
  chatPreviewURL,
  resolveChatFileLink,
} from "../src/features/chat/chatFileLinks.ts";

const origin = "http://localhost:4789";

test("Codex preview URLs keep the file path separate from its fragment", () => {
  for (const href of [
    "file:///work/design%20%231.svg#diagram",
    "sandbox:/work/design%20%231.svg#diagram",
    "/work/design%20%231.svg#diagram",
  ]) {
    const target = chatFileTarget(href, origin)!;
    const url = new URL(
      chatPreviewURL(
        "/api/runs/1/preview",
        "image",
        target.path,
        target.fragment,
      ),
      origin,
    );
    assert.equal(url.searchParams.get("path"), "/work/design #1.svg");
    assert.equal(url.hash, "#diagram");
  }
  assert.equal(
    chatFileTarget("file:///C:/Work/diagram.png", origin)?.path,
    "C:/Work/diagram.png",
  );
  for (const href of [
    "file://other/work/a.png",
    "sandbox://other/work/a.html",
    "https://example.com/design.png",
    "../bad%ZZ.svg",
    "#here",
  ]) {
    assert.equal(chatFileTarget(href, origin), null);
  }
});

test("line references into HTML still resolve to an editor location", () => {
  const root = { id: "root", path: "/work" };
  assert.deepEqual(
    resolveChatFileLink(
      "report.html:12:3",
      { roots: [root], primaryRootId: root.id },
      [root],
      origin,
    ),
    {
      root,
      path: "report.html",
      location: { line: 12, column: 3, endColumn: 3 },
    },
  );
});
