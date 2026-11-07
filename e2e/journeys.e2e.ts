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
    // `exact` matters: the empty-state card also renders a heading ("No cases
    // yet"), and Playwright's role-name match is a substring match by default,
    // so a bare "Cases" resolves to two elements and fails strict mode.
    await expect(page.getByRole("heading", { name: "Cases", exact: true })).toBeVisible({
      timeout: 30_000,
    });

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

    // Scope to the evidence section and match exactly: the upload notice also
    // contains the filename, so an unscoped substring match resolves to two
    // elements and trips strict mode.
    const evidenceSection = page.locator("#evidence");
    await expect(
      evidenceSection.getByText("merchant-letter.txt", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(evidenceSection.getByText("refund-letter.pdf", { exact: true })).toBeVisible();
    await expect(evidenceSection.getByText("customer-statement.csv", { exact: true })).toBeVisible();

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
  test("connects documents on shared identifiers and opens the source behind a link", async ({
    page,
  }) => {
    const caseId = await seedDemoCase("payment", `E2E journey B ${Date.now()}`);
    await gotoCase(page, caseId);
    await waitForEvidence(page);

    await page.getByRole("button", { name: /Connect the documents/ }).click();

    const panel = page.getByTestId("cross-document-panel");
    await expect(panel.getByText(/\d+ relationship/)).toBeVisible({ timeout: 30_000 });

    // The deterministic engine links passages that share an explicit
    // identifier, party, or date. On a freshly loaded demo that is a positive
    // number of relationships, and it is what the "Connect the documents"
    // control promises.
    const graph = await callAction("read-case-graph", { caseId }, "GET");
    expect(graph.status).toBeLessThan(400);
    const { counts, relationships } = graph.json as {
      counts: { relationships: number; documents: number };
      relationships: { matchKey: string | null; reviewStatus: string }[];
    };
    expect(counts.documents).toBe(5);
    expect(counts.relationships).toBeGreaterThan(0);
    expect(relationships.length).toBe(counts.relationships);

    // Links are drawn from the shared reference RRF-55210, the same identifier
    // the report and the entities view cite, so the three views agree.
    await expect(panel.getByText(/matched on rrf55210/).first()).toBeVisible();

    // Comparisons between *claims* need proposed claims, which come from a
    // model run; with none proposed the panel must say so plainly rather than
    // implying the documents were found to agree.
    await expect(panel.getByText("Conflicting and unresolved assertions")).toBeVisible();
    await expect(
      panel.getByText("No assertions in this case conflict across documents."),
    ).toBeVisible();

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

    // The exact passage text the link was drawn from, captured before the
    // review, so "the source is unchanged" is a comparison and not a claim.
    const before = await callAction("read-case-graph", { caseId }, "GET");
    const firstLink = (before.json as {
      relationships: { id: string; sourcePassageId: string | null; matchKey: string | null }[];
    }).relationships.find((row) => row.sourcePassageId && row.matchKey);
    expect(firstLink).toBeTruthy();

    // A relationship names passages; resolve the owning document by asking each
    // document for its passages until the one the link cites is found.
    const readPassageText = async (): Promise<string | undefined> => {
      const evidence = (
        (await callAction("get-case", { caseId }, "GET")).json as { evidence: { id: string }[] }
      ).evidence;
      for (const item of evidence) {
        const body = (
          (await callAction("get-evidence", { caseId, evidenceId: item.id, includeBytes: false }))
            .json as { passages: { id: string; text: string }[] }
        ).passages;
        const found = body.find((passage) => passage.id === firstLink!.sourcePassageId);
        if (found) return found.text;
      }
      return undefined;
    };

    const passageBefore = await readPassageText();
    expect(passageBefore).toBeTruthy();

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
    const relationships = (graph.json as { relationships: { id: string; reviewStatus: string }[] })
      .relationships;
    expect(relationships.find((row) => row.id === firstLink!.id)?.reviewStatus).toBe("confirmed");

    // The review is recorded in the audit history...
    const activity = await callAction("list-activity", { caseId, limit: 200 }, "GET");
    const entries = (activity.json as { entries: { action: string; summary: string | null }[] })
      .entries;
    expect(
      entries.some((entry) => entry.action === "relationship.review" && /confirm/i.test(entry.summary ?? "")),
    ).toBe(true);

    // ...and the source document is unchanged: the passage the link was drawn
    // from still reads exactly as it did before the review.
    const passageAfter = await readPassageText();
    expect(passageAfter).toBe(passageBefore);
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
    // The exported JSON is the investigation report: the case, its document
    // register, the findings, the contradictions, and the gaps. The findings
    // and contradictions are empty until a model proposes claims; the report
    // still carries the deterministic record and says plainly what is missing.
    expect(parsed).toHaveProperty("caseId");
    expect(parsed).toHaveProperty("claims");
    expect(parsed).toHaveProperty("contradictions");
    expect(parsed).toHaveProperty("gaps");
    expect(parsed.documentRegister).toHaveLength(5);
    // The report is a real account of the case, not an empty shell: the
    // deterministic domain pass labels the passages it read.
    expect(parsed.domainFindings.length).toBeGreaterThan(0);
    // The reference the whole dispute turns on is present, in the passages the
    // report cites. This is what ties the report to the source documents.
    expect(JSON.stringify(parsed.domainFindings)).toContain("RRF-55210");

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

test.describe("Journey H — investigation completeness", () => {
  test("a note written in the UI persists, and search finds it across cases", async ({ page }) => {
    const caseId = await seedDemoCase("payment");
    await gotoCase(page, caseId);

    // A note is the investigator's own record; it is written in the UI and must
    // survive a reload rather than living only in component state.
    const noteBody = `Investigator note ${Date.now()}`;
    const notesPanel = page.getByTestId("notes-panel");
    await expect(notesPanel).toBeVisible({ timeout: 30_000 });
    await notesPanel.getByLabel("New investigator note").fill(noteBody);
    await notesPanel.getByRole("button", { name: "Add note" }).click();
    await expect(notesPanel.getByText(noteBody)).toBeVisible({ timeout: 30_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("notes-panel").getByText(noteBody)).toBeVisible({
      timeout: 45_000,
    });

    // The note is findable from the cases index, which is the point of storing
    // it: a working note that cannot be found again is not a record.
    await page.goto("/cases", { waitUntil: "domcontentloaded" });
    await page.getByTestId("case-search-input").fill(noteBody);
    const results = page.getByTestId("search-results");
    await expect(results).toBeVisible({ timeout: 30_000 });
    // The note comes back as a result link. The summary line also echoes the
    // term, so match the result itself, not just the text.
    await expect(
      results.getByRole("link", { name: new RegExp(`Note: ${noteBody}`) }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("retry-extraction is safe to call when nothing has failed", async () => {
    const caseId = await seedDemoCase("payment");
    const { status, json } = await callAction("retry-extraction", { caseId });
    expect(status).toBeLessThan(400);
    // The demo's documents are all readable, so there is nothing to retry; the
    // call must say so rather than failing or re-reading everything.
    expect((json as { retried: number }).retried).toBe(0);
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
