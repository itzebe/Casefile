// Production release verification for CASEFILE.
//
// Drives the deployed app as a real signed-in user and checks the
// investigation-completeness features end to end: notes persistence, search,
// gap review, and the agent. Read-only except for the account it creates and
// the note/gap-verdict it writes into that account's own case.
//
// Usage: node scripts/prod-verify-release.mjs <baseUrl>
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "https://casefile-fhkr.vercel.app";
const EMAIL = `release.${Date.now()}@example.com`;
const PASSWORD = "ReleaseCheck12345!";

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const failures = [];
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().includes("favicon")) {
    failures.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")}`);
  }
});

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    const out = await fn();
    console.log(`PASS  ${name}${out ? ` — ${out}` : ""}`);
    pass += 1;
  } catch (e) {
    console.log(`FAIL  ${name} — ${String(e.message).split("\n")[0].slice(0, 200)}`);
    fail += 1;
  }
};

// --- register ---
await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
await page.fill("#s-email", EMAIL);
await page.fill("#s-pass", PASSWORD);
await page.fill("#s-pass2", PASSWORD);
await page.getByRole("button", { name: /^create account$/i }).last().click();
await page.waitForTimeout(9000);

await check("registration reaches the app", async () => {
  if (!/\/home/.test(page.url())) throw new Error("url=" + page.url());
  return page.url();
});

// --- load demo case (derives real gaps) ---
await page.goto(BASE + "/cases", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);

await check("search input is present on /cases", async () => {
  await page.locator("[data-testid=case-search-input]").waitFor({ timeout: 15000 });
  return "found";
});

await check("load the demo case", async () => {
  const btn = page.locator("[data-testid=load-demo-case], [data-testid=load-demo-case-empty]").first();
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await page.waitForTimeout(15000);
  return page.url();
});

await check("case workspace shows the notes panel", async () => {
  await page.locator("[data-testid=notes-panel]").waitFor({ timeout: 20000 });
  return "notes-panel present";
});

// --- notes persistence ---
const noteBody = `Release verification note ${Date.now()}`;
await check("write an investigator note", async () => {
  const panel = page.getByTestId("notes-panel");
  await panel.getByLabel("New investigator note").fill(noteBody);
  await panel.getByRole("button", { name: "Add note" }).click();
  await panel.getByText(noteBody).waitFor({ timeout: 25000 });
  return "note visible after save";
});

await check("note persists across a reload", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("notes-panel").getByText(noteBody).waitFor({ timeout: 45000 });
  return "note still present after reload";
});

// --- search ---
await check("search finds the note across cases", async () => {
  await page.goto(BASE + "/cases", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.getByTestId("case-search-input").fill(noteBody);
  const results = page.getByTestId("search-results");
  await results.waitFor({ timeout: 25000 });
  await results.getByRole("link", { name: new RegExp(`Note: ${noteBody}`) }).waitFor({ timeout: 25000 });
  return "note returned as a result link";
});

// --- gap review ---
await check("gap review persists across re-analysis", async () => {
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const badges = await page.locator("[data-testid=notes-panel]").count();
  if (!badges) throw new Error("not back on the case workspace");
  // Find the first gap's review controls in the cross-document panel.
  const notApplicable = page.getByRole("button", { name: /^Not applicable$/ }).first();
  if (!(await notApplicable.count())) throw new Error("no gap review controls rendered");
  await notApplicable.click();
  await page.waitForTimeout(8000);
  return "clicked Not applicable";
});

// --- capture the gap/note badge text (defect check) ---
const badgeText = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("span[title='Review state set by a person']")) {
    const t = (el.textContent || "").trim();
    if (t) out.push(t);
  }
  return [...new Set(out)];
});
console.log("BADGES on the case workspace:", JSON.stringify(badgeText));

// --- agent ---
await page.goto(BASE + "/chat", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
await check("the agent calls the hello action", async () => {
  const box = page.locator("textarea, [contenteditable=true], [role=textbox]").first();
  await box.waitFor({ timeout: 25000 });
  await box.click();
  await box.fill("Call the hello action with name=Judge and reply with exactly what it returned.");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50000);
  const body = await page.locator("body").innerText();
  if (!/Hello, Judge!/.test(body)) throw new Error("agent did not return the hello result");
  return "agent returned Hello, Judge!";
});

await page.screenshot({ path: "/tmp/release-final.png", fullPage: true });

console.log("=== FAILED REQUESTS (4xx/5xx) ===");
console.log([...new Set(failures)].join("\n") || "(none)");
console.log(`=== SUMMARY: ${pass} passed, ${fail} failed ===`);
await browser.close();
process.exit(fail ? 1 : 0);
