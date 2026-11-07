// Verify the "hello" action through a real authenticated session — the same
// endpoint the UI and the agent both call — and report the agent-engine state.
// Usage: node scripts/prod-hello.mjs <baseUrl> <email> <password>
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "https://casefile-fhkr.vercel.app";
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];
if (!EMAIL || !PASSWORD) {
  console.error("usage: node scripts/prod-hello.mjs <baseUrl> <email> <password>");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.fill("#s-email", EMAIL);
await page.fill("#s-pass", PASSWORD);
await page.fill("#s-pass2", PASSWORD);
await page.getByRole("button", { name: /^create account$/i }).last().click();
await page.waitForTimeout(8000);
console.log("signed in:", /\/home/.test(page.url()), page.url());

// The UI and the agent both reach an action over this route; calling it with
// the session cookie proves the action is invocable for a real caller.
const hello = await page.evaluate(async (base) => {
  const res = await fetch(`${base}/_agent-native/actions/hello?name=Judge`, {
    credentials: "include",
  });
  return { status: res.status, body: await res.text() };
}, BASE);
console.log("hello action:", hello.status, hello.body);

const engine = await page.evaluate(async (base) => {
  const res = await fetch(`${base}/_agent-native/agent-engine/status`, { credentials: "include" });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}, BASE);
console.log("agent engine:", engine.status, engine.body);

const caps = await page.evaluate(async (base) => {
  const res = await fetch(`${base}/_agent-native/agent-chat/capabilities`, {
    credentials: "include",
  });
  return { status: res.status, body: (await res.text()).slice(0, 200) };
}, BASE);
console.log("chat capabilities:", caps.status, caps.body);

await browser.close();
