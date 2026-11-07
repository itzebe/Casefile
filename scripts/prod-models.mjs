// List the models the configured provider exposes, through the app's own
// actions, using a real signed-in session. Metadata only — no model tokens.
// Usage: node scripts/prod-models.mjs <baseUrl> <email> <password>
import { chromium } from "playwright-core";

const BASE = process.argv[2] ?? "https://casefile-fhkr.vercel.app";
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];
if (!EMAIL || !PASSWORD) {
  console.error("usage: node scripts/prod-models.mjs <baseUrl> <email> <password>");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
await page.fill("#s-email", EMAIL);
await page.fill("#s-pass", PASSWORD);
await page.fill("#s-pass2", PASSWORD);
await page.getByRole("button", { name: /^create account$/i }).last().click();
await page.waitForTimeout(9000);

const call = (path, method = "GET", body) =>
  page.evaluate(
    async ([base, p, m, b]) => {
      const res = await fetch(`${base}/_agent-native/actions/${p}`, {
        method: m,
        credentials: "include",
        ...(b
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(b) }
          : {}),
      });
      return { status: res.status, body: (await res.text()).slice(0, 60000) };
    },
    [BASE, path, method, body ?? null],
  );

for (const p of ["list-model-providers", "get-provider-models"]) {
  const r = await call(p);
  console.log(`\n=== ${p} -> ${r.status} ===`);
  try {
    const parsed = JSON.parse(r.body);
    const groq = parsed.providers?.find((x) => x.provider === "groq");
    console.log(groq ? JSON.stringify(groq, null, 1) : JSON.stringify(parsed).slice(0, 1200));
  } catch {
    console.log(r.body);
  }
}
await browser.close();
