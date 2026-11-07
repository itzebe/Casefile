import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  anonymousContext,
  callAction,
  getDb,
  schema,
  setupTestDatabase,
  userContext,
} from "./helpers/harness.js";

/**
 * Authorization certification.
 *
 * Proves that a user can only act on their own cases, documents, findings, and
 * reports, across every access path: UI-equivalent action calls, agent calls,
 * and direct identifier smuggling. Every refusal is checked against the shipped
 * access layer on a real database, so a focus the UI hides but the server does
 * not enforce fails here.
 *
 * The governing rule (server/casefile/access.ts): the acting user comes from the
 * request context, never from input, and every query is filtered by that email at
 * the SQL level. "Not found" is identical for absent and unowned records, so a
 * response cannot be used to probe which ids exist.
 */

const OWNER = "owner@example.com";
const INTRUDER = "intruder@example.com";
const AGENT = "agent-user@example.com";

async function createCase(owner: string, title = "Authorization case"): Promise<string> {
  const created = await callAction<{ id: string }>(
    "create-case",
    { title, description: "authz", category: "payment-dispute" },
    userContext(owner),
  );
  return created.id;
}

async function upload(
  owner: string,
  caseId: string,
  filename: string,
  text: string,
): Promise<{ evidenceId: string }> {
  return callAction(
    "upload-evidence",
    { caseId, filename, dataBase64: Buffer.from(text).toString("base64"), category: "receipt" },
    userContext(owner),
  );
}

/** Seeds a finding + citation owned by `owner`, returning both ids. */
async function seedFinding(owner: string, caseId: string, evidenceId: string) {
  const db = getDb();
  const [passage] = await db.select().from(schema.evidencePassages).limit(1);
  await db.insert(schema.findings).values({
    id: `fnd_${Math.random().toString(36).slice(2, 10)}`,
    caseId,
    ownerEmail: owner,
    kind: "claim",
    statement: "The amount was 100.00 USD.",
    provenance: "documented",
    reviewStatus: "proposed",
    extractionMethod: "documented",
  });
  const findingId = (await db.select().from(schema.findings).where(eq(schema.findings.caseId, caseId)))[0]!.id;
  await db.insert(schema.findingCitations).values({
    id: `cit_${Math.random().toString(36).slice(2, 10)}`,
    findingId,
    evidenceId,
    passageId: passage?.id ?? null,
    caseId,
    ownerEmail: owner,
    quote: "Amount: 100.00 USD",
  });
  return { findingId, passageId: passage?.id ?? null };
}

async function seedRelationship(owner: string, caseId: string, evidenceId: string): Promise<string> {
  const db = getDb();
  const relId = `rel_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(schema.relationships).values({
    id: relId,
    caseId,
    ownerEmail: owner,
    fromType: "evidence",
    fromId: evidenceId,
    toType: "evidence",
    toId: evidenceId,
    relationType: "shares_reference",
    basis: "identifier",
    matchKey: "TXN-1",
    reviewStatus: "proposed",
    createdBy: "engine",
  });
  return relId;
}

describe("authentication", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("refuses every protected action without a signed-in user", async () => {
    const caseId = await createCase(OWNER);
    const { evidenceId } = await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");
    const protectedCalls: Array<[string, unknown]> = [
      ["list-cases", {}],
      ["get-case", { caseId }],
      ["list-evidence", { caseId }],
      ["get-evidence", { caseId, evidenceId }],
      ["extract-evidence", { caseId }],
      ["build-report", { caseId }],
      ["export-report", { caseId, format: "markdown" }],
      ["list-activity", { caseId }],
      ["read-case-graph", { caseId }],
      ["get-investigation-status", { caseId }],
    ];
    for (const [action, args] of protectedCalls) {
      await expect(
        callAction(action, args, anonymousContext()),
        `${action} must require a signed-in user`,
      ).rejects.toThrow(/signed-in|requires/i);
    }
  });

  it("reports a typed 'unauthenticated' code, not an opaque failure", async () => {
    const error = (await callAction("list-cases", {}, anonymousContext()).catch(
      (e: Error & { errorCode?: string; statusCode?: number }) => e,
    )) as Error & { errorCode?: string; statusCode?: number };
    expect(error.errorCode).toBe("unauthenticated");
    expect(error.statusCode).toBe(401);
  });

  it("does not fall back to a shared identity when no user is resolved", async () => {
    // No AUTH_DISABLED in the test environment, so an empty context must never
    // resolve the local demo user and succeed.
    const error = (await callAction("create-case", { title: "x", description: "y", category: "uncategorized" }, anonymousContext()).catch(
      (e: Error & { errorCode?: string }) => e,
    )) as Error & { errorCode?: string };
    expect(error.errorCode).toBe("unauthenticated");
    const db = getDb();
    expect(await db.select().from(schema.cases)).toHaveLength(0);
  });
});

describe("case isolation", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("blocks read, modify, delete, archive, and history of another user's case", async () => {
    const caseId = await createCase(OWNER);
    await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");

    const forbidden: Array<[string, unknown]> = [
      ["get-case", { caseId }],
      ["list-evidence", { caseId }],
      ["update-case", { caseId, title: "Hijacked" }],
      ["archive-case", { caseId }],
      ["list-activity", { caseId }],
      ["get-investigation-status", { caseId }],
      ["build-timeline", { caseId }],
      ["extract-claims", { caseId }],
      ["extract-events", { caseId }],
      ["list-entities", { caseId }],
      ["list-relationships", { caseId }],
      ["list-evidence-gaps", { caseId }],
      ["read-case-graph", { caseId }],
      ["build-report", { caseId }],
      ["export-report", { caseId, format: "docx" }],
      ["extract-evidence", { caseId }],
      ["analyze-evidence", { caseId }],
    ];
    for (const [action, args] of forbidden) {
      await expect(
        callAction(action, args, userContext(INTRUDER)),
        `${action} must reject another user's case`,
      ).rejects.toThrow(/not found/i);
    }

    // Nothing changed: the case still belongs to its owner and is untouched.
    const db = getDb();
    const [row] = await db.select().from(schema.cases).where(eq(schema.cases.id, caseId));
    expect(row?.ownerEmail).toBe(OWNER);
    expect(row?.title).toBe("Authorization case");
  });

  it("never deletes another user's case through archive/update smuggling", async () => {
    const caseId = await createCase(OWNER);
    await callAction("archive-case", { caseId }, userContext(INTRUDER)).catch(() => undefined);
    await callAction("update-case", { caseId, title: "owned" }, userContext(INTRUDER)).catch(
      () => undefined,
    );
    const db = getDb();
    const [row] = await db.select().from(schema.cases).where(eq(schema.cases.id, caseId));
    expect(row?.archivedAt ?? null).toBeNull();
    expect(row?.title).toBe("Authorization case");
  });
});

describe("document isolation", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("blocks byte, passage, metadata, and delete access to another user's evidence", async () => {
    const caseId = await createCase(OWNER);
    const { evidenceId } = await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");

    const forbidden: Array<[string, unknown]> = [
      ["get-evidence", { caseId, evidenceId, includeBytes: true }],
      ["get-evidence", { caseId, evidenceId, includePassages: true }],
      ["extract-evidence", { caseId, evidenceId }],
      ["classify-evidence", { caseId, evidenceId }],
      ["categorize-evidence", { caseId, evidenceId, category: "receipt" }],
      ["delete-evidence", { caseId, evidenceId, confirm: true }],
    ];
    for (const [action, args] of forbidden) {
      await expect(
        callAction(action, args, userContext(INTRUDER)),
        `${action} must reject another user's evidence`,
      ).rejects.toThrow(/not found/i);
    }

    // The bytes are still there and the row still belongs to the owner.
    const db = getDb();
    const [row] = await db.select().from(schema.evidence).where(eq(schema.evidence.id, evidenceId));
    expect(row?.ownerEmail).toBe(OWNER);
  });

  it("does not let a guessed evidence id reach another user's file", async () => {
    const caseId = await createCase(OWNER);
    const { evidenceId } = await upload(OWNER, caseId, "receipt.txt", "Secret amount 100.00 USD");
    // The intruder names the real evidence id but their own (empty) case.
    const intruderCase = await createCase(INTRUDER, "Intruder case");
    await expect(
      callAction("get-evidence", { caseId: intruderCase, evidenceId, includeBytes: true }, userContext(INTRUDER)),
    ).rejects.toThrow(/not found/i);
  });
});

describe("findings, relationships, and reports isolation", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("blocks review and read of another user's finding", async () => {
    const caseId = await createCase(OWNER);
    const { evidenceId } = await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");
    const { findingId } = await seedFinding(OWNER, caseId, evidenceId);

    await expect(
      callAction("update-finding", { caseId, findingId, reviewStatus: "confirmed" }, userContext(INTRUDER)),
    ).rejects.toThrow(/not found/i);
    await expect(
      callAction("explain-finding", { caseId, findingId }, userContext(INTRUDER)),
    ).rejects.toThrow(/not found/i);

    const db = getDb();
    const [row] = await db.select().from(schema.findings).where(eq(schema.findings.id, findingId));
    expect(row?.reviewStatus).toBe("proposed");
  });

  it("blocks review and read of another user's relationship", async () => {
    const caseId = await createCase(OWNER);
    const { evidenceId } = await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");
    const relId = await seedRelationship(OWNER, caseId, evidenceId);

    await expect(
      callAction("update-relationship", { caseId, relationshipId: relId, reviewStatus: "rejected" }, userContext(INTRUDER)),
    ).rejects.toThrow(/not found/i);

    const db = getDb();
    const [row] = await db.select().from(schema.relationships).where(eq(schema.relationships.id, relId));
    expect(row?.reviewStatus).toBe("proposed");
  });

  it("blocks report generation and export for another user's case", async () => {
    const caseId = await createCase(OWNER);
    await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");
    await expect(
      callAction("build-report", { caseId }, userContext(INTRUDER)),
    ).rejects.toThrow(/not found/i);
    await expect(
      callAction("export-report", { caseId, format: "json" }, userContext(INTRUDER)),
    ).rejects.toThrow(/not found/i);
  });

  it("does not leak another user's activity log", async () => {
    const caseId = await createCase(OWNER);
    await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");
    const error = (await callAction("list-activity", { caseId }, userContext(INTRUDER)).catch(
      (e: Error & { errorCode?: string }) => e,
    )) as Error & { errorCode?: string };
    expect(error.errorCode).toBe("case_not_found");
    // The owner's activity exists but is never returned to the intruder.
    const db = getDb();
    expect((await db.select().from(schema.auditLog)).length).toBeGreaterThan(0);
  });
});

describe("agent authorization mirrors the UI", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("does not let an agent act on a case outside the acting user's ownership", async () => {
    const caseId = await createCase(OWNER);
    const { evidenceId } = await upload(OWNER, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");

    // An agent call is just a context with caller="agent"; authorization comes
    // from the resolved user, so supplying another user's case id must fail.
    const agentCtx = userContext(AGENT, "agent");
    for (const [action, args] of [
      ["get-case", { caseId }],
      ["list-evidence", { caseId }],
      ["get-evidence", { caseId, evidenceId, includeBytes: true }],
      ["extract-evidence", { caseId }],
      ["export-report", { caseId, format: "csv" }],
    ] as Array<[string, unknown]>) {
      await expect(
        callAction(action, args, agentCtx),
        `agent ${action} must not bypass ownership`,
      ).rejects.toThrow(/not found/i);
    }
  });

  it("lets an agent operate on a case the acting user owns", async () => {
    const caseId = await createCase(AGENT);
    await upload(AGENT, caseId, "receipt.txt", "Amount: 100.00 USD TXN-1");
    const result = await callAction<{ case: { id: string } }>("get-case", { caseId }, userContext(AGENT, "agent"));
    expect(result.case.id).toBe(caseId);
  });
});
