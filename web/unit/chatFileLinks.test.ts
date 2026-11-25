import assert from "node:assert/strict";
import test from "node:test";
import {
  chatFileTarget,
  chatHtmlPreview,
  chatPreviewURL,
  htmlViewerURL,
  parseHtmlPreviewURL,
  resolveChatFile,
  resolveChatFileLink,
} from "../src/features/chat/chatFileLinks.ts";
import {
  absoluteFilePath,
  hostFileSelection,
} from "../src/features/files/filePaths.ts";

const origin = "http://localhost:4789";

test("pasted HTML preview and viewer links preserve their own scope and anchor", () => {
  for (const endpoint of [
    "/api/runs/original/preview",
    "/api/shared-conversations/claude/native%20chat/preview",
  ]) {
    const src = chatPreviewURL(
      endpoint,
      "html",
      "/work/report #1.HTM",
      "#notes",
    );
    const viewer = htmlViewerURL(src);
    for (const href of [src, origin + src, viewer, origin + viewer]) {
      assert.deepEqual(parseHtmlPreviewURL(href, origin), {
        src,
        title: "report #1.HTM",
      });
    }
  }
  for (const href of [
    "https://other.test/api/runs/id/preview?kind=html&path=a.html",
    "http://name@localhost:4789/api/runs/id/preview?kind=html&path=a.html",
    "/api/other/preview?kind=html&path=a.html",
    "/api/runs/id/preview?kind=image&path=a.html",
    "/view/runs/id/preview?kind=html&path=a.svg",
    "/view/other/runs/id/preview?kind=html&path=a.html",
  ])
    assert.equal(parseHtmlPreviewURL(href, origin), null);
});

test("HTML attachments use their own filename and download identity", () => {
  const endpoint = "/api/attachments/upload/preview";
  const title = "Report #1.html";
  const src = chatPreviewURL(endpoint, "html", title);
  assert.deepEqual(parseHtmlPreviewURL(htmlViewerURL(src), origin), {
    src,
    title,
  });
  assert.equal(
    parseHtmlPreviewURL(
      chatPreviewURL(endpoint, "html", "/work/report.html"),
      origin,
    ),
    null,
  );
  assert.equal(
    parseHtmlPreviewURL(
      chatPreviewURL(endpoint, "visualization", title),
      origin,
    ),
    null,
  );
});

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

test("local HTML needs a preview scope; pasted preview links keep their own", () => {
  const endpoint = "/api/runs/1/preview";
  assert.equal(
    chatHtmlPreview("https://other.test/report.html", endpoint, origin),
    null,
  );
  assert.equal(chatHtmlPreview("report.html", undefined, origin), null);
  const src = chatPreviewURL(endpoint, "html", "report #1.html", "#notes");
  const expected = { src, title: "report #1.html" };
  assert.deepEqual(
    chatHtmlPreview("report%20%231.html#notes", endpoint, origin),
    expected,
  );
  assert.deepEqual(chatHtmlPreview(origin + src, undefined, origin), expected);
});

test("line references into HTML still resolve to an editor location", () => {
  assert.equal(
    chatHtmlPreview("report.html:12:3", "/api/runs/1/preview", origin),
    null,
  );
  assert.equal(
    chatHtmlPreview("report.html#L12-L20", "/api/runs/1/preview", origin),
    null,
  );
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
  assert.deepEqual(
    chatFileTarget("file:///work/src/App.tsx#L731-L777", origin),
    {
      path: "/work/src/App.tsx",
      fragment: "",
      location: { line: 731, column: 1, endColumn: 1 },
    },
  );
  assert.deepEqual(chatFileTarget("/work/src/App.tsx#L12C4-L15C8", origin), {
    path: "/work/src/App.tsx",
    fragment: "",
    location: { line: 12, column: 4, endColumn: 4 },
  });
});

test("resolveChatFile distinguishes workspace files from read-only host files", () => {
  const root = { id: "root", path: "/work/lever" };
  const scope = { roots: [root], primaryRootId: root.id };

  assert.deepEqual(
    resolveChatFile(
      "file:///work/lever/web/src/App.tsx#L10-L20",
      scope,
      [root],
      origin,
    ),
    {
      host: false,
      file: {
        root,
        path: "web/src/App.tsx",
        location: { line: 10, column: 1, endColumn: 1 },
      },
    },
  );

  const brainPath =
    "file:///fixtures/.gemini/antigravity-cli/brain/abc/design.md";
  const brain = resolveChatFile(brainPath, scope, [root], origin);
  assert.deepEqual(brain, {
    host: true,
    file: {
      root: { id: "host", path: "/fixtures/.gemini/antigravity-cli/brain/abc" },
      path: "design.md",
    },
  });
  assert.equal(
    absoluteFilePath(brain!.file),
    "/fixtures/.gemini/antigravity-cli/brain/abc/design.md",
  );
  assert.equal(resolveChatFileLink(brainPath, scope, [root], origin), null);

  const plan = resolveChatFile(
    "~/.claude/plans/spec.md",
    scope,
    [root],
    origin,
  );
  assert.deepEqual(plan, {
    host: true,
    file: {
      root: { id: "host", path: "~/.claude/plans" },
      path: "spec.md",
    },
  });
  assert.equal(absoluteFilePath(plan!.file), "~/.claude/plans/spec.md");
  assert.equal(
    resolveChatFile("~/../secret.md", scope, [root], origin),
    null,
  );

  const win = resolveChatFile("file:///C:/fixtures/plan.md", scope, [root], origin);
  assert.deepEqual(win, {
    host: true,
    file: {
      root: { id: "host", path: "C:/fixtures" },
      path: "plan.md",
    },
  });
  assert.equal(absoluteFilePath(win!.file), "C:/fixtures/plan.md");

  const winRoot = hostFileSelection("C:/plan.md");
  assert.deepEqual(winRoot, {
    root: { id: "host", path: "C:/" },
    path: "plan.md",
  });
  assert.equal(absoluteFilePath(winRoot!), "C:/plan.md");

  const unixRoot = hostFileSelection("/notes.md");
  assert.deepEqual(unixRoot, {
    root: { id: "host", path: "/" },
    path: "notes.md",
  });
  assert.equal(absoluteFilePath(unixRoot!), "/notes.md");

  for (const invalid of ["/", "~", "C:/", "//server/share/a.md", "relative.md"]) {
    assert.equal(hostFileSelection(invalid), null);
  }

  assert.deepEqual(
    resolveChatFile("README.md", undefined, [], origin, "/work/repo"),
    {
      host: true,
      file: {
        root: { id: "host", path: "/work/repo" },
        path: "README.md",
      },
    },
  );
});
