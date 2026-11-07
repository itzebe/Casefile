import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import {
  callAction,
  getDb,
  resetCasefileTables,
  setupTestDatabase,
  userContext,
} from "../helpers/harness.js";
import { STATEMENT_CSV, RECEIPT_TEXT, csvBytes, textBytes } from "../fixtures/evidence.js";

/**
 * Extraction replacement must be atomic under concurrency.
 *
 * These run on a real PostgreSQL server (skipped without `CASEFILE_TEST_PG_URL`)
 * because the property under test — a row-level lock serializing two writers, and
 * a transaction rolling the passage replacement back whole — is a database
 * property that an in-process PGlite cannot faithfully exercise.
 *
 * The regression they pin: extraction used to delete the stored passages and
 * insert the new set as separate statements with no lock. Two extractions of the
 * same file could interleave — one deleting what the other had just inserted —
 * leaving a doubled or truncated passage set, or destroying a valid set when a
 * write failed midway.
 */

const PG_URL = process.env.CASEFILE_TEST_PG_URL; // guard:allow-env-credential — scratch test database DSN, not a credential
const OWNER = "owner@example.com";

const describePg = PG_URL ? describe : describe.skip;

async function createCase(title: string): Promise<string> {
  const result = await callAction<{ id: string }>(
    "create-case",
    { title, description: "concurrency", category: "uncategorized" },
    userContext(OWNER),
  );
  return result.id;
}

async function upload(caseId: string, filename: string, bytes: Uint8Array): Promise<string> {
  const result = await callAction<{ evidenceId: string; duplicate: boolean }>(
    "upload-evidence",
    {
      caseId,
      filename,
      dataBase64: Buffer.from(bytes).toString("base64"),
      category: "receipt",
    },
    userContext(OWNER),
  );
  return result.evidenceId;
}

async function passagesFor(evidenceId: string): Promise<Array<{ ordinal: number; text: string }>> {
  const db = getDb();
  return (await db.execute(
    sql`SELECT ordinal, text FROM casefile_evidence_passages WHERE evidence_id = ${evidenceId} ORDER BY ordinal`,
  )) as unknown as Array<{ ordinal: number; text: string }>;
}

async function evidenceRow(evidenceId: string): Promise<{ extraction_status: string }> {
  const db = getDb();
  const rows = (await db.execute(
    sql`SELECT extraction_status FROM casefile_evidence WHERE id = ${evidenceId}`,
  )) as unknown as Array<{ extraction_status: string }>;
  return rows[0]!;
}

async function countDuplicatedOrdinals(evidenceId: string): Promise<number> {
  const db = getDb();
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM (
          SELECT ordinal FROM casefile_evidence_passages
          WHERE evidence_id = ${evidenceId}
          GROUP BY ordinal HAVING count(*) > 1
        ) d`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

describePg("extraction concurrency (real PostgreSQL)", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetCasefileTables();
  });

  it("Scenario A — concurrent identical extraction leaves one consistent passage set", async () => {
    const caseId = await createCase("Concurrent extraction");
    const evidenceId = await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV));

    // Four extractions of the same file at once. Without the row lock they race
    // on the delete+insert and can double or truncate the set.
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        callAction("extract-evidence", { caseId, evidenceId }, userContext(OWNER)),
      ),
    );
    for (const outcome of settled) {
      expect(outcome.status).toBe("fulfilled");
    }

    const passages = await passagesFor(evidenceId);
    // Exactly one passage per ordinal, and the set is complete.
    expect(await countDuplicatedOrdinals(evidenceId)).toBe(0);
    expect(passages.length).toBeGreaterThan(1);
    const ordinals = passages.map((p) => p.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(new Set(ordinals).size).toBe(ordinals.length);

    // The status is truthful and terminal.
    expect((await evidenceRow(evidenceId)).extraction_status).toBe("complete");
  });

  it("Scenario B — a failure during passage replacement preserves the previous set", async () => {
    const caseId = await createCase("Failure preserves passages");
    const evidenceId = await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV));

    // First, a clean extraction.
    await callAction("extract-evidence", { caseId, evidenceId }, userContext(OWNER));
    const before = await passagesFor(evidenceId);
    expect(before.length).toBeGreaterThan(0);

    // Force the *next* replacement to fail at the database, mid-transaction: a
    // trigger that rejects any insert for this evidence id. This exercises the
    // real rollback path, not a mocked one.
    const db = getDb();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION casefile_test_block_passages() RETURNS trigger AS $$
      BEGIN
        IF NEW.evidence_id = '${evidenceId}' THEN
          RAISE EXCEPTION 'test-injected passage write failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER casefile_test_block_passages_trg
      BEFORE INSERT ON casefile_evidence_passages
      FOR EACH ROW EXECUTE FUNCTION casefile_test_block_passages();
    `));

    try {
      const result = await callAction<{ results: Array<{ status: string; error?: string }> }>(
        "extract-evidence",
        { caseId, evidenceId, force: true },
        userContext(OWNER),
      );
      // The run reports the failure rather than pretending success.
      expect(result.results[0]!.status).toBe("failed");
      expect(result.results[0]!.error).toBeTruthy();
    } finally {
      await db.execute(sql.raw("DROP TRIGGER IF EXISTS casefile_test_block_passages_trg ON casefile_evidence_passages"));
      await db.execute(sql.raw("DROP FUNCTION IF EXISTS casefile_test_block_passages()"));
    }

    // The original valid set survived the rolled-back transaction, unchanged.
    const after = await passagesFor(evidenceId);
    expect(after).toEqual(before);
  });

  it("Scenario C — retry after an interruption produces a complete, consistent set", async () => {
    const caseId = await createCase("Retry");
    const evidenceId = await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV));

    // Interruption: a forced failure that rolls back and changes nothing.
    const db = getDb();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION casefile_test_fail_once() RETURNS trigger AS $$
      BEGIN
        IF NEW.evidence_id = '${evidenceId}' THEN
          RAISE EXCEPTION 'interrupted';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER casefile_test_fail_once_trg
      BEFORE INSERT ON casefile_evidence_passages
      FOR EACH ROW EXECUTE FUNCTION casefile_test_fail_once();
    `));
    await callAction("extract-evidence", { caseId, evidenceId, force: true }, userContext(OWNER));
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS casefile_test_fail_once_trg ON casefile_evidence_passages"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS casefile_test_fail_once()"));

    // Retry now succeeds cleanly on the same evidence record.
    await callAction("extract-evidence", { caseId, evidenceId, force: true }, userContext(OWNER));
    const passages = await passagesFor(evidenceId);
    expect(passages.length).toBeGreaterThan(1);
    expect(await countDuplicatedOrdinals(evidenceId)).toBe(0);
    expect((await evidenceRow(evidenceId)).extraction_status).toBe("complete");
  });

  it("Scenario D — concurrent extraction of different evidence does not cross-contaminate", async () => {
    const caseId = await createCase("Different evidence");
    const csvId = await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV));
    const txtId = await upload(caseId, "receipt.txt", textBytes(RECEIPT_TEXT));

    await Promise.all([
      callAction("extract-evidence", { caseId, evidenceId: csvId }, userContext(OWNER)),
      callAction("extract-evidence", { caseId, evidenceId: txtId }, userContext(OWNER)),
    ]);

    const csvPassages = await passagesFor(csvId);
    const txtPassages = await passagesFor(txtId);
    // Each file's passages belong to its own file and carry its own text.
    expect(csvPassages.length).toBeGreaterThan(0);
    expect(txtPassages.length).toBeGreaterThan(0);
    expect(txtPassages.map((p) => p.text).join("\n")).toContain("Northwind Traders");

    const db = getDb();
    const cross = (await db.execute(
      sql`SELECT count(*)::int AS n FROM casefile_evidence_passages
          WHERE evidence_id = ${txtId} AND text LIKE '%2024-03-15,Northwind%'`,
    )) as unknown as Array<{ n: number }>;
    expect(cross[0]!.n).toBe(0);
  });

  it("Scenario E — the lock is held at the database, not in one process", async () => {
    const caseId = await createCase("Process independence");
    const evidenceId = await upload(caseId, "statement.csv", csvBytes(STATEMENT_CSV));

    // A second, independent connection (a different client, as a serverless
    // instance would be) holds the evidence row lock while an extraction runs
    // through the application's pool.
    const other = postgres(PG_URL!, { max: 1 });
    let extractionDone = false;
    try {
      // Take the lock first, on the other connection, and hold it open.
      await other`BEGIN`;
      await other`SELECT id FROM casefile_evidence WHERE id = ${evidenceId} FOR UPDATE`;

      const extraction = callAction(
        "extract-evidence",
        { caseId, evidenceId },
        userContext(OWNER),
      ).then(() => {
        extractionDone = true;
      });

      // The extraction cannot make progress while this connection holds the row
      // lock, so it has not finished after a generous pause. That is the proof
      // the protection is a database lock, not an in-process one.
      await new Promise((r) => setTimeout(r, 500));
      expect(extractionDone).toBe(false);

      // Releasing the lock lets the blocked extraction proceed to completion.
      await other`COMMIT`;
      await extraction;
      expect(extractionDone).toBe(true);
    } finally {
      await other.end({ timeout: 5 });
    }
    // The extraction that was blocked then completed normally.
    expect((await evidenceRow(evidenceId)).extraction_status).toBe("complete");
  });
});
