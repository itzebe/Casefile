// One minimal agent test: does a real tool call happen, and does the answer
// reflect the signed-in user's own (empty) case list? Also reports a provider
// quota rejection, which consumes no tokens.
// Usage: node scripts/prod-agent.mjs <baseUrl> <email> <password>
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "https://casefile-fhkr.vercel.app";
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];
if (!EMAIL || !PASSWORD) {
  console.error("usage: node scripts/prod-agent.mjs <baseUrl> <email> <password>");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
const runs = [];
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("agent-chat") && r.method() === "POST") {
    runs.push(`REQ ${r.method()} ${u.replace(BASE, "")} :: ${(r.postData() ?? "").slice(0, 500)}`);
  }
});
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("agent-chat") || u.includes("agent-engine")) {
    runs.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, "").slice(0, 90)}`);
  }
});

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.fill("#s-email", EMAIL);
await page.fill("#s-pass", PASSWORD);
await page.fill("#s-pass2", PASSWORD);
await page.getByRole("button", { name: /^create account$/i }).last().click();
await page.waitForTimeout(9000);

// Seed one case so "list my cases" has a real, user-owned row to find.
await page.evaluate(
  async (base) => {
    await fetch(`${base}/_agent-native/actions/load-demo-case`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "court" }),
    });
  },
  BASE,
);
await page.waitForTimeout(2000);

await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);

const box = page.locator("[contenteditable=true]").first();
await box.click();
await box.type(process.argv[5] ?? "List my cases, then stop.", { delay: 5 });
await page.waitForTimeout(400);
await page.keyboard.press("Enter");

let verdict = "no response within 260s";
for (let i = 0; i < 26; i += 1) {
  await page.waitForTimeout(10000);
  const t = await page.locator("body").innerText();
  if (/Rate limit reached|http_429|tokens per day|tokens per minute|usage limit/i.test(t)) {
    verdict = "PROVIDER QUOTA — the turn was rejected by the provider";
    break;
  }
  if (/HC-2024-1234|Acme|Northwind|court|Hello, Judge/i.test(t)) {
    verdict = "ANSWERED — the agent surfaced the seeded case";
    break;
  }
  if (/could not|cannot|unable to|Something went wrong/i.test(t)) {
    verdict = "ERROR — the agent turn failed";
    break;
  }
  if (/Worked for \d|failed before it finished|Response failed/i.test(t)) {
    verdict = /failed before it finished|Response failed/i.test(t)
      ? "ERROR — the agent turn failed"
      : "COMPLETED — agent finished a turn";
    break;
  }
}
await page.screenshot({ path: "/tmp/agent-probe.png", fullPage: true });
console.log("VERDICT:", verdict);
console.log("--- agent-chat/engine responses ---");
console.log(runs.length ? runs.join("\n") : "(none observed)");
console.log("--- page text (tail) ---");
const text = await page.locator("body").innerText();
console.log(text.slice(-700));
await browser.close();
