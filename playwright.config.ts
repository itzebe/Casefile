import { defineConfig } from "@playwright/test";

import { resolveBrowserExecutable } from "./e2e/browser.js";

/**
 * Browser end-to-end configuration.
 *
 * Runs against a real dev server with `AUTH_DISABLED=1`, which is the
 * documented local/preview sign-in path: it resolves a signed-in development
 * user so the suite exercises the same routes and actions a person does, rather
 * than mocking auth. `AUTH_DISABLED` must never be set in a production deploy.
 *
 * The browser is the system Chromium via `playwright-core` (see
 * `e2e/browser.ts`), so no CDN download is required.
 */
const PORT = Number(process.env.E2E_PORT ?? 12001);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    launchOptions: {
      executablePath: resolveBrowserExecutable(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        // `agent-native dev` without `--open`: the suite never needs a browser
        // tab opened for it, and `--open` would try to launch one in the runner.
        command: `AUTH_DISABLED=1 PORT=${PORT} pnpm exec agent-native dev`,
        url: `${BASE_URL}/home`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
