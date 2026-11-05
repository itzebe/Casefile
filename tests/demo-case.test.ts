import { beforeEach, describe, expect, it } from "vitest";

import { callAction, setupTestDatabase, userContext } from "./helpers/harness.js";
import { csvBytes, textBytes } from "./fixtures/evidence.js";

/**
 * Demo-readiness guarantee (Mission 3).
 *
 * The demonstration case must show the engine doing its actual job, not a
 * pre-baked result: a document that affirms a refund and a document that denies
 * it, on the same explicit reference. These tests mirror the documents in
 * `scripts/seed-demo-case.mjs` and drive the real actions end to end, so the
 * demo cannot silently regress to "0 contradictions".
 */

const OWNER = "owner@example.com";

const MERCHANT_EMAIL = `From: support@sunrise-electronics.example
Subject: Re: order ORD-77120 (transaction TXN-44710298)

We are sorry your standing desk did not arrive. We confirm we have refunded
85000.00 NGN for transaction TXN-44710298, reference RRF-55210.
`;

const CUSTOMER_EMAIL = `From: a.okoro@example.com
Subject: Re: order ORD-77120 (transaction TXN-44710298)

The standing desk I ordered under ORD-77120 has never been delivered. I have
not received any refund for transaction TXN-44710298. The refund you describe
under reference RRF-55210 was never made to my account.
`;

const STATEMENT = `date,description,amount,currency,reference
2026-02-11,Sunrise Electronics Ltd,-85000.00,NGN,TXN-44710298
2026-02-22,Refund Sunrise Electronics,65000.00,NGN,RRF-55210
`;

async function upload(
  caseId: string,
  filename: string,
  data: Uint8Array,
  category: string,
): Promise<string> {
  const result = await callAction<{ evidenceId: string }>(
    "upload-evidence",
    { caseId, filename, dataBase64: Buffer.from(data).toString("base64"), category },
    userContext(OWNER),
  );
  return result.evidenceId;
}

/** Proposes one claim per document, each citing that document's first passage. */
async function proposeClaims(
  caseId: string,
  claims: Array<{ statement: string; evidenceId: string }>,
): Promise<void> {
  const { analyzeCaseEvidence } = await import("../server/casefile/analysis.js");
  const { persistAnalysis } = await import("../server/casefile/analysis-persistence.js");
  const { getDb, schema } = await import("./helpers/harness.js");
  const db = getDb();
  const passageRows = await db.select().from(schema.evidencePassages);
  const firstByEvidence = new Map<string, string>();
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

describe("demo case contradiction guarantee", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("reports a contradiction when one source affirms a refund and another denies it", async () => {
    const created = await callAction<{ id: string }>(
      "create-case",
      { title: "DEMO — disputed refund", category: "payment-dispute" },
      userContext(OWNER),
    );
    const caseId = created.id;

    const merchantId = await upload(
      caseId,
      "merchant-emails.txt",
      textBytes(MERCHANT_EMAIL),
      "correspondence",
    );
    const customerId = await upload(
      caseId,
      "customer-emails.txt",
      textBytes(CUSTOMER_EMAIL),
      "correspondence",
    );
    await upload(caseId, "bank-statement.csv", csvBytes(STATEMENT), "bank-statement");
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    await proposeClaims(caseId, [
      {
        statement: "Sunrise Electronics Ltd refunded the payment for transaction TXN-44710298.",
        evidenceId: merchantId,
      },
      {
        statement:
          "A. Okoro claims they have not received a refund for transaction TXN-44710298.",
        evidenceId: customerId,
      },
    ]);

    const graph = await callAction<{
      counts: { contradictions: number; documents: number };
    }>("build-case-graph", { caseId }, userContext(OWNER));

    expect(graph.counts.documents).toBe(3);
    expect(graph.counts.contradictions).toBeGreaterThanOrEqual(1);
  });

  it("reports agreement, not a contradiction, when two documents state the same fact", async () => {
    // The anti-false-positive guarantee: two documents that name the same
    // reference and the same amount agree. A contradiction engine that fires on
    // ordinary corroboration is worse than useless, so this is pinned.
    const created = await callAction<{ id: string }>(
      "create-case",
      { title: "DEMO — corroboration", category: "payment-dispute" },
      userContext(OWNER),
    );
    const caseId = created.id;

    const merchantId = await upload(
      caseId,
      "merchant-emails.txt",
      textBytes(MERCHANT_EMAIL),
      "correspondence",
    );
    const statementId = await upload(
      caseId,
      "bank-statement.csv",
      csvBytes(STATEMENT),
      "bank-statement",
    );
    await callAction("extract-evidence", { caseId }, userContext(OWNER));

    await proposeClaims(caseId, [
      {
        statement:
          "A refund of 85000.00 NGN for transaction TXN-44710298 was made.",
        evidenceId: merchantId,
      },
      {
        statement:
          "The statement records 85000.00 NGN for transaction TXN-44710298.",
        evidenceId: statementId,
      },
    ]);

    const graph = await callAction<{
      counts: { contradictions: number; agreements: number };
    }>("build-case-graph", { caseId }, userContext(OWNER));

    expect(graph.counts.contradictions).toBe(0);
    expect(graph.counts.agreements).toBeGreaterThanOrEqual(1);
  });
});
