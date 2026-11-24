import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";

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

async function pastePlainText(input: Locator, text: string) {
  await input.click();
  await input.evaluate((element, payload) => {
    const data = new DataTransfer();
    data.setData("text/plain", payload);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, text);
}

test("composer links open on click while preserving selection and safety", async ({
  page,
  context,
}) => {
  await context.route("https://example.test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>External</title><p>ok</p>",
    }),
  );

  await page.goto(fixtureContext().url);
  const input = page.getByRole("textbox", { name: "发送消息", exact: true });
  await expect(input).toBeVisible();

  const wikiUrl = "https://example.test/wiki/PfBLwo5AkihxRskQzJRcXMohnQb";
  await pastePlainText(input, `${wikiUrl} 怎么个事`);

  const link = input.locator("a", { hasText: wikiUrl });
  await expect(link).toHaveAttribute("href", wikiUrl);
  await expect(link).toHaveCSS("cursor", "pointer");

  // Single left-click opens the link in a new page with noopener.
  const openedPromise = context.waitForEvent("page");
  await link.click();
  const opened = await openedPromise;
  await opened.waitForLoadState("domcontentloaded");
  expect(opened.url()).toBe(wikiUrl);
  expect(await opened.evaluate(() => window.opener)).toBeNull();
  await opened.close();
  await expect(input).toHaveText(`${wikiUrl} 怎么个事`);

  // Cmd/Ctrl+click also opens the link.
  const modifierPromise = context.waitForEvent("page");
  await link.click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  const modifierOpened = await modifierPromise;
  await modifierOpened.waitForLoadState("domcontentloaded");
  expect(modifierOpened.url()).toBe(wikiUrl);
  await modifierOpened.close();

  // Drag-selecting across the link, right-clicking, or Alt+clicking does not open it.
  let unexpectedPages = 0;
  const onPage = () => {
    unexpectedPages += 1;
  };
  context.on("page", onPage);
  try {
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 8, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + Math.min(80, box!.width - 4),
      box!.y + box!.height / 2,
      {
        steps: 4,
      },
    );
    await page.mouse.up();
    await link.click({ button: "right" });
    await link.click({ modifiers: ["Alt"] });
    await page.waitForTimeout(150);
    expect(unexpectedPages).toBe(0);
  } finally {
    context.off("page", onPage);
  }

  // Clicking formatted children inside a Markdown link opens the target URL.
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  const docUrl = "https://example.test/formatted-doc";
  await pastePlainText(input, `[**飞书文档**](${docUrl})`);
  const boldText = input.locator("a strong", { hasText: "飞书文档" });
  await expect(boldText).toBeVisible();
  const formattedPromise = context.waitForEvent("page");
  await boldText.click();
  const formatted = await formattedPromise;
  await formatted.waitForLoadState("domcontentloaded");
  expect(formatted.url()).toBe(docUrl);
  await formatted.close();

  // Typed URLs converted by autolink also open on click.
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  const typedUrl = "https://example.test/typed";
  await input.pressSequentially(`${typedUrl} `);
  const typedLink = input.locator("a", { hasText: typedUrl });
  await expect(typedLink).toHaveAttribute("href", typedUrl);
  const typedPromise = context.waitForEvent("page");
  await typedLink.click();
  const typed = await typedPromise;
  await typed.waitForLoadState("domcontentloaded");
  expect(typed.url()).toBe(typedUrl);
  await typed.close();

  // Blocked protocols render an empty href and must never open a tab.
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  await pastePlainText(input, "[bad](javascript:alert(1))");
  const blocked = input.locator("a", { hasText: "bad" });
  await expect(blocked).toHaveAttribute("href", "");
  await expect(blocked).not.toHaveCSS("cursor", "pointer");
  let blockedOpened = 0;
  const onBlockedPage = () => {
    blockedOpened += 1;
  };
  context.on("page", onBlockedPage);
  try {
    await blocked.click();
    await page.waitForTimeout(150);
    expect(blockedOpened).toBe(0);
  } finally {
    context.off("page", onBlockedPage);
  }
});
