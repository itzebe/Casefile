import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";

/**
 * Read models for cases. Every function here filters by `ownerEmail` in SQL, so
 * a caller cannot reach another user's case by supplying an id.
 */

export interface CaseSummary {
  id: string;
  title: string;
  description: string;
  category: string;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  evidenceCount: number;
  extractedCount: number;
  claimCount: number;
  eventCount: number;
  confirmedCount: number;
}

export async function listCaseSummaries(ownerEmail: string): Promise<CaseSummary[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.cases)
    .where(eq(schema.cases.ownerEmail, ownerEmail))
    .orderBy(desc(schema.cases.updatedAt));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const evidenceCounts = await db
    .select({
      caseId: schema.evidence.caseId,
      total: count(),
      extracted: sql<number>`count(*) filter (where ${schema.evidence.extractionStatus} = 'complete')`,
    })
    .from(schema.evidence)
    .where(and(eq(schema.evidence.ownerEmail, ownerEmail), inArray(schema.evidence.caseId, ids)))
    .groupBy(schema.evidence.caseId);

  const findingCounts = await db
    .select({
      caseId: schema.findings.caseId,
      kind: schema.findings.kind,
      total: count(),
      confirmed: sql<number>`count(*) filter (where ${schema.findings.reviewStatus} = 'confirmed')`,
    })
    .from(schema.findings)
    .where(and(eq(schema.findings.ownerEmail, ownerEmail), inArray(schema.findings.caseId, ids)))
    .groupBy(schema.findings.caseId, schema.findings.kind);

  const evidenceByCase = new Map(evidenceCounts.map((row) => [row.caseId, row]));
  const findingsByCase = new Map<string, { claims: number; events: number; confirmed: number }>();
  for (const row of findingCounts) {
    const entry = findingsByCase.get(row.caseId) ?? { claims: 0, events: 0, confirmed: 0 };
    if (row.kind === "claim") entry.claims += Number(row.total);
    if (row.kind === "event") entry.events += Number(row.total);
    entry.confirmed += Number(row.confirmed);
    findingsByCase.set(row.caseId, entry);
  }

  return rows.map((row) => {
    const evidence = evidenceByCase.get(row.id);
    const findings = findingsByCase.get(row.id) ?? { claims: 0, events: 0, confirmed: 0 };
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      status: row.status,
      amountMinor: row.amountMinor,
      currency: row.currency,
      revision: row.revision,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      evidenceCount: Number(evidence?.total ?? 0),
      extractedCount: Number(evidence?.extracted ?? 0),
      claimCount: findings.claims,
      eventCount: findings.events,
      confirmedCount: findings.confirmed,
    };
  });
}

/** Bumps `revision` and `updatedAt` so the UI's live sync sees the change. */
export async function touchCase(caseId: string, ownerEmail: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.cases)
    .set({
      revision: sql`${schema.cases.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(schema.cases.id, caseId), eq(schema.cases.ownerEmail, ownerEmail)));
}
