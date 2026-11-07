import { beforeEach, describe, expect, it } from "vitest";

import { callAction, getDb, schema, setupTestDatabase, userContext } from "./helpers/harness.js";
import { analyzeCaseEvidence } from "../server/casefile/analysis.js";
import { ModelOutputError } from "../server/casefile/model.js";

/**
 * Provider failure handling.
 *
 * The rule: a run that could not be completed must fail loudly and record
 * nothing. A fabricated "successful" analysis is worse than a visible error,
 * because it puts a proposal in a case file that no evidence supports.
 *
 * These drive the shipped analysis entry point with runners that fail the way a
 * real provider fails — unreachable, empty, malformed — and assert the failure is
 * typed and that no finding is written.
 */

const OWNER = "owner@example.com";

async function caseWithEvidence(): Promise<string> {
  const created = await callAction<{ id: string }>(
    "create-case",
    { title: "Provider failure", description: "x", category: "uncategorized" },
    userContext(OWNER),
  );
  const caseId = created.id;
  const { evidenceId } = await callAction<{ evidenceId: string }>(
    "upload-evidence",
    {
      caseId,
      filename: "receipt.txt",
      dataBase64: Buffer.from("PAYMENT RECEIPT\nAmount: $249.99 USD").toString("base64"),
      category: "receipt",
    },
    userContext(OWNER),
  );
  await callAction("extract-evidence", { caseId, evidenceId }, userContext(OWNER));
  return caseId;
}

async function findingCount(caseId: string): Promise<number> {
  const db = getDb();
  const rows = await db.select().from(schema.findings);
  return rows.filter((row) => row.caseId === caseId).length;
}

describe("provider failure handling", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("records nothing when the provider throws mid-call", async () => {
    const caseId = await caseWithEvidence();
    const error = (await analyzeCaseEvidence(caseId, OWNER, {
      runner: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:11434");
      },
    }).catch((e: unknown) => e)) as Error;

    // The failure propagates rather than being swallowed into an empty result.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/ECONNREFUSED/);
    expect(await findingCount(caseId)).toBe(0);
  });

  it("reports empty model output as nothing recorded, not as an empty analysis", async () => {
    const caseId = await caseWithEvidence();
    const error = (await analyzeCaseEvidence(caseId, OWNER, {
      runner: async () => "   ",
    }).catch((e: unknown) => e)) as Error & { errorCode?: string; statusCode?: number };

    // Whitespace is not JSON, so it is refused at the parse boundary rather than
    // treated as an analysis with no findings.
    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.errorCode).toBe("model_output_invalid");
    expect(error.statusCode).toBe(502);
    expect(await findingCount(caseId)).toBe(0);
  });

  it("reports malformed output as a typed 502 and records nothing", async () => {
    const caseId = await caseWithEvidence();
    const error = (await analyzeCaseEvidence(caseId, OWNER, {
      runner: async () => "I'm sorry, I cannot help with that.",
    }).catch((e: unknown) => e)) as Error & { errorCode?: string; statusCode?: number };

    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.errorCode).toBe("model_output_invalid");
    expect(error.statusCode).toBe(502);
    expect(await findingCount(caseId)).toBe(0);
  });

  it("accepts a valid empty result honestly: zero proposals, no fabrication", async () => {
    const caseId = await caseWithEvidence();
    const analysis = await analyzeCaseEvidence(caseId, OWNER, {
      runner: async () => JSON.stringify({ claims: [], events: [], parties: [] }),
    });
    expect(analysis.claims).toHaveLength(0);
    expect(analysis.events).toHaveLength(0);
    expect(analysis.passagesSent).toBeGreaterThan(0);
  });

  it("does not analyse a case with no extracted evidence", async () => {
    const created = await callAction<{ id: string }>(
      "create-case",
      { title: "Empty", description: "x", category: "uncategorized" },
      userContext(OWNER),
    );
    const error = (await callAction("analyze-evidence", { caseId: created.id }, userContext(OWNER)).catch(
      (e: Error & { errorCode?: string }) => e,
    )) as Error & { errorCode?: string };
    expect(error.errorCode).toBe("no_extracted_evidence");
  });
});
