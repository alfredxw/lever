import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES } from "../src/features/chat/composerTextPaste.ts";

function fixtureContext() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as {
    url: string;
    scope: string;
  };
}

async function pasteClipboard(
  input: Locator,
  payload: { text: string; html?: string },
  focus = true,
) {
  if (focus) await input.click();
  await input.evaluate((element, { text, html }) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    if (html) data.setData("text/html", html);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, payload);
}

test("large pasted text turns into a file attachment and Cmd/Ctrl+Shift+V pastes inline", async ({
  page,
}) => {
  await page.goto(fixtureContext().url);
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  await expect(input).toBeVisible();

  // Normal paste under 64 KiB stays inline.
  const shortText = "普通文本段落，不需要转附件。";
  await pasteClipboard(input, { text: shortText });
  await expect(input).toContainText(shortText);
  await expect(page.locator(".composer .attachment-chip")).toHaveCount(0);

  // Large paste (>= 64 KiB UTF-8, even when text/html is also on clipboard) folds into pasted-text.txt.
  const largeText = `${"日志内容-".repeat(6000)}\nEND_OF_LARGE_PASTE`;
  expect(Buffer.byteLength(largeText, "utf8")).toBeGreaterThanOrEqual(
    PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
  );
  await pasteClipboard(input, {
    text: largeText,
    html: `<pre>${largeText}</pre>`,
  });
  const firstChip = page.locator(".composer .attachment-chip", {
    hasText: "pasted-text.txt",
  });
  await expect(firstChip).toBeVisible();
  // Existing inline draft text is preserved without inserting the large paste.
  await expect(input).toHaveText(shortText);

  // Verify the uploaded attachment content matches the pasted text verbatim.
  const firstHref = await firstChip
    .locator("a.attachment-open")
    .getAttribute("href");
  expect(firstHref).toBeTruthy();
  const downloaded = await page.request.get(
    new URL(firstHref!, fixtureContext().url).toString(),
  );
  expect(downloaded.ok()).toBe(true);
  expect(await downloaded.text()).toBe(largeText);

  // A second large paste receives the incremented filename pasted-text-2.txt.
  const secondLargeText = "B".repeat(
    PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES + 128,
  );
  await pasteClipboard(input, { text: secondLargeText });
  await expect(
    page.locator(".composer .attachment-chip", {
      hasText: "pasted-text-2.txt",
    }),
  ).toBeVisible();
  await expect(page.locator(".composer .attachment-chip")).toHaveCount(2);

  // Pressing Cmd/Ctrl+Shift+V (or Cmd+Option+Shift+V on macOS) arms inline paste for the next paste event.
  const isMacBrowser = await page.evaluate(() =>
    navigator.platform.includes("Mac"),
  );
  const bypassChords = isMacBrowser
    ? [
        { key: "V", altKey: false, prefix: "INLINE_SHIFT_" },
        { key: "◊", altKey: true, prefix: "INLINE_OPT_SHIFT_" },
      ]
    : [{ key: "V", altKey: false, prefix: "INLINE_CTRL_SHIFT_" }];

  for (const chord of bypassChords) {
    await input.click();
    await input.press("ControlOrMeta+A");
    await input.press("Backspace");
    await input.evaluate(
      (element, { mac, key, altKey }) => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: "KeyV",
            metaKey: mac,
            ctrlKey: !mac,
            altKey,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { mac: isMacBrowser, key: chord.key, altKey: chord.altKey },
    );
    const inlineLargeText = `${chord.prefix}${"C".repeat(
      PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES,
    )}`;
    await pasteClipboard(
      input,
      {
        text: inlineLargeText,
        html: `<p><strong>${inlineLargeText}</strong></p>`,
      },
      false,
    );
    await expect(page.locator(".composer .attachment-chip")).toHaveCount(2);
    await expect(input).toContainText(chord.prefix);
    // Pasted as plain text (no <strong> element from text/html).
    await expect(input.locator("strong")).toHaveCount(0);
  }
});
