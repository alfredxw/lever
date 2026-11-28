import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasLeverReferenceHtml,
  isPasteAsTextShortcut,
  MAX_MESSAGE_TEXT_BYTES,
  nextPastedTextFileName,
  PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  pastedTextDisposition,
  utf8ByteLength,
  wouldTextPasteExceedLimit,
} from "../src/features/chat/composerTextPaste.ts";

test("pastedTextDisposition switches at the 64 KiB UTF-8 byte threshold", () => {
  const belowAscii = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES - 1);
  const atAscii = "a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.equal(
    pastedTextDisposition({ text: belowAscii, canAttach: true }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({ text: atAscii, canAttach: true }),
    "attachment",
  );

  // Each CJK character is 1 UTF-16 code unit but 3 UTF-8 bytes.
  const cjkCount = Math.ceil(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES / 3);
  const cjkAt = "中".repeat(cjkCount);
  const cjkBelow = "中".repeat(cjkCount - 1);
  assert.ok(cjkAt.length < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.ok(utf8ByteLength(cjkAt) >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.ok(utf8ByteLength(cjkBelow) < PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  assert.equal(
    pastedTextDisposition({ text: cjkBelow, canAttach: true }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({ text: cjkAt, canAttach: true }),
    "attachment",
  );
});

test("pastedTextDisposition honors bypass, attachment availability, empty text, and input limit", () => {
  const large = "x".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES + 100);
  assert.equal(
    pastedTextDisposition({
      text: large,
      canAttach: true,
      bypassAutoAttachment: true,
    }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({ text: large, canAttach: false }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({
      text: "",
      canAttach: true,
      wouldExceedInputLimit: true,
    }),
    "inline",
  );
  assert.equal(
    pastedTextDisposition({
      text: "small",
      canAttach: true,
      wouldExceedInputLimit: true,
    }),
    "attachment",
  );
  assert.equal(
    pastedTextDisposition({
      text: "small",
      canAttach: true,
      wouldExceedInputLimit: true,
      bypassAutoAttachment: true,
    }),
    "inline",
  );
});

test("isPasteAsTextShortcut matches Cmd/Ctrl+Shift+V and macOS Cmd+Option+Shift+V across layouts", () => {
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "V",
        code: "KeyV",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      },
      true,
    ),
    true,
  );
  // macOS Paste and Match Style (Cmd+Option+Shift+V) produces "◊" on US layout.
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "◊",
        code: "KeyV",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: true,
      },
      true,
    ),
    true,
  );
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "v",
        code: "KeyV",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      },
      true,
    ),
    false,
  );
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "V",
        code: "KeyV",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      },
      true,
    ),
    false,
  );

  // Windows / Linux: Ctrl+Shift+V only (not Alt, not Meta).
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "V",
        code: "KeyV",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      },
      false,
    ),
    true,
  );
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "V",
        code: "KeyV",
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      },
      false,
    ),
    false,
  );
  // Non-Latin layout falls back to physical KeyV; remapped Latin letter follows key.
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "М",
        code: "KeyV",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      },
      false,
    ),
    true,
  );
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "k",
        code: "KeyV",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      },
      false,
    ),
    false,
  );
  assert.equal(
    isPasteAsTextShortcut(
      {
        key: "V",
        code: "Period",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      },
      false,
    ),
    true,
  );
});

test("wouldTextPasteExceedLimit accounts for replaced selection bytes", () => {
  assert.equal(
    wouldTextPasteExceedLimit({
      currentBytes: MAX_MESSAGE_TEXT_BYTES - 10,
      selectedBytes: 0,
      pastedBytes: 10,
    }),
    false,
  );
  assert.equal(
    wouldTextPasteExceedLimit({
      currentBytes: MAX_MESSAGE_TEXT_BYTES - 10,
      selectedBytes: 0,
      pastedBytes: 11,
    }),
    true,
  );
  assert.equal(
    wouldTextPasteExceedLimit({
      currentBytes: MAX_MESSAGE_TEXT_BYTES,
      selectedBytes: 100,
      pastedBytes: 100,
    }),
    false,
  );
});

test("nextPastedTextFileName increments case-insensitively and reuses free slots", () => {
  assert.equal(nextPastedTextFileName([]), "pasted-text.txt");
  assert.equal(nextPastedTextFileName(["notes.txt"]), "pasted-text.txt");
  assert.equal(
    nextPastedTextFileName(["pasted-text.txt"]),
    "pasted-text-2.txt",
  );
  assert.equal(
    nextPastedTextFileName(["PASTED-TEXT.TXT", "pasted-text-2.txt"]),
    "pasted-text-3.txt",
  );
  assert.equal(
    nextPastedTextFileName(["pasted-text-2.txt"]),
    "pasted-text.txt",
  );
});

test("hasLeverReferenceHtml only matches serialized Lever reference spans", () => {
  assert.equal(hasLeverReferenceHtml(""), false);
  assert.equal(hasLeverReferenceHtml("<p>Large copied webpage text</p>"), false);
  assert.equal(
    hasLeverReferenceHtml("<code>data-lever-reference=&quot;1&quot;</code>"),
    false,
  );
  assert.equal(
    hasLeverReferenceHtml(
      '<p>See <span data-lever-reference="{&quot;kind&quot;:&quot;file&quot;}">a.ts</span></p>',
    ),
    true,
  );
});
