import { defineConfig } from "@playwright/test";

const baseURL = `http://127.0.0.1:${process.env.LEVER_TEST_PORT ?? "4789"}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    locale: "zh-CN",
    baseURL,
    viewport: { width: 1360, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/server.mjs",
    wait: { stdout: /Lever browser fixture ready/ },
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
