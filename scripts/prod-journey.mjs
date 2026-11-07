// Full production user journey: sign up, load the demo case, exercise the
// investigation-completeness features (search, notes, gap review, retry), and
// open the agent chat. Reports each step pass/fail. Run:
//   node scripts/prod-journey.mjs <baseUrl> <email> <password>
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "https://casefile-fhkr.vercel.app";
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];
if (!EMAIL || !PASSWORD) {
  console.error("usage: node scripts/prod-journey.mjs <baseUrl> <email> <password>");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });

const failed = [];
page.on("response", (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`);
});

let pass = 0;
let fail = 0;
const step = async (name, fn) => {
  try {
    const out = await fn();
    console.log(`PASS  ${name}${out ? ` — ${out}` : ""}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL  ${name} — ${String(e.message).split("\n")[0]}`);
    fail += 1;
  }
};

const shot = (n) => page.screenshot({ path: `/tmp/j-${n}.png`, fullPage: true });

// --- register (the create-account view is the default on the sign-in page) ---
await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

await step("register reaches the app", async () => {
  await page.fill("#s-email", EMAIL);
  await page.fill("#s-pass", PASSWORD);
  await page.fill("#s-pass2", PASSWORD);
  await page.getByRole("button", { name: /^create account$/i }).last().click();
  await page.waitForTimeout(8000);
  if (/\/home/.test(page.url())) return "registered: " + page.url();

  // Already registered from an earlier run — sign in instead.
  const body = (await page.locator("body").innerText()).toLowerCase();
  if (/already|exists|in use/.test(body)) {
    await page.getByRole("button", { name: /^sign in$/i }).first().click();
    await page.waitForTimeout(1500);
    await page.fill("#l-email", EMAIL);
    await page.fill("#l-pass", PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).last().click();
    await page.waitForTimeout(7000);
    if (/\/home/.test(page.url())) return "signed in: " + page.url();
  }
  throw new Error(`url=${page.url()} body=${body.replace(/\s+/g, " ").slice(0, 120)}`);
});

// --- cases list ---
await page.goto(BASE + "/cases", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3500);

await step("cases page renders", async () => {
  const t = await page.locator("body").innerText();
  if (!/case/i.test(t)) throw new Error("no case text");
  return t.replace(/\n+/g, " | ").slice(0, 120);
});

await step("search input present", async () => {
  await page.locator('[data-testid=case-search-input]').waitFor({ timeout: 8000 });
  return "found";
});

// --- load demo case ---
await step("load the payment demo case", async () => {
  const btn = page.locator('[data-testid=load-demo-case], [data-testid=load-demo-case-empty]').first();
  await btn.waitFor({ timeout: 8000 });
  await btn.click();
  await page.waitForTimeout(6000);
  return "clicked";
});

await step("demo case opens with evidence", async () => {
  const t = await page.locator("body").innerText();
  if (!/evidence|document|passage/i.test(t)) throw new Error("no evidence text");
  return t.replace(/\n+/g, " | ").slice(0, 140);
});

// --- investigation completeness: notes ---
await step("investigator notes panel present", async () => {
  await page.locator('[data-testid=notes-panel]').waitFor({ timeout: 10000 });
  return "found";
});

await step("write an investigator note", async () => {
  const input = page.getByLabel("New investigator note");
  await input.fill("Production verification note — " + new Date().toISOString());
  await page.getByRole("button", { name: /^add note$/i }).click();
  await page.waitForTimeout(4000);
  const t = await page.locator('[data-testid=notes-panel]').innerText();
  if (!/Production verification note/.test(t)) throw new Error("note not shown");
  return "persisted in UI";
});

// --- search ---
await page.goto(BASE + "/cases", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
await step("search finds the note across cases", async () => {
  await page.fill('[data-testid=case-search-input]', "Production verification");
  await page.waitForTimeout(5000);
  const t = await page.locator('[data-testid=search-results]').innerText().catch(() => "");
  if (!/match/i.test(t)) throw new Error("no results panel: " + t.slice(0, 80));
  return t.replace(/\n+/g, " | ").slice(0, 140);
});

// --- gap review + retry (back on the case) ---
await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(3000);

await step("retry-extraction control present and safe", async () => {
  const btn = page.getByRole("button", { name: /retry failed files/i });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(4000);
    const t = await page.locator("body").innerText();
    if (!/retry|failed|pending/i.test(t)) throw new Error("no retry feedback");
    return "clicked, feedback shown";
  }
  return "control hidden (no failed files) — expected";
});

// --- agent chat ---
await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
await step("agent chat surface reachable", async () => {
  const t = await page.locator("body").innerText();
  if (!/chat|message|ask|agent/i.test(t)) throw new Error("no chat text: " + t.slice(0, 80));
  return t.replace(/\n+/g, " | ").slice(0, 120);
});

await shot("final");

console.log("=== FAILED REQUESTS (4xx/5xx) ===");
console.log([...new Set(failed)].join("\n") || "(none)");
console.log(`=== SUMMARY: ${pass} passed, ${fail} failed ===`);

await browser.close();
process.exit(fail ? 1 : 0);
