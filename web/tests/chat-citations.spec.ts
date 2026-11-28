import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  Agent,
  Chat,
  ChatView,
  Overview,
  Run,
  Session,
} from "../src/api/types.gen";

const selection = { provider: "codex", model: "", effort: "", fast: false };

function fixtureContext() {
  return JSON.parse(
    readFileSync(
      process.env.LEVER_TEST_CONTEXT ?? "../output/e2e/context.json",
      "utf8",
    ),
  ) as { url: string; scope: string };
}

async function seedCitationChat(page: Page, theme: "light" | "dark" = "light") {
  const { url, scope } = fixtureContext();
  await page.addInitScript((mode) => {
    localStorage.setItem("lever:language", "zh-CN");
    localStorage.setItem("lever:theme", mode);
  }, theme);

  const now = "2026-11-25T04:19:46Z";
  const agent: Agent = {
    id: "agent-cite",
    name: "发布助手",
    profile: {
      provider: selection.provider,
      model: selection.model,
      roots: [{ id: "root", path: scope }],
      primaryRootId: "root",
      permission: "ask",
      instructions: "",
      skills: [],
      delegations: [],
    },
    archived: false,
    createdAt: now,
    updatedAt: now,
  };

  const chat: Chat = {
    id: "chat-cite",
    agentId: agent.id,
    title: "签名与公证",
    source: "user",
    createdAt: now,
    updatedAt: now,
  };

  const session: Session = {
    id: "session-cite",
    agentId: agent.id,
    chatId: chat.id,
    kind: "main",
    nativeId: "",
    roots: agent.profile.roots,
    primaryRootId: agent.profile.primaryRootId,
    selection,
    createdAt: now,
  };

  const structuredLine1 =
    "1. **生成 macOS 公证密钥。** 如果页面显示「请求访问」，先由账户持有人提交开通申请。[打开团队密钥页面](https://appstoreconnect.apple.com/access/integrations/api)";
  const structuredLine2 =
    "2. **导出现有签名证书。** 把这个密码直接填进私有仓库的 Actions Secret。[打开 GitHub Actions Secrets](https://github.com/example/lever/settings/secrets/actions)";
  const structuredText = `${structuredLine1}\n\n${structuredLine2}`;

  const structuredRun: Run = {
    id: "run-structured",
    sessionId: session.id,
    chatId: chat.id,
    agentId: agent.id,
    sequence: 1,
    input: "帮我查 macOS 签名与公证步骤",
    selection,
    attachments: [],
    handoff: false,
    status: "completed",
    items: [
      {
        id: "msg-structured",
        kind: "text",
        title: "",
        status: "completed",
        text: structuredText,
        citations: [
          {
            offset: structuredLine1.length,
            sources: [
              {
                title: "App Store Connect API - Get started - Apple Developer",
                url: "https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/",
              },
              {
                title: "Apple Developer Program Roles - Apple Developer",
                url: "https://developer.apple.com/help/account/access/roles",
              },
              {
                title: "Creating API Keys for App Store Connect API",
                url: "https://developer.apple.com/documentation/AppStoreConnectAPI/creating-api-keys-for-app-store-connect-api",
              },
            ],
          },
          {
            offset: structuredText.length,
            sources: [
              {
                title:
                  "Synchronizing code signing identities with your developer account",
                url: "https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates",
              },
            ],
          },
        ],
      },
    ],
    createdAt: now,
    finishedAt: now,
  };

  const legacyRun: Run = {
    id: "run-legacy",
    sessionId: session.id,
    chatId: chat.id,
    agentId: agent.id,
    sequence: 2,
    input: "顺便看下 TestFlight 和旧引用兼容",
    selection,
    attachments: [],
    handoff: false,
    status: "completed",
    items: [
      {
        id: "call-search",
        kind: "tool",
        title: "codex_apps / search_service.web_run",
        status: "completed",
        text: JSON.stringify(
          {
            _meta: {
              raw_messages: [
                {
                  content: {
                    ref_id: "turn4search0",
                    title:
                      "Add internal testers - TestFlight - Apple Developer",
                    url: "https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers",
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
        id: "msg-legacy",
        kind: "text",
        title: "",
        status: "completed",
        text:
          "iOS 的内测入口在 **App Store Connect → TestFlight → 内部测试**，可以单独准备。 \uE200cite\uE202turn4search0\uE201\n\n" +
          "无来源的旧标记会自动清理。\uE200cite\uE202turn590795search2\uE201",
      },
    ],
    createdAt: now,
    finishedAt: now,
  };

  const overview: Overview = {
    agents: [agent],
    chats: [chat],
    conversations: [
      {
        id: session.id,
        agentId: agent.id,
        chatId: chat.id,
        kind: "main",
        title: chat.title,
        preview: "iOS 的内测入口",
        messageAt: now,
        unreadSequence: 2,
      },
    ],
    runs: [],
    requests: [],
    dataDir: "",
    homeDir: "",
    deviceId: "fixture",
    deviceName: "fixture",
    platform: process.platform,
  };

  const view: ChatView = {
    chat,
    sessions: [session],
    entries: [
      {
        kind: "main",
        sessionId: session.id,
        runId: structuredRun.id,
        replyCount: 0,
      },
      {
        kind: "main",
        sessionId: session.id,
        runId: legacyRun.id,
        replyCount: 0,
      },
    ],
    runs: [structuredRun, legacyRun],
    hasMore: false,
    cursor: 2,
  };

  await page.route((url) => url.pathname === "/api/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route(/\/api\/chats\/chat-cite(\?|$)/, (route) =>
    route.fulfill({ json: view }),
  );
  await page.route(/\/api\/chats\/chat-cite\/delegations/, (route) =>
    route.fulfill({ json: { outgoing: {} } }),
  );

  await page.goto(url);
  await expect(page.locator('[data-run-id="run-legacy"]')).toBeVisible();
}

test("inline citations render compact pills, open multi-source popovers, and clean unresolved markers", async ({
  page,
}) => {
  await seedCitationChat(page, "light");

  const structured = page
    .locator('[data-run-id="run-structured"]')
    .locator(".chat-response");
  const multiPill = structured.getByRole("button", { name: "参考来源（3）" });
  await expect(multiPill).toHaveText("developer.apple.com +2");

  // Single-source citation is a direct external link with tooltip preview.
  const singlePill = structured.getByRole("link", {
    name: "Synchronizing code signing identities with your developer account",
  });
  await expect(singlePill).toHaveText("developer.apple.com");
  await expect(singlePill).toHaveAttribute(
    "href",
    "https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates",
  );
  await singlePill.hover();
  await expect(
    page
      .getByRole("tooltip")
      .getByText(
        "Synchronizing code signing identities with your developer account",
      ),
  ).toBeVisible();

  // Keyboard focus uses background highlight without any focus ring.
  await multiPill.focus();
  const focusStyles = await multiPill.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, boxShadow: s.boxShadow };
  });
  expect(focusStyles.outlineStyle).toBe("none");
  expect(focusStyles.boxShadow).toBe("none");

  // Clicking multi-source pill opens a popover listing all 3 sources.
  await multiPill.click();
  await expect(
    page.getByRole("link", {
      name: /App Store Connect API - Get started - Apple Developer/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: /Apple Developer Program Roles - Apple Developer/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: /Creating API Keys for App Store Connect API/,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Legacy run resolves search_service ref_ids and strips unresolved cite tokens.
  const legacy = page
    .locator('[data-run-id="run-legacy"]')
    .locator(".chat-response");
  await expect(
    legacy.getByRole("link", {
      name: "Add internal testers - TestFlight - Apple Developer",
    }),
  ).toHaveText("developer.apple.com");
  const legacyText = await legacy.innerText();
  expect(legacyText).not.toContain("\uE200");
  expect(legacyText).not.toContain("turn590795search2");
  expect(legacyText).not.toContain("turn4search0");
  expect(legacyText).toContain("无来源的旧标记会自动清理。");
});
