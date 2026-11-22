import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractDroppedFiles,
  hasDraggedFiles,
} from "../src/features/chat/composerFiles.ts";

test("hasDraggedFiles detects files across types, files, and items", () => {
  assert.equal(hasDraggedFiles(null), false);
  assert.equal(hasDraggedFiles(undefined), false);
  assert.equal(hasDraggedFiles({ types: ["text/plain"], files: [] }), false);
  assert.equal(hasDraggedFiles({ types: ["Files"], files: [] }), true);
  assert.equal(
    hasDraggedFiles({
      types: [],
      files: [new File(["hi"], "note.txt", { type: "text/plain" })],
    }),
    true,
  );
  assert.equal(
    hasDraggedFiles({
      types: [],
      items: [{ kind: "file", getAsFile: () => null }],
    }),
    true,
  );
  assert.equal(
    hasDraggedFiles({
      types: [],
      items: [{ kind: "string", getAsFile: () => null }],
    }),
    false,
  );
});

test("extractDroppedFiles keeps regular files and skips dropped directories", () => {
  const note = new File(["hello"], "note.txt", { type: "text/plain" });
  const folder = new File([], "docs");
  const result = extractDroppedFiles({
    files: [folder, note],
    items: [
      {
        kind: "file",
        webkitGetAsEntry: () => ({ isDirectory: true }),
        getAsFile: () => folder,
      },
      {
        kind: "file",
        webkitGetAsEntry: () => ({ isDirectory: false }),
        getAsFile: () => note,
      },
      {
        kind: "string",
        getAsFile: () => null,
      },
    ],
  });
  assert.deepEqual(result.files, [note]);
  assert.equal(result.skippedDirectories, 1);
});

test("extractDroppedFiles falls back to dataTransfer.files when items are unavailable", () => {
  const image = new File(["png"], "photo.png", { type: "image/png" });
  const result = extractDroppedFiles({ files: [image] });
  assert.deepEqual(result.files, [image]);
  assert.equal(result.skippedDirectories, 0);
});
