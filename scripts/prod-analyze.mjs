// Verify the model-dependent beats now that the agent model works:
// load the payment demo, run analyze-evidence, and report contradictions.
// Usage: node scripts/prod-analyze.mjs <baseUrl> <email> <password>
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "https://casefile-fhkr.vercel.app";
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];
if (!EMAIL || !PASSWORD) {
  console.error("usage: node scripts/prod-analyze.mjs <baseUrl> <email> <password>");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.fill("#s-email", EMAIL);
await page.fill("#s-pass", PASSWORD);
await page.fill("#s-pass2", PASSWORD);
await page.getByRole("button", { name: /^create account$/i }).last().click();
await page.waitForTimeout(9000);

const call = (path, body) =>
  page.evaluate(
    async ([base, p, b]) => {
      const res = await fetch(`${base}/_agent-native/actions/${p}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b ?? {}),
      });
      return { status: res.status, body: (await res.text()).slice(0, 4000) };
    },
    [BASE, path, body ?? null],
  );

const load = await call("load-demo-case", { scenario: "payment" });
console.log("load-demo-case:", load.status, load.body.slice(0, 300));
const caseId = (load.body.match(/"caseId":"([^"]+)"/) ?? [])[1];
console.log("caseId:", caseId);

const an = await call("analyze-evidence", caseId ? { caseId } : {});
console.log("analyze-evidence:", an.status, an.body.slice(0, 1500));

await page.goto(`${BASE}/cases/${caseId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(12000);
await page.screenshot({ path: "/tmp/analyze-case.png", fullPage: true });

// Look for the contradiction surfaced in the UI, and for the reference itself.
const text = await page.locator("body").innerText();
const hasRef = /RRF-?55210/.test(text);
const hasContradiction = /contradict/i.test(text);
console.log("UI shows RRF-55210:", hasRef);
console.log("UI shows a contradiction:", hasContradiction);
const excerpt = text.split("\n").filter((l) => /contradict|RRF|conflict/i.test(l)).slice(0, 12);
console.log("matching lines:");
console.log(excerpt.join("\n") || "(none)");
await browser.close();
