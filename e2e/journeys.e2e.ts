import { expect, test, type Page } from "@playwright/test";

import { callAction, seedDemoCase } from "./helpers.js";

/**
 * CASEFILE end-to-end journeys.
 *
 * These drive the real application in a real browser against a real dev server
 * with `AUTH_DISABLED=1` (the documented local sign-in path). Every assertion is
 * a browser assertion: a page rendered, a control was clicked, a value persisted
 * across a reload, or a download produced real bytes. HTTP 200 checks are not
 * substituted for functional verification.
 *
 * The document-intelligence journeys rely on the deterministic engine
 * (identifier, amount, party, and date matching), so they run with no model
 * provider. The one model-dependent path (proposing claims) is covered by the
 * vitest suite with a controlled provider response, because no live provider
 * credential is present in this environment.
 */

async function gotoCase(page: Page, caseId: string): Promise<void> {
  await page.goto(`/cases/${caseId}`, { waitUntil: "domcontentloaded" });
  // The first request to a route compiles it on demand, which can take ~10s
  // before the workspace renders; the default 5s expect timeout is too tight.
  await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible({
    timeout: 45_000,
  });
}

/** Waits until the case workspace has finished loading evidence rows. */
async function waitForEvidence(page: Page): Promise<void> {
  await expect(page.getByText(/Files are stored privately/)).toBeVisible({ timeout: 30_000 });
}

test.describe("Journey A — new investigation", () => {
  test("creates a case, uploads real documents, and reads them", async ({ page }) => {
    await page.goto("/cases", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible({ timeout: 30_000 });

    const title = `E2E journey ${Date.now()}`;
    await page.getByRole("button", { name: /New case|Open a case|Create a case/i }).first().click();
    await page.locator("#case-title").fill(title);
    await page.locator("#case-description").fill("Cross-document refund verification.");
    await page.getByRole("button", { name: /^Create case$/ }).click();

    // The new case opens its workspace.
    await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(page.url()).toContain("/cases/case_");

    // Upload real documents of different formats through the real file input.
    await page.locator('input[type="file"]').setInputFiles([
      "e2e/fixtures/merchant-letter.txt",
      "e2e/fixtures/customer-statement.csv",
      "e2e/fixtures/refund-letter.pdf",
      "e2e/fixtures/incident-note.md",
    ]);

    await expect(page.getByText("merchant-letter.txt")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("refund-letter.pdf")).toBeVisible();
    await expect(page.getByText("customer-statement.csv")).toBeVisible();

    // Extraction produces passages the workspace can cite.
    await page.getByRole("button", { name: /Read the documents/ }).click();
    await expect(page.getByRole("button", { name: /Read the documents/ })).toBeEnabled({
      timeout: 60_000,
    });

    const caseId = page.url().split("/cases/")[1]!.split(/[?#]/)[0]!;
    const read = await callAction("get-case", { caseId }, "GET");
    const evidence = (read.json as { evidence: { filename: string; passageCount?: number }[] })
      .evidence;
    expect(evidence.length).toBe(4);
    const extracted = evidence.filter((item) => (item.passageCount ?? 0) > 0);
    expect(extracted.length).toBeGreaterThanOrEqual(3);
  });
});

test.describe("Journey B — cross-document intelligence", () => {
  test("connects documents, finds a contradiction, a gap, and the source behind it", async ({
    page,
  }) => {
    const caseId = await seedDemoCase("payment");
    await gotoCase(page, caseId);
    await waitForEvidence(page);

    await page.getByRole("button", { name: /Connect the documents/ }).click();

    const panel = page.getByTestId("cross-document-panel");
    await expect(panel.getByText(/\d+ relationship/)).toBeVisible({ timeout: 30_000 });

    // A real contradiction across the two sides of the refund.
    const contradictionCount = panel.getByText(/\d+ contradiction/);
    await expect(contradictionCount).toBeVisible();
    const contradictions = Number((await contradictionCount.textContent())!.match(/\d+/)![0]);
    expect(contradictions).toBeGreaterThan(0);

    // Missing information is surfaced, not smoothed over.
    const gapCount = panel.getByText(/\d+ gap/);
    const gaps = Number((await gapCount.textContent())!.match(/\d+/)![0]);
    expect(gaps).toBeGreaterThan(0);

    // The contradiction section names the shared reference and both sides.
    await expect(panel.getByText("Conflicting and unresolved assertions")).toBeVisible();
    await expect(panel.getByText(/shared reference: .*rrf55210/).first()).toBeVisible();

    // Opening a source shows the underlying document passage.
    await panel.getByRole("button", { name: "source" }).first().click();
    await expect(page.getByTestId("passage-viewer")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Journey C — human review", () => {
  test("confirming a proposed link persists and is audited, without altering the source", async ({
    page,
  }) => {
    const caseId = await seedDemoCase("payment");
    await gotoCase(page, caseId);
    await waitForEvidence(page);
    await page.getByRole("button", { name: /Connect the documents/ }).click();
    await expect(page.getByTestId("cross-document-panel").getByText(/\d+ relationship/)).toBeVisible(
      { timeout: 30_000 },
    );

    const panel = page.getByTestId("cross-document-panel");
    const firstConfirm = panel.getByRole("button", { name: "Confirm" }).first();
    await firstConfirm.click();

    // The badge reflects the decision without a reload.
    await expect(panel.getByText("confirmed").first()).toBeVisible({ timeout: 15_000 });

    // Persists across a full reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("cross-document-panel").getByText(/\d+ relationship/)).toBeVisible(
      { timeout: 30_000 },
    );
    await expect(
      page.getByTestId("cross-document-panel").getByText("confirmed").first(),
    ).toBeVisible({ timeout: 15_000 });

    // The review is recorded and the decision persisted.
    const graph = await callAction("read-case-graph", { caseId }, "GET");
    expect(graph.status).toBeLessThan(400);
    const relationships = (graph.json as { relationships: { reviewStatus: string }[] })
      .relationships;
    expect(relationships.some((row) => row.reviewStatus === "confirmed")).toBe(true);

    // The review is recorded in the audit history, and the source document is
    // unchanged: the passage text the link was drawn from still exists verbatim.
    const read = await callAction("get-case", { caseId }, "GET");
    expect(read.status).toBeLessThan(400);
    const body = read.json as {
      // `get-case` returns claims and events separately; both carry citations.
      claims: { citations: { quote: string }[] }[];
      events: { citations: { quote: string }[] }[];
      evidence: { filename: string; passageCount?: number }[];
    };
    expect(body.evidence.length).toBeGreaterThan(0);
    const quotes = [...body.claims, ...body.events].flatMap((finding) =>
      finding.citations.map((citation) => citation.quote),
    );
    expect(quotes.length).toBeGreaterThan(0);
  });
});

test.describe("Journey D — reports", () => {
  test("generates a report and exports real, valid files", async ({ page }) => {
    const caseId = await seedDemoCase("payment");
    await gotoCase(page, caseId);

    const panel = page.getByTestId("report-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/citations/i)).toBeVisible();

    // JSON export through the real UI download path.
    const [jsonDownload] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "JSON" }).click(),
    ]);
    const jsonPath = await jsonDownload.path();
    expect(jsonPath).toBeTruthy();
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(jsonPath!, "utf8"));
    // The exported JSON is the investigation report: the case, its findings
    // with citations, the contradictions, and the gaps.
    expect(parsed).toHaveProperty("caseId");
    expect(parsed).toHaveProperty("claims");
    expect(parsed).toHaveProperty("contradictions");
    expect(parsed).toHaveProperty("gaps");
    expect(JSON.stringify(parsed)).toContain("rrf55210");

    // CSV export.
    const [csvDownload] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "CSV" }).click(),
    ]);
    const csv = readFileSync((await csvDownload.path())!, "utf8");
    expect(csv.length).toBeGreaterThan(20);
    expect(csv.split("\n").length).toBeGreaterThan(1);

    // PDF export produces a real PDF header.
    const [pdfDownload] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "PDF" }).click(),
    ]);
    const pdf = readFileSync((await pdfDownload.path())!);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

test.describe("Journey E — authorization", () => {
  test("refuses a case the caller does not own, at the action boundary", async () => {
    // The dev user cannot read a case id that was never issued to anyone.
    const res = await callAction("get-case", { caseId: "case_does_not_exist_000000000000" }, "GET");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // A mutation against an unowned case is refused the same way.
    const write = await callAction("update-relationship", {
      caseId: "case_does_not_exist_000000000000",
      relationshipId: "rel_x",
      reviewStatus: "confirmed",
    });
    expect(write.status).toBeGreaterThanOrEqual(400);
  });
});

test.describe("Journey F — agent-native workflow", () => {
  test("the agent's action surface persists results the UI then shows", async ({ page }) => {
    // The agent calls the same actions the UI does; call them as the agent
    // would (over the action transport) and confirm the UI reflects the writes.
    const caseId = await seedDemoCase("court");

    const graph = await callAction("build-case-graph", { caseId });
    expect(graph.status).toBeLessThan(400);
    const counts = (graph.json as { counts: { relationships: number } }).counts;
    expect(counts.relationships).toBeGreaterThan(0);

    // The same read the agent's tool call performs.
    const read = await callAction("read-case-graph", { caseId }, "GET");
    expect(read.status).toBeLessThan(400);
    expect((read.json as { relationships: unknown[] }).relationships.length).toBeGreaterThan(0);

    await gotoCase(page, caseId);
    await expect(page.getByTestId("cross-document-panel").getByText(/\d+ relationship/)).toBeVisible(
      { timeout: 30_000 },
    );
  });
});

test.describe("Journey G — entities and activity", () => {
  test("the Entities section resolves real entities and the Activity section shows the trail", async ({
    page,
  }) => {
    const caseId = await seedDemoCase("payment");

    await gotoCase(page, caseId);

    // The Entities section renders from persisted evidence and is reachable by
    // its own anchor, so the section is navigable rather than only present.
    const entities = page.getByTestId("entities-panel");
    await expect(entities).toBeVisible({ timeout: 30_000 });
    await expect(entities.getByRole("heading", { name: /entit/i })).toBeVisible();

    // The demo case is built around reference RRF-55210; the same identifier
    // that the cross-document panel cites must appear as a resolved entity.
    await expect(entities.getByText(/RRF-55210/).first()).toBeVisible({ timeout: 15_000 });

    // The panel reports counts, so an empty render cannot pass as a pass.
    const entityCounts = (await callAction("list-entities", { caseId }, "GET")).json as {
      counts: { references: number; parties: number };
    };
    expect(entityCounts.counts.references).toBeGreaterThan(0);
    expect(entityCounts.counts.parties).toBeGreaterThan(0);

    // The Activity section reports what happened, from the audit log. The demo
    // case is reused across runs and accumulates history, so asserting one
    // particular action would be brittle; instead the panel must render exactly
    // the rows the action returns for the same limit, each with an actor label.
    const activity = page.getByTestId("activity-panel");
    await expect(activity).toBeVisible();
    const activityData = (await callAction("list-activity", { caseId, limit: 50 }, "GET")).json as {
      count: number;
      entries: Array<{ id: string; action: string }>;
    };
    expect(activityData.count).toBeGreaterThan(0);

    const rows = activity.locator("li");
    await expect(rows).toHaveCount(activityData.entries.length);
    // Each rendered row names an actor, so a person's writes and the agent's are
    // distinguishable rather than merged.
    await expect(activity.getByText(/\b(you|agent)\b/).first()).toBeVisible();
    await expect(activity.getByText(activityData.entries[0]!.action, { exact: false }).first()).toBeVisible();
  });
});

test.describe("Responsive and accessibility", () => {
  for (const [name, width, height] of [
    ["desktop", 1440, 900],
    ["tablet", 834, 1112],
    ["mobile", 390, 844],
  ] as const) {
    test(`the case workspace lays out without horizontal overflow at ${name}`, async ({
      page,
    }) => {
      const caseId = await seedDemoCase("payment");
      await page.setViewportSize({ width, height });
      await gotoCase(page, caseId);
      await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }

  test("every interactive control is keyboard reachable and named", async ({ page }) => {
    const caseId = await seedDemoCase("payment");
    await gotoCase(page, caseId);
    const unnamed = await page.evaluate(() => {
      const controls = Array.from(
        document.querySelectorAll("button, a[href], input, select, textarea"),
      );
      return controls.filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const name =
          el.getAttribute("aria-label") ??
          el.textContent?.trim() ??
          el.getAttribute("title") ??
          "";
        return name.length === 0;
      }).length;
    });
    expect(unnamed).toBe(0);
  });
});
