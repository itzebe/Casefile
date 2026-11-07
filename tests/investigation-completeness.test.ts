import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  callAction,
  getDb,
  resetCasefileTables,
  schema,
  setupTestDatabase,
  userContext,
} from "./helpers/harness.js";
import { RECEIPT_TEXT, STATEMENT_CSV, csvBytes, textBytes } from "./fixtures/evidence.js";

/**
 * Investigation completeness: investigator notes, evidence-gap review, search,
 * and extraction retry.
 *
 * These exercise the real action layer against the real database, so ownership
 * scoping, validation and persistence are tested as shipped.
 */

const OWNER = "owner@example.com";
const OTHER = "intruder@example.com";

async function seedCase(owner = OWNER): Promise<string> {
  const created = await callAction<{ id: string }>(
    "create-case",
    { title: "Notes and gaps", description: "seed", category: "payment-dispute" },
    userContext(owner),
  );
  await callAction(
    "upload-evidence",
    {
      caseId: created.id,
      filename: "receipt.txt",
      dataBase64: Buffer.from(textBytes(RECEIPT_TEXT)).toString("base64"),
      category: "receipt",
    },
    userContext(owner),
  );
  await callAction(
    "upload-evidence",
    {
      caseId: created.id,
      filename: "statement.csv",
      dataBase64: Buffer.from(csvBytes(STATEMENT_CSV)).toString("base64"),
      category: "bank-statement",
    },
    userContext(owner),
  );
  await callAction("extract-evidence", { caseId: created.id }, userContext(owner));
  return created.id;
}

describe("investigation notes", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("creates, lists and edits a note, attributed to the caller", async () => {
    const caseId = await seedCase();

    const created = await callAction<{ id: string; created: boolean }>(
      "update-note",
      { caseId, body: "Check the merchant's delivery claim against the courier record." },
      userContext(OWNER),
    );
    expect(created.created).toBe(true);

    const listed = await callAction<{
      notes: Array<{ id: string; body: string; editedBy: string | null }>;
      count: number;
    }>("list-notes", { caseId }, userContext(OWNER));
    expect(listed.count).toBe(1);
    expect(listed.notes[0]?.body).toContain("courier record");
    // A new note has not been edited yet.
    expect(listed.notes[0]?.editedBy).toBeNull();

    await callAction(
      "update-note",
      { caseId, noteId: created.id, body: "Courier record obtained.", status: "resolved" },
      userContext(OWNER),
    );

    const after = await callAction<{
      notes: Array<{ body: string; status: string; editedBy: string | null; editedAt: string | null }>;
    }>("list-notes", { caseId }, userContext(OWNER));
    expect(after.notes[0]?.body).toBe("Courier record obtained.");
    expect(after.notes[0]?.status).toBe("resolved");
    // An edit is attributable.
    expect(after.notes[0]?.editedBy).toBe(OWNER);
    expect(after.notes[0]?.editedAt).not.toBeNull();
  });

  it("refuses a note on a finding from another case", async () => {
    const caseA = await seedCase();
    const caseB = await seedCase();
    // Give case B a finding to anchor to.
    const db = getDb();
    await db.insert(schema.findings).values({
      id: "find_other",
      caseId: caseB,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "A claim in case B.",
      provenance: "asserted",
    });

    await expect(
      callAction(
        "update-note",
        { caseId: caseA, body: "anchor", findingId: "find_other" },
        userContext(OWNER),
      ),
    ).rejects.toThrow(/Finding not found/i);
  });

  it("does not expose another user's notes", async () => {
    const caseId = await seedCase();
    await callAction("update-note", { caseId, body: "Private note." }, userContext(OWNER));

    await expect(
      callAction("list-notes", { caseId }, userContext(OTHER)),
    ).rejects.toThrow(/not found/i);
  });
});

describe("evidence-gap review", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("records a verdict against a real gap and survives re-analysis", async () => {
    const caseId = await seedCase();
    await callAction("build-case-graph", { caseId, persist: true }, userContext(OWNER));

    const gaps = await callAction<{
      gaps: Array<{ gapKey: string; kind: string; reviewStatus: string }>;
      counts: { total: number; open: number; reviewed: number };
    }>("list-evidence-gaps", { caseId }, userContext(OWNER));

    // With only an extract (no analysis) there are no findings, so seed a gap
    // directly by adding an unsupported finding.
    const db = getDb();
    await db.insert(schema.findings).values({
      id: "find_unsupported",
      caseId,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "An assertion with no cited source at all.",
      provenance: "asserted",
    });

    const withGap = await callAction<{
      gaps: Array<{ gapKey: string; kind: string; reviewStatus: string }>;
      counts: { total: number; open: number; reviewed: number };
    }>("list-evidence-gaps", { caseId }, userContext(OWNER));
    expect(withGap.counts.total).toBeGreaterThan(gaps.counts.total);
    const unsupported = withGap.gaps.find((gap) => gap.kind === "unsupported_claim");
    expect(unsupported).toBeDefined();
    expect(unsupported?.reviewStatus).toBe("open");

    await callAction(
      "review-gap",
      { caseId, gapKey: unsupported!.gapKey, status: "not_applicable", note: "Not in scope." },
      userContext(OWNER),
    );

    const reviewed = await callAction<{
      gaps: Array<{ gapKey: string; reviewStatus: string; reviewNote: string | null; reviewedBy: string | null }>;
      counts: { reviewed: number };
    }>("list-evidence-gaps", { caseId }, userContext(OWNER));
    const updated = reviewed.gaps.find((gap) => gap.gapKey === unsupported!.gapKey);
    expect(updated?.reviewStatus).toBe("not_applicable");
    expect(updated?.reviewNote).toBe("Not in scope.");
    expect(updated?.reviewedBy).toBe(OWNER);
    expect(reviewed.counts.reviewed).toBe(1);

    // Re-analysis recomputes the gaps; the verdict must persist.
    await callAction("build-case-graph", { caseId, persist: true }, userContext(OWNER));
    const after = await callAction<{
      gaps: Array<{ gapKey: string; reviewStatus: string }>;
    }>("list-evidence-gaps", { caseId }, userContext(OWNER));
    expect(after.gaps.find((gap) => gap.gapKey === unsupported!.gapKey)?.reviewStatus).toBe(
      "not_applicable",
    );
  });

  it("rejects a verdict for a gap that does not exist", async () => {
    const caseId = await seedCase();
    await expect(
      callAction(
        "review-gap",
        { caseId, gapKey: "unsupported_claim:does-not-exist", status: "resolved" },
        userContext(OWNER),
      ),
    ).rejects.toThrow(/No such evidence gap/i);
  });

  it("keeps one verdict per gap (a second review updates, not duplicates)", async () => {
    const caseId = await seedCase();
    const db = getDb();
    await db.insert(schema.findings).values({
      id: "find_unsupported",
      caseId,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "Another uncited assertion.",
      provenance: "asserted",
    });
    const listed = await callAction<{ gaps: Array<{ gapKey: string; kind: string }> }>(
      "list-evidence-gaps",
      { caseId },
      userContext(OWNER),
    );
    const key = listed.gaps.find((gap) => gap.kind === "unsupported_claim")!.gapKey;

    await callAction("review-gap", { caseId, gapKey: key, status: "resolved" }, userContext(OWNER));
    await callAction("review-gap", { caseId, gapKey: key, status: "unresolved" }, userContext(OWNER));

    const rows = await db.select().from(schema.gapReviews);
    expect(rows.filter((row) => row.gapKey === key)).toHaveLength(1);
    expect(rows.find((row) => row.gapKey === key)?.status).toBe("unresolved");
  });
});

describe("search-case", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("finds passages, documents and cases, scoped to the owner", async () => {
    const caseId = await seedCase();

    const byPassage = await callAction<{
      results: { passages?: Array<{ evidenceId: string; ref: string }> };
      total: number;
    }>("search-case", { query: "Northwind", caseId }, userContext(OWNER));
    expect((byPassage.results.passages ?? []).length).toBeGreaterThan(0);
    expect(byPassage.results.passages?.[0]?.evidenceId).toBeTruthy();

    const byDocument = await callAction<{
      results: { documents?: Array<{ filename: string }> };
    }>("search-case", { query: "statement", caseId }, userContext(OWNER));
    expect((byDocument.results.documents ?? []).some((d) => d.filename === "statement.csv")).toBe(
      true,
    );

    const byCase = await callAction<{ results: { cases?: Array<{ id: string }> } }>(
      "search-case",
      { query: "Notes and gaps" },
      userContext(OWNER),
    );
    expect((byCase.results.cases ?? []).some((c) => c.id === caseId)).toBe(true);
  });

  it("does not leak another user's case through search", async () => {
    const caseId = await seedCase(OWNER);
    // The other user searching for the same term must not see the owner's data.
    const foreign = await callAction<{ total: number }>(
      "search-case",
      { query: "Northwind" },
      userContext(OTHER),
    );
    expect(foreign.total).toBe(0);

    // And naming the case directly is a not-found, not an empty result.
    await expect(
      callAction("search-case", { query: "Northwind", caseId }, userContext(OTHER)),
    ).rejects.toThrow(/not found/i);
  });
});

describe("retry-extraction", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("retries a failed file and leaves completed files alone", async () => {
    const caseId = await seedCase();
    const db = getDb();

    // Force one file into a failed state, as a transient failure would.
    await db
      .update(schema.evidence)
      .set({ extractionStatus: "failed", extractionError: "transient read error" })
      .where(eq(schema.evidence.filename, "receipt.txt"));

    const result = await callAction<{
      retried: number;
      summary: { complete: number; failed: number };
      results: Array<{ filename: string; status: string }>;
    }>("retry-extraction", { caseId }, userContext(OWNER));

    expect(result.retried).toBe(1);
    expect(result.results.map((r) => r.filename)).toEqual(["receipt.txt"]);
    expect(result.results[0]?.status).toBe("complete");
  });

  it("reports nothing to retry when every file is complete", async () => {
    const caseId = await seedCase();
    const result = await callAction<{ retried: number; note?: string }>(
      "retry-extraction",
      { caseId },
      userContext(OWNER),
    );
    expect(result.retried).toBe(0);
    expect(result.note).toMatch(/No failed or pending/i);
  });
});
