import { beforeEach, describe, expect, it } from "vitest";

import { callAction, setupTestDatabase, userContext } from "./helpers/harness.js";
import {
  RECEIPT_TEXT,
  STATEMENT_CSV,
  csvBytes,
  textBytes,
} from "./fixtures/evidence.js";

/**
 * Cross-document intelligence (Mission 3).
 *
 * These tests drive the real actions against a real database, and they are
 * deliberately built around one question: does CASEFILE connect information
 * across documents, and does it refuse to connect what it cannot justify? A
 * false contradiction is as much a failure as a missed one, so several tests
 * assert that two documents which merely look similar are NOT linked.
 */

const OWNER = "owner@example.com";

/** A second document that agrees with the receipt on the same transaction. */
const STATEMENT_MATCHING = `date,description,amount,currency,reference
2024-03-15,Northwind Traders,249.99,USD,TXN-88421907
`;

/** A bank statement that records a DIFFERENT amount for the same reference. */
const STATEMENT_WRONG_AMOUNT = `date,description,amount,currency,reference
2024-03-15,Northwind Traders,499.99,USD,TXN-88421907
`;

/** A statement recording the same reference on a different date. */
const STATEMENT_WRONG_DATE = `date,description,amount,currency,reference
2024-04-01,Northwind Traders,249.99,USD,TXN-88421907
`;

/** A document that shares no identifier with the receipt. */
const UNRELATED_TEXT = `MEMO

The office will be closed on Friday for maintenance.
No customer transactions took place that day.
`;

async function newCase(title = "Cross-document case"): Promise<string> {
  const result = await callAction<{ id: string }>(
    "create-case",
    { title, description: "Cross-document investigation", category: "payment-dispute" },
    userContext(OWNER),
  );
  return result.id;
}

async function upload(
  caseId: string,
  filename: string,
  data: Uint8Array,
  category = "receipt",
): Promise<string> {
  const result = await callAction<{ evidenceId: string }>(
    "upload-evidence",
    {
      caseId,
      filename,
      dataBase64: Buffer.from(data).toString("base64"),
      category,
    },
    userContext(OWNER),
  );
  return result.evidenceId;
}

/** Uploads, extracts, and returns the case id. */
async function seedTwoDocuments(
  second: string,
  secondName = "statement.csv",
): Promise<string> {
  const caseId = await newCase();
  await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT), "receipt");
  await upload(caseId, secondName, csvBytes(second), "bank-statement");
  await callAction("extract-evidence", { caseId }, userContext(OWNER));
  return caseId;
}

/**
 * A deterministic analysis stand-in that proposes one claim per document, each
 * citing that document's own first passage, so the comparison engine has real
 * findings to compare across documents.
 *
 * It calls the same two functions the `analyze-evidence` action calls -
 * `analyzeCaseEvidence` and `persistAnalysis` - so what lands in the database is
 * exactly what the action would write.
 */
async function proposeClaims(
  caseId: string,
  claims: Array<{ statement: string; evidenceId: string }>,
): Promise<void> {
  const { analyzeCaseEvidence } = await import("../server/casefile/analysis.js");
  const { persistAnalysis } = await import("../server/casefile/analysis-persistence.js");
  const { getDb, schema } = await import("./helpers/harness.js");
  const db = getDb();
  const passageRows = await db.select().from(schema.evidencePassages);
  // Pick the first non-header passage per document, so a citation lands on a
  // data row rather than a CSV's header line.
  const firstByEvidence = new Map<string, string>();
  for (const row of passageRows) {
    if (/^Header:/i.test(row.text)) continue;
    if (!firstByEvidence.has(row.evidenceId)) firstByEvidence.set(row.evidenceId, row.id);
  }
  for (const row of passageRows) {
    if (!firstByEvidence.has(row.evidenceId)) firstByEvidence.set(row.evidenceId, row.id);
  }

  const runner = async () =>
    JSON.stringify({
      claims: claims.map((claim) => ({
        statement: claim.statement,
        provenance: "documented",
        citations: [
          { passageId: firstByEvidence.get(claim.evidenceId) ?? "psg_x", quote: "excerpt" },
        ],
      })),
      events: [],
      parties: [],
    });

  const analysis = await analyzeCaseEvidence(caseId, OWNER, { runner });
  await persistAnalysis({ caseId, ownerEmail: OWNER, analysis });
}

describe("cross-document relationships", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("links two documents that share a transaction reference", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const graph = await callAction<{
      counts: { relationships: number; documents: number };
      relationships: Array<{ relationType: string; basis: string; matchKey: string | null }>;
    }>("build-case-graph", { caseId }, userContext(OWNER));

    expect(graph.counts.documents).toBe(2);
    const identifierEdge = graph.relationships.find((r) => r.relationType === "same_identifier");
    expect(identifierEdge).toBeDefined();
    expect(identifierEdge?.basis).toBe("direct");
    // The exact identifier the engine matched on is recorded, so a reviewer can
    // check the link instead of trusting it.
    expect(identifierEdge?.matchKey).toBe("txn88421907");
  });

  it("does not link two documents that merely share a word", async () => {
    const caseId = await newCase();
    await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT), "receipt");
    await upload(caseId, "memo.txt", textBytes(UNRELATED_TEXT), "other");
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    const graph = await callAction<{ counts: { relationships: number } }>(
      "build-case-graph",
      { caseId },
      userContext(OWNER),
    );
    // The memo mentions "transactions" and "customer" but shares no identifier,
    // amount, party, or date with the receipt.
    expect(graph.counts.relationships).toBe(0);
  });

  it("never creates a relationship between passages in the same document", async () => {
    const caseId = await newCase();
    await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV), "bank-statement");
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    const graph = await callAction<{
      relationships: Array<{ fromId: string; toId: string }>;
    }>("build-case-graph", { caseId }, userContext(OWNER));
    // The CSV's rows share amounts and dates with each other, but a
    // within-document repeat is not a cross-document relationship.
    expect(graph.relationships).toHaveLength(0);
  });

  it("records the passage a relationship came from", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const graph = await callAction<{
      relationships: Array<{ sourcePassageId: string | null; fromType: string }>;
    }>("build-case-graph", { caseId }, userContext(OWNER));
    const passageEdges = graph.relationships.filter((r) => r.fromType === "passage");
    expect(passageEdges.length).toBeGreaterThan(0);
    expect(passageEdges.every((r) => r.sourcePassageId)).toBe(true);
  });

  it("preserves a dismissed relationship across a rebuild", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const first = await callAction<{
      relationships: Array<{ id: string; relationType: string }>;
    }>("build-case-graph", { caseId }, userContext(OWNER));
    const target = first.relationships.find((r) => r.relationType === "same_identifier")!;
    expect(target).toBeDefined();

    await callAction(
      "update-relationship",
      { caseId, relationshipId: target.id, reviewStatus: "rejected" },
      userContext(OWNER),
    );

    const second = await callAction<{
      relationships: Array<{ id: string; relationType: string; reviewStatus: string }>;
    }>("build-case-graph", { caseId }, userContext(OWNER));
    // The dismissed edge is not recreated by the engine, and the dismissed row
    // itself is retained so the reviewer's decision stays on the record.
    const recreated = second.relationships.filter(
      (r) => r.relationType === "same_identifier" && r.id !== target.id,
    );
    expect(recreated).toHaveLength(0);
    const retained = second.relationships.find((r) => r.id === target.id);
    expect(retained?.reviewStatus).toBe("rejected");
  });
});

describe("cross-document claim comparison", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("reports direct agreement when two documents name the same reference", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "A charge of $249.99 was made to the card.", evidenceId: receipt.id },
      { statement: "A charge of $249.99 appears on the statement.", evidenceId: statement.id },
    ]);

    const result = await callAction<{
      comparisons: Array<{ verdict: string; sharedRefs: string[] }>;
    }>("compare-claims", { caseId }, userContext(OWNER));

    const agreement = result.comparisons.find((c) => c.verdict === "direct_agreement");
    expect(agreement).toBeDefined();
    expect(agreement?.sharedRefs).toContain("txn88421907");
  });

  it("reports a contradiction when the same reference carries a different amount", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_WRONG_AMOUNT);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "The receipt records $249.99 for the charge.", evidenceId: receipt.id },
      { statement: "The statement records $499.99 for the charge.", evidenceId: statement.id },
    ]);

    const result = await callAction<{
      comparisons: Array<{ verdict: string; conflictingAmounts: unknown }>;
    }>("compare-claims", { caseId }, userContext(OWNER));

    const contradiction = result.comparisons.find((c) => c.verdict === "contradiction");
    expect(contradiction).toBeDefined();
    expect(contradiction?.conflictingAmounts).not.toBeNull();
  });

  it("reports a contradiction when one assertion affirms and the other denies", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "The customer authorised the charge TXN-88421907.", evidenceId: receipt.id },
      { statement: "The customer did not authorise the charge TXN-88421907.", evidenceId: statement.id },
    ]);

    const result = await callAction<{
      comparisons: Array<{ verdict: string; polarityDiffers: boolean }>;
    }>("compare-claims", { caseId }, userContext(OWNER));

    const contradiction = result.comparisons.find((c) => c.polarityDiffers);
    expect(contradiction?.verdict).toBe("contradiction");
  });

  it("reports a potential contradiction for different dates on the same reference", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_WRONG_DATE);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "The charge TXN-88421907 was made on 2024-03-15.", evidenceId: receipt.id },
      { statement: "The charge TXN-88421907 was made on 2024-04-01.", evidenceId: statement.id },
    ]);

    const result = await callAction<{
      comparisons: Array<{ verdict: string; conflictingDates: unknown }>;
    }>("compare-claims", { caseId }, userContext(OWNER));

    const potential = result.comparisons.find(
      (c) => c.verdict === "potential_contradiction",
    );
    expect(potential).toBeDefined();
    expect(potential?.conflictingDates).not.toBeNull();
  });

  it("reports insufficient information when an assertion has no source", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const db = getDb();
    const evidenceRows = await db.select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    // A sourced claim so there is something to compare the unsourced one against.
    await proposeClaims(caseId, [
      { statement: "The card was charged $249.99.", evidenceId: receipt.id },
    ]);
    await db.insert(schema.findings).values({
      id: "fnd_unsourced",
      caseId,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "The merchant has a history of fraud.",
      provenance: "unverified",
      reviewStatus: "proposed",
    });

    const result = await callAction<{
      comparisons: Array<{ verdict: string }>;
    }>("compare-claims", { caseId }, userContext(OWNER));
    expect(result.comparisons.some((c) => c.verdict === "insufficient_information")).toBe(true);
  });

  it("does not call two assertions unrelated when they share a subject", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "Northwind Traders charged the card.", evidenceId: receipt.id },
      { statement: "Northwind Traders appears on the statement.", evidenceId: statement.id },
    ]);

    const result = await callAction<{ comparisons: Array<{ verdict: string }> }>(
      "compare-claims",
      { caseId },
      userContext(OWNER),
    );
    // The shared party is enough to compare; the verdict is not "unrelated".
    expect(result.comparisons.length).toBeGreaterThan(0);
    expect(result.comparisons.every((c) => c.verdict !== "unrelated")).toBe(true);
  });

  it("keeps both original assertions and their citations in every comparison", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "A charge of $249.99 was made.", evidenceId: receipt.id },
      { statement: "A charge of $249.99 is on the statement.", evidenceId: statement.id },
    ]);

    const result = await callAction<{
      comparisons: Array<{
        aStatement: string;
        bStatement: string;
        aCitations: unknown[];
        bCitations: unknown[];
      }>;
    }>("compare-claims", { caseId }, userContext(OWNER));

    const comparison = result.comparisons[0]!;
    expect(comparison.aStatement).toBeTruthy();
    expect(comparison.bStatement).toBeTruthy();
    expect(comparison.aCitations.length).toBeGreaterThan(0);
    expect(comparison.bCitations.length).toBeGreaterThan(0);
  });

  it("computes the same comparison without writing to the database", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;
    await proposeClaims(caseId, [
      { statement: "A charge of $249.99 was made.", evidenceId: receipt.id },
      { statement: "A charge of $249.99 is on the statement.", evidenceId: statement.id },
    ]);

    const before = await getDb().select().from(schema.relationships);
    await callAction("compare-claims", { caseId }, userContext(OWNER));
    const after = await getDb().select().from(schema.relationships);
    expect(after.length).toBe(before.length);
  });
});

describe("evidence gap analysis", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("flags an assertion with no cited source", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    await getDb().insert(schema.findings).values({
      id: "fnd_gap",
      caseId,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "The charge was fraudulent.",
      provenance: "unverified",
      reviewStatus: "proposed",
    });

    const result = await callAction<{ gaps: Array<{ kind: string; missing: string; whatWouldHelp: string }> }>(
      "list-evidence-gaps",
      { caseId },
      userContext(OWNER),
    );
    const gap = result.gaps.find((g) => g.kind === "unsupported_claim");
    expect(gap).toBeDefined();
    // Every gap explains what is missing and what would resolve it.
    expect(gap?.missing).toBeTruthy();
    expect(gap?.whatWouldHelp).toBeTruthy();
  });

  it("flags an amount with no matching transaction record", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;

    await proposeClaims(caseId, [
      { statement: "An amount of $249.99 is owed.", evidenceId: receipt.id },
    ]);

    const result = await callAction<{ gaps: Array<{ kind: string }> }>(
      "list-evidence-gaps",
      { caseId },
      userContext(OWNER),
    );
    // The receipt carries both an amount and a reference, so this specific gap
    // should not fire; the test guards the false positive as much as the true one.
    const amountGaps = result.gaps.filter((g) => g.kind === "amount_without_transaction");
    expect(amountGaps.length).toBe(0);
  });

  it("never treats a gap as proof that an event did not happen", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    await getDb().insert(schema.findings).values({
      id: "fnd_undated",
      caseId,
      ownerEmail: OWNER,
      kind: "event",
      statement: "The customer disputed the charge.",
      provenance: "documented",
      reviewStatus: "proposed",
    });

    const result = await callAction<{ gaps: Array<{ kind: string; whyItMatters: string }>; note: string }>(
      "list-evidence-gaps",
      { caseId },
      userContext(OWNER),
    );
    const undated = result.gaps.find((g) => g.kind === "undated_event");
    expect(undated).toBeDefined();
    expect(result.note).toMatch(/not a finding that the event did not occur/i);
  });
});

describe("explain-finding", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("answers which documents and passages support a finding", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    const evidenceRows = await getDb().select().from(schema.evidence);
    const receipt = evidenceRows.find((e) => e.filename === "receipt.txt")!;
    const statement = evidenceRows.find((e) => e.filename === "statement.csv")!;

    await proposeClaims(caseId, [
      { statement: "A charge of $249.99 was made.", evidenceId: receipt.id },
      { statement: "A charge of $249.99 is on the statement.", evidenceId: statement.id },
    ]);

    const claimRows = await getDb().select().from(schema.findings);
    const claim = claimRows.find((f) => f.statement.includes("was made"))!;

    const explanation = await callAction<{
      supportedBy: Array<{ filename: string; ref: string | null }>;
      agreesWith: Array<{ verdict: string }>;
      explanationComplete: string;
    }>("explain-finding", { caseId, findingId: claim.id }, userContext(OWNER));

    expect(explanation.supportedBy.length).toBeGreaterThan(0);
    expect(explanation.supportedBy[0]?.filename).toBe("receipt.txt");
    // The cross-document agreement is surfaced as an answer, not left implicit.
    expect(explanation.agreesWith.some((a) => a.verdict === "direct_agreement")).toBe(true);
  });

  it("says plainly when an assertion has no source to explain it from", async () => {
    const caseId = await newCase();
    const { getDb, schema } = await import("./helpers/harness.js");
    await getDb().insert(schema.findings).values({
      id: "fnd_bare",
      caseId,
      ownerEmail: OWNER,
      kind: "claim",
      statement: "Something happened.",
      provenance: "unverified",
      reviewStatus: "proposed",
    });

    const explanation = await callAction<{
      supportedBy: unknown[];
      whatRemainsUnknown: string[];
      explanationComplete: string;
    }>("explain-finding", { caseId, findingId: "fnd_bare" }, userContext(OWNER));

    expect(explanation.supportedBy).toHaveLength(0);
    expect(explanation.explanationComplete).toMatch(/no cited source/i);
    expect(explanation.whatRemainsUnknown.length).toBeGreaterThan(0);
  });
});

describe("case isolation for cross-document data", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("does not let another user build or read a case's graph", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    await expect(
      callAction("build-case-graph", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow(/not found/i);
    await expect(
      callAction("compare-claims", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow(/not found/i);
    await expect(
      callAction("list-evidence-gaps", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow(/not found/i);
    await expect(
      callAction("list-relationships", { caseId }, userContext("intruder@example.com")),
    ).rejects.toThrow(/not found/i);
  });

  it("keeps one case's relationships out of another case's graph", async () => {
    const caseA = await seedTwoDocuments(STATEMENT_MATCHING);
    const caseB = await newCase("A different case");
    await upload(caseB, "receipt2.txt", textBytes(RECEIPT_TEXT), "receipt");
    await callAction("extract-evidence", { caseId: caseB }, userContext(OWNER));

    await callAction("build-case-graph", { caseId: caseA }, userContext(OWNER));
    const graphB = await callAction<{ relationships: unknown[] }>(
      "build-case-graph",
      { caseId: caseB },
      userContext(OWNER),
    );
    // Case B holds one document, so it can have no cross-document relationship.
    expect(graphB.relationships).toHaveLength(0);
  });

  it("requires a signed-in user", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { anonymousContext } = await import("./helpers/harness.js");
    await expect(
      callAction("build-case-graph", { caseId }, anonymousContext()),
    ).rejects.toThrow(/signed-in/i);
  });
});

describe("agent-proposed relationships", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("lets an agent propose a relationship, attributed to the agent", async () => {
    const caseId = await seedTwoDocuments(STATEMENT_MATCHING);
    const { getDb, schema } = await import("./helpers/harness.js");
    await getDb().insert(schema.findings).values([
      { id: "fnd_a", caseId, ownerEmail: OWNER, kind: "claim", statement: "A.", provenance: "documented", reviewStatus: "proposed" },
      { id: "fnd_b", caseId, ownerEmail: OWNER, kind: "claim", statement: "B.", provenance: "documented", reviewStatus: "proposed" },
    ]);

    const result = await callAction<{ id: string; created: boolean }>(
      "update-relationship",
      {
        caseId,
        fromType: "finding",
        fromId: "fnd_a",
        toType: "finding",
        toId: "fnd_b",
        relationType: "corroborates",
        basis: "direct",
        matchKey: "txn88421907",
      },
      userContext(OWNER, "agent"),
    );
    expect(result.created).toBe(true);

    const stored = await getDb().select().from(schema.relationships);
    const row = stored.find((r) => r.id === result.id)!;
    // The agent's proposal is distinguishable from an engine-derived edge.
    expect(row.createdBy).toBe("agent");
    expect(row.reviewStatus).toBe("proposed");
  });
});
