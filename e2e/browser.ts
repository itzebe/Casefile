import { existsSync } from "node:fs";

import { chromium, type Browser } from "playwright-core";

/**
 * Browser resolution for the end-to-end suite.
 *
 * The suite drives the system Chromium through `playwright-core` instead of the
 * browser Playwright downloads. That download is a large binary fetched from a
 * CDN, which is unavailable in many sandboxes and in CI without a cache warm-up,
 * and a failed download used to leave the whole browser layer unverified. A
 * system browser is already present on this image and on the GitHub Actions
 * runner, so pointing at it makes the setup reproducible everywhere.
 *
 * Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to override the path.
 */
const CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, // guard:allow-env-credential — optional test browser path override, not a credential
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
].filter((value): value is string => Boolean(value));

export function resolveBrowserExecutable(): string {
  const found = CANDIDATES.find((candidate) => existsSync(candidate));
  if (found) return found;

  // CI installs the browser with `playwright install chromium`, which lands in
  // Playwright's own cache rather than a system path. Ask Playwright where that
  // is before giving up, so the suite works in CI and on this image alike.
  const managed = chromium.executablePath();
  if (managed && existsSync(managed)) return managed;

  throw new Error(
    `No Chromium executable found. Looked in: ${[...CANDIDATES, managed].join(", ")}. ` +
      "Install one (apt-get install -y chromium), run `playwright install chromium`, " +
      "or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.",
  );
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: resolveBrowserExecutable(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}
