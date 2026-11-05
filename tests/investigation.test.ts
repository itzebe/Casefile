import { beforeEach, describe, expect, it } from "vitest";

import {
  callAction,
  setupTestDatabase,
  userContext,
} from "./helpers/harness.js";
import {
  INJECTION_TEXT,
  RECEIPT_TEXT,
  STATEMENT_CSV,
  csvBytes,
  executableBytes,
  pdfBytes,
  pngBytes,
  textBytes,
  truncatedPng,
} from "./fixtures/evidence.js";

/**
 * End-to-end investigation flow through the real actions.
 *
 * These tests drive the same entry points the UI and the agent use, against a
 * real database, so a change that breaks the workflow fails here.
 */

const OWNER = "owner@example.com";

async function newCase(title = "Card dispute"): Promise<string> {
  const result = await callAction<{ id: string }>(
    "create-case",
    { title, description: "Disputed charge", category: "payment-dispute" },
    userContext(OWNER),
  );
  return result.id;
}

async function upload(
  caseId: string,
  filename: string,
  data: Uint8Array,
  category = "receipt",
): Promise<{ evidenceId?: string; duplicate?: boolean; error?: string }> {
  return callAction(
    "upload-evidence",
    {
      caseId,
      filename,
      dataBase64: Buffer.from(data).toString("base64"),
      category,
    },
    userContext(OWNER),
  ).catch((error: Error) => ({ error: error.message }));
}

describe("case management", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("creates a case and lists it for its owner", async () => {
    const caseId = await newCase("Unauthorised card charge");
    const listed = await callAction<{ cases: Array<{ id: string; evidenceCount: number }> }>(
      "list-cases",
      {},
      userContext(OWNER),
    );
    expect(listed.cases.map((c) => c.id)).toContain(caseId);
    expect(listed.cases[0].evidenceCount).toBe(0);
  });

  it("does not show one user's case to another", async () => {
    await newCase("Private case");
    const other = await callAction<{ cases: unknown[] }>(
      "list-cases",
      {},
      userContext("intruder@example.com"),
    );
    expect(other.cases).toHaveLength(0);
  });

  it("refuses to read a case the caller does not own", async () => {
    const caseId = await newCase();
    await expect(
      callAction("get-case", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow(/not found/i);
  });

  it("updates a case and bumps its revision", async () => {
    const caseId = await newCase();
    const before = await callAction<{ case: { revision: number } }>(
      "get-case",
      { caseId },
      userContext(OWNER),
    );
    await callAction(
      "update-case",
      { caseId, status: "investigating", title: "Renamed case" },
      userContext(OWNER),
    );
    const after = await callAction<{ case: { revision: number; status: string; title: string } }>(
      "get-case",
      { caseId },
      userContext(OWNER),
    );
    expect(after.case.status).toBe("investigating");
    expect(after.case.title).toBe("Renamed case");
    expect(after.case.revision).toBeGreaterThan(before.case.revision);
  });

  it("archives a case without deleting its evidence", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await callAction("archive-case", { caseId }, userContext(OWNER));
    const detail = await callAction<{ case: { status: string }; evidence: unknown[] }>(
      "get-case",
      { caseId },
      userContext(OWNER),
    );
    expect(detail.case.status).toBe("closed");
    expect(detail.evidence).toHaveLength(1);
  });

  it("records an audit entry for each mutation", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    const rows = await getDb().select().from(schema.auditLog);
    expect(rows.some((row) => row.action === "case.create" && row.caseId === caseId)).toBe(true);
  });
});

describe("evidence ingestion", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("stores a text file privately and never returns a URL", async () => {
    const caseId = await newCase();
    const result = await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    expect(result.evidenceId).toBeDefined();
    expect(JSON.stringify(result)).not.toMatch(/https?:\/\//);
  });

  it("detects the type from bytes, not the declared name", async () => {
    const caseId = await newCase();
    // A PNG named .txt is still stored as an image.
    const result = await upload(caseId, "photo.txt", pngBytes(), "screenshot");
    expect(result.error).toBeUndefined();
    const listed = await callAction<{ evidence: Array<{ mimeType: string }> }>(
      "list-evidence",
      { caseId },
      userContext(OWNER),
    );
    expect(listed.evidence[0].mimeType).toBe("image/png");
  });

  it("rejects an unsupported file and stores nothing", async () => {
    const caseId = await newCase();
    const result = await upload(caseId, "virus.exe", executableBytes());
    expect(result.error).toMatch(/did not match any supported format/i);
    const listed = await callAction<{ evidence: unknown[] }>(
      "list-evidence",
      { caseId },
      userContext(OWNER),
    );
    expect(listed.evidence).toHaveLength(0);
  });

  it("stores an image, then reports it as not extractable with a reason", async () => {
    const caseId = await newCase();
    // The signature is valid, so the file is stored rather than rejected. There
    // is no OCR in this build, so extraction must say so and explain the
    // limitation instead of returning an empty document.
    const result = await upload(caseId, "photo.png", pngBytes(), "screenshot");
    expect(result.error).toBeUndefined();
    const extraction = await callAction<{
      results: Array<{ status: string; limitation?: string }>;
      summary: { unsupported: number; failed: number };
    }>("extract-evidence", { caseId }, userContext(OWNER));
    expect(extraction.summary.unsupported + extraction.summary.failed).toBe(1);
    expect(extraction.results[0].status).not.toBe("complete");
    expect(extraction.results[0].limitation ?? "").toMatch(/OCR|text/i);
  });

  it("rejects an empty file", async () => {
    const caseId = await newCase();
    const result = await upload(caseId, "empty.txt", new Uint8Array(0));
    expect(result.error).toMatch(/empty/i);
    const listed = await callAction<{ evidence: unknown[] }>(
      "list-evidence",
      { caseId },
      userContext(OWNER),
    );
    expect(listed.evidence).toHaveLength(0);
  });

  it("detects a duplicate within the same case", async () => {
    const caseId = await newCase();
    const first = await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    const second = await upload(caseId, "receipt-copy.txt", textBytes(RECEIPT_TEXT));
    expect(first.evidenceId).toBeDefined();
    expect(second.duplicate).toBe(true);
    expect(second.evidenceId).toBeUndefined();
  });

  it("allows the same file in two different cases", async () => {
    const a = await newCase("Case A");
    const b = await newCase("Case B");
    const first = await upload(a, "receipt.txt", textBytes(RECEIPT_TEXT));
    const second = await upload(b, "receipt.txt", textBytes(RECEIPT_TEXT));
    expect(first.evidenceId).toBeDefined();
    expect(second.evidenceId).toBeDefined();
  });

  it("refuses to upload into another user's case", async () => {
    const caseId = await newCase();
    const result = await callAction(
      "upload-evidence",
      {
        caseId,
        filename: "x.txt",
        dataBase64: Buffer.from(textBytes("hello")).toString("base64"),
      },
      userContext("intruder@example.com"),
    ).catch((error: Error) => ({ error: error.message }));
    expect(result.error).toMatch(/not found/i);
  });

  it("strips a path from the filename", async () => {
    const caseId = await newCase();
    await upload(caseId, "../../etc/passwd.txt", textBytes(RECEIPT_TEXT));
    const listed = await callAction<{ evidence: Array<{ filename: string }> }>(
      "list-evidence",
      { caseId },
      userContext(OWNER),
    );
    expect(listed.evidence[0].filename).not.toContain("/");
    expect(listed.evidence[0].filename).not.toContain("..");
  });

  it("refuses to read another user's evidence bytes", async () => {
    const caseId = await newCase();
    const uploaded = await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await expect(
      callAction(
        "get-evidence",
        { caseId, evidenceId: uploaded.evidenceId, includeBytes: true },
        userContext("intruder@example.com"),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe("extraction and analysis flow", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("extracts a CSV with row references and a PDF with page references", async () => {
    const caseId = await newCase();
    await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV), "bank-statement");
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));

    const result = await callAction<{
      summary: { complete: number };
      results: Array<{ passageCount: number; status: string }>;
    }>("extract-evidence", { caseId }, userContext(OWNER));
    expect(result.summary.complete).toBe(2);
    expect(result.results.every((r) => r.passageCount > 0)).toBe(true);
  });

  it("marks a scan with no text layer as unsupported, and analysis then reports the blocker", async () => {
    const caseId = await newCase();
    // A PDF whose page has no text layer, as a scanned page would be.
    await upload(caseId, "scan.pdf", pdfBytes([""]), "other");
    const extraction = await callAction<{ summary: { unsupported: number; failed: number } }>(
      "extract-evidence",
      { caseId },
      userContext(OWNER),
    );
    expect(extraction.summary.unsupported + extraction.summary.failed).toBe(1);

    const status = await callAction<{ nextStep: string; blockers: string[]; evidence: { notExtractable: number } }>(
      "get-investigation-status",
      { caseId },
      userContext(OWNER),
    );
    expect(status.evidence.notExtractable).toBe(1);
    expect(status.blockers.join(" ")).toMatch(/could not be read/i);
  });

  it("refuses to analyse before extraction has run, with an actionable message", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await expect(
      callAction("analyze-evidence", { caseId }, userContext(OWNER)),
    ).rejects.toThrow(/extracted text/i);
  });

  it("reports the next step as extraction when files are pending", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    const status = await callAction<{ nextStep: string; evidence: { pending: number } }>(
      "get-investigation-status",
      { caseId },
      userContext(OWNER),
    );
    expect(status.evidence.pending).toBe(1);
    expect(status.nextStep).toMatch(/extractEvidence/i);
  });

  it("is idempotent: re-extraction does not duplicate passages", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await callAction("extract-evidence", { caseId }, userContext(OWNER));
    await callAction(
      "extract-evidence",
      { caseId, force: true },
      userContext(OWNER),
    );
    const listed = await callAction<{ evidence: Array<{ passageCount: number }> }>(
      "list-evidence",
      { caseId },
      userContext(OWNER),
    );
    expect(listed.evidence[0].passageCount).toBe(1);
  });

  it("returns the same evidence-item fields from get-case as the UI reads", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    const detail = await callAction<{
      evidence: Array<Record<string, unknown>>;
    }>("get-case", { caseId }, userContext(OWNER));

    // Every field the workspace's EvidenceItem declares must be present, or the
    // panel renders a blank. Both list-evidence and get-case feed the same
    // component, so the two serialisers must agree.
    for (const field of [
      "id",
      "filename",
      "mimeType",
      "byteSize",
      "category",
      "extractionStatus",
      "extractionError",
      "passageCount",
      "citedByFindings",
    ]) {
      expect(detail.evidence[0], `missing ${field}`).toHaveProperty(field);
    }
    expect(detail.evidence[0].passageCount).toBe(1);
    expect(detail.evidence[0].citedByFindings).toBe(0);
  });

  it("removes derived findings when their only evidence is deleted", async () => {
    const caseId = await newCase();
    const uploaded = await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    // A finding with a single citation.
    const { getDb, schema } = await import("./helpers/harness.js");
    const db = getDb();
    const passages = await db.select().from(schema.evidencePassages);
    await db.insert(schema.findings).values({
      id: "fnd_test_1",
      caseId,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "A claim supported only by the receipt.",
      provenance: "documented",
      reviewStatus: "confirmed",
      extractionMethod: "documented",
    });
    await db.insert(schema.findingCitations).values({
      id: "cit_test_1",
      findingId: "fnd_test_1",
      evidenceId: uploaded.evidenceId as string,
      passageId: passages[0].id,
      caseId,
      ownerEmail: OWNER,
      quote: passages[0].text.slice(0, 40),
    });

    const result = await callAction<{ removedFindings: number }>(
      "delete-evidence",
      { caseId, evidenceId: uploaded.evidenceId, confirm: true },
      userContext(OWNER),
    );
    expect(result.removedFindings).toBe(1);
    const remaining = await db.select().from(schema.findings);
    expect(remaining).toHaveLength(0);
  });

  it("never invents a date: an undated event lands in the undated list", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    const db = getDb();
    await db.insert(schema.findings).values({
      id: "fnd_evt_1",
      caseId,
      ownerEmail: OWNER,
      kind: "event",
      statement: "Something happened, but the document gives no date.",
      provenance: "unverified",
      reviewStatus: "proposed",
      eventDate: null,
      datePrecision: "unknown",
      extractionMethod: "unverified",
    });
    const timeline = await callAction<{
      timeline: unknown[];
      undated: Array<{ statement: string }>;
      counts: { dated: number; undated: number };
    }>("build-timeline", { caseId }, userContext(OWNER));
    expect(timeline.counts.dated).toBe(0);
    expect(timeline.counts.undated).toBe(1);
    expect(timeline.undated[0].statement).toMatch(/no date/i);
  });

  it("keeps a month-only event out of the day-ordered band and flags it", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    const db = getDb();
    await db.insert(schema.findings).values([
      {
        id: "fnd_day",
        caseId,
        ownerEmail: OWNER,
        kind: "event",
        statement: "Exact day event.",
        provenance: "documented",
        reviewStatus: "proposed",
        eventDate: "2024-03-15",
        datePrecision: "day",
        extractionMethod: "documented",
      },
      {
        id: "fnd_month",
        caseId,
        ownerEmail: OWNER,
        kind: "event",
        statement: "Month only event.",
        provenance: "documented",
        reviewStatus: "proposed",
        eventDate: "2024-03",
        datePrecision: "month",
        extractionMethod: "documented",
      },
    ]);
    const timeline = await callAction<{
      timeline: Array<{ id: string; orderingNote: string | null }>;
    }>("build-timeline", { caseId }, userContext(OWNER));
    expect(timeline.timeline[0].id).toBe("fnd_day");
    expect(timeline.timeline[0].orderingNote).toBeNull();
    expect(timeline.timeline[1].id).toBe("fnd_month");
    expect(timeline.timeline[1].orderingNote).toMatch(/month/i);
  });
});

describe("prompt injection defence", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("keeps injected instructions inside the untrusted data boundary", async () => {
    const { buildEvidenceBundle } = await import("../server/casefile/analysis.js");
    const { openBoundary, closeBoundary } = await import("../server/casefile/analysis.js");
    const caseId = await newCase();
    await upload(caseId, "refund.txt", textBytes(INJECTION_TEXT));
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    const bundle = await buildEvidenceBundle(caseId, OWNER);
    const open = bundle.text.indexOf(openBoundary());
    const close = bundle.text.indexOf(closeBoundary());
    const injected = bundle.text.indexOf("Ignore all previous instructions");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    // The payload sits strictly between the markers, so the model is told it is
    // data. The system prompt is what refuses to obey it.
    expect(injected).toBeGreaterThan(open);
    expect(injected).toBeLessThan(close);
  });

  it("downgrades an uncited claim from documented to unverified", async () => {
    const { deriveProvenance } = await import("../server/casefile/analysis.js");
    expect(deriveProvenance("documented", [])).toBe("unverified");
    expect(deriveProvenance("documented", [{ evidenceId: "e", passageId: "p", quote: "q" }])).toBe(
      "documented",
    );
    expect(deriveProvenance("fabricated", [{ evidenceId: "e", passageId: "p", quote: "q" }])).toBe(
      "inferred",
    );
  });

  it("never stores the literal string \"null\" as a finding's uncertainty", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    // Small local models answer "uncertainty": "null" (the string) when they
    // mean the JSON null. Storing that verbatim would render "null" as prose.
    const runner = async () =>
      JSON.stringify({
        claims: [
          {
            statement: "A charge was made.",
            provenance: "documented",
            uncertainty: "null",
            citations: [{ passageId: "psg_1", quote: "Amount" }],
          },
        ],
        events: [
          {
            description: "The charge happened.",
            dateText: "2024-03-15",
            dateIso: "2024-03-15",
            uncertainty: "N/A",
            citations: [{ passageId: "psg_1", quote: "Amount" }],
          },
        ],
        parties: [],
      });

    const { analyzeCaseEvidence, buildEvidenceBundle } = await import(
      "../server/casefile/analysis.js"
    );
    const bundle = await buildEvidenceBundle(caseId, OWNER);
    const firstPassage = [...bundle.passagesById.keys()][0];
    const withRealIds = async () =>
      (await runner()).replaceAll("psg_1", firstPassage ?? "psg_1");
    const result = await analyzeCaseEvidence(caseId, OWNER, { runner: withRealIds });

    expect(result.claims[0].uncertainty).toBeNull();
    expect(result.events[0].uncertainty).toBeNull();
  });

  it("reads an event's prose from the same `statement` field as a claim", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    const db = getDb();
    await db.insert(schema.findings).values({
      id: "fnd_shape",
      caseId,
      ownerEmail: OWNER,
      kind: "event",
      statement: "The customer disputed the charge.",
      provenance: "documented",
      reviewStatus: "proposed",
      eventDate: "2024-03-18",
      datePrecision: "day",
      extractionMethod: "documented",
    });

    const detail = await callAction<{ events: Array<Record<string, unknown>> }>(
      "get-case",
      { caseId },
      userContext(OWNER),
    );
    // One field name for one concept, so the UI and the agent read events and
    // claims the same way.
    expect(detail.events[0].statement).toBe("The customer disputed the charge.");
    expect(detail.events[0]).not.toHaveProperty("description");

    const timeline = await callAction<{ timeline: Array<Record<string, unknown>> }>(
      "build-timeline",
      { caseId },
      userContext(OWNER),
    );
    expect(timeline.timeline[0].statement).toBe("The customer disputed the charge.");
  });

  it("drops a citation that names a passage which was never sent", async () => {
    const { resolveCitations } = await import("../server/casefile/analysis.js");
    const bundle = {
      text: "",
      passagesSent: 1,
      truncated: false,
      passagesById: new Map([
        ["psg_known", { evidenceId: "ev_1", ref: "page 1", text: "real text" }],
      ]),
    };
    const resolved = resolveCitations(
      [
        { passageId: "psg_known", quote: "real text" },
        { passageId: "psg_invented", quote: "made up" },
      ],
      bundle,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].passageId).toBe("psg_known");
  });
});
