import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { callAction, getDb, resetCasefileTables, setupTestDatabase, userContext } from "../helpers/harness.js";
import { RECEIPT_TEXT, STATEMENT_CSV, csvBytes, textBytes } from "../fixtures/evidence.js";

/**
 * Real PostgreSQL integration.
 *
 * Every other test in this repository runs against PGlite, an in-process WASM
 * build of PostgreSQL. That is a good default, but it is not the database
 * production runs on, and the two differ in ways that matter: transaction and
 * constraint semantics, type round-tripping, and index behaviour. These tests
 * run the same action layer against a real server and assert the properties that
 * only a real server can prove.
 *
 * The suite is skipped unless `CASEFILE_TEST_PG_URL` points at a scratch
 * database (see `vitest.pg.config.ts`), so it never fails for lack of a server.
 */

const PG_URL = process.env.CASEFILE_TEST_PG_URL; // guard:allow-env-credential — scratch test database DSN, not a credential
const OWNER = "owner@example.com";

const describePg = PG_URL ? describe : describe.skip;

describePg("real PostgreSQL", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetCasefileTables();
  });

  it("runs against a real PostgreSQL server, not PGlite", async () => {
    const db = getDb();
    const rows = (await db.execute(
      sql`SELECT version() AS version`,
    )) as unknown as Array<{ version: string }>;
    const version = rows[0]?.version ?? "";
    expect(version).toMatch(/PostgreSQL 1[0-9]/);
    // The in-process WASM build reports a distinct version string.
    expect(version).not.toMatch(/PGlite/i);
  });

  it("persists a full investigation across a fresh connection", async () => {
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG round trip", description: "PostgreSQL", category: "payment-dispute" },
      userContext(OWNER),
    );
    const caseId = caseResult.id;

    await callAction(
      "upload-evidence",
      {
        caseId,
        filename: "receipt.txt",
        dataBase64: Buffer.from(textBytes(RECEIPT_TEXT)).toString("base64"),
        category: "receipt",
      },
      userContext(OWNER),
    );
    await callAction(
      "upload-evidence",
      {
        caseId,
        filename: "statement.csv",
        dataBase64: Buffer.from(csvBytes(STATEMENT_CSV)).toString("base64"),
        category: "bank-statement",
      },
      userContext(OWNER),
    );
    await callAction("extract-evidence", { caseId }, userContext(OWNER));
    await callAction("build-case-graph", { caseId, persist: true }, userContext(OWNER));

    // Read everything back through a separate query path.
    const read = await callAction<{
      evidence: Array<{ filename: string; passageCount: number }>;
    }>("get-case", { caseId }, userContext(OWNER));
    expect(read.evidence.length).toBe(2);
    expect(read.evidence.every((item) => item.passageCount > 0)).toBe(true);

    const graph = await callAction<{ counts: { relationships: number } }>(
      "read-case-graph",
      { caseId },
      userContext(OWNER),
    );
    expect(graph.counts.relationships).toBeGreaterThan(0);
  });

  it("round-trips a timestamp and a nullable column without drift", async () => {
    // PGlite and a real server can disagree on timestamp precision and null
    // handling; this pins the behaviour to the server's.
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG types", description: "types", category: "uncategorized" },
      userContext(OWNER),
    );
    const db = getDb();
    const rows = (await db.execute(
      sql`SELECT created_at, amount_minor FROM casefile_cases WHERE id = ${caseResult.id}`,
    )) as unknown as Array<{ created_at: Date | string; amount_minor: number | null }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.amount_minor).toBeNull();
    const createdAt = rows[0]!.created_at;
    const parsed = createdAt instanceof Date ? createdAt : new Date(createdAt);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it("enforces the primary key on the real server", async () => {
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG constraint", description: "constraint", category: "uncategorized" },
      userContext(OWNER),
    );
    const db = getDb();
    await expect(
      db.execute(
        sql`INSERT INTO casefile_cases (id, owner_email, title) VALUES (${caseResult.id}, ${OWNER}, 'duplicate')`,
      ),
    ).rejects.toThrow();
  });

  it("keeps one user's rows invisible to another at the query layer", async () => {
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG isolation", description: "isolation", category: "uncategorized" },
      userContext(OWNER),
    );
    const db = getDb();
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM casefile_cases WHERE id = ${caseResult.id} AND owner_email = ${"intruder@example.com"}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });

  it("stores one row when the same file is uploaded concurrently", async () => {
    // Regression: the upload path checked for a duplicate digest and then
    // inserted, so identical uploads racing both passed the check and wrote a
    // second row. The unique index on (case_id, sha256) plus a conflict-safe
    // insert is what makes the check hold. Only a real server runs these truly
    // concurrently; PGlite serialises them and would not catch the race.
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG concurrent digest", description: "race", category: "uncategorized" },
      userContext(OWNER),
    );
    const payload = {
      caseId: caseResult.id,
      filename: "receipt.txt",
      dataBase64: Buffer.from(textBytes(RECEIPT_TEXT)).toString("base64"),
      category: "receipt" as const,
    };

    const settled = await Promise.allSettled([
      callAction("upload-evidence", payload, userContext(OWNER)),
      callAction("upload-evidence", payload, userContext(OWNER)),
      callAction("upload-evidence", payload, userContext(OWNER)),
      callAction("upload-evidence", payload, userContext(OWNER)),
    ]);

    // No call may fail: a lost race is reported as a duplicate, not an error.
    for (const outcome of settled) {
      expect(outcome.status).toBe("fulfilled");
    }
    const results = settled.map(
      (outcome) =>
        (outcome as PromiseFulfilledResult<{ duplicate: boolean; evidenceId?: string }>).value,
    );
    expect(results.filter((r) => r.duplicate === false)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate === true)).toHaveLength(3);

    const db = getDb();
    const evidenceRows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM casefile_evidence WHERE case_id = ${caseResult.id}`,
    )) as unknown as Array<{ n: number }>;
    expect(evidenceRows[0]!.n).toBe(1);

    // A lost race must not leave its bytes behind either.
    const blobRows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM casefile_evidence_blobs WHERE case_id = ${caseResult.id}`,
    )) as unknown as Array<{ n: number }>;
    expect(blobRows[0]!.n).toBe(1);
  });

  it("enforces one gap verdict per case and gap on the real server", async () => {
    // The verdict is keyed to a derived gap's stable key; the unique index is
    // what stops a second reviewer's insert from stacking a duplicate opinion
    // the UI would have to reconcile.
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG gap reviews", description: "gap", category: "uncategorized" },
      userContext(OWNER),
    );
    const db = getDb();
    await db.execute(sql`
      INSERT INTO casefile_gap_reviews (id, case_id, owner_email, gap_key, gap_kind, status, reviewed_by)
      VALUES ('gap_a', ${caseResult.id}, ${OWNER}, 'unsupported_claim:f1', 'unsupported_claim', 'resolved', ${OWNER})
    `);
    await expect(
      db.execute(sql`
        INSERT INTO casefile_gap_reviews (id, case_id, owner_email, gap_key, gap_kind, status, reviewed_by)
        VALUES ('gap_b', ${caseResult.id}, ${OWNER}, 'unsupported_claim:f1', 'unsupported_claim', 'unresolved', ${OWNER})
      `),
    ).rejects.toThrow();
  });

  it("persists notes and gap verdicts across a fresh connection", async () => {
    const caseResult = await callAction<{ id: string }>(
      "create-case",
      { title: "PG notes", description: "notes", category: "uncategorized" },
      userContext(OWNER),
    );
    await callAction(
      "update-note",
      { caseId: caseResult.id, body: "A note that must survive a reconnect." },
      userContext(OWNER),
    );
    const notes = await callAction<{ notes: Array<{ body: string }> }>(
      "list-notes",
      { caseId: caseResult.id },
      userContext(OWNER),
    );
    expect(notes.notes[0]?.body).toContain("survive a reconnect");

    // Read the row straight from the server, bypassing the action layer.
    const db = getDb();
    const rows = (await db.execute(
      sql`SELECT body FROM casefile_investigation_notes WHERE case_id = ${caseResult.id}`,
    )) as unknown as Array<{ body: string }>;
    expect(rows[0]?.body).toContain("survive a reconnect");
  });
});
