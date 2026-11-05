import { defineAction } from "@agent-native/core/action";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

export default defineAction({
  description:
    "List the evidence in a case with its extraction status, category, and passage count. Use this to see what is available to analyse before calling extractEvidence or analyzeEvidence.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose evidence to list."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const rows = await db
      .select()
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.caseId, ownedCase.id),
          eq(schema.evidence.ownerEmail, userEmail),
        ),
      )
      .orderBy(asc(schema.evidence.createdAt));

    const passageCounts = await db
      .select({ evidenceId: schema.evidencePassages.evidenceId, total: count() })
      .from(schema.evidencePassages)
      .where(eq(schema.evidencePassages.caseId, ownedCase.id))
      .groupBy(schema.evidencePassages.evidenceId);
    const passagesByEvidence = new Map(
      passageCounts.map((row) => [row.evidenceId, Number(row.total)]),
    );

    const citationCounts = await db
      .select({
        evidenceId: schema.findingCitations.evidenceId,
        total: sql<number>`count(distinct ${schema.findingCitations.findingId})`,
      })
      .from(schema.findingCitations)
      .where(eq(schema.findingCitations.caseId, ownedCase.id))
      .groupBy(schema.findingCitations.evidenceId);
    const citationsByEvidence = new Map(
      citationCounts.map((row) => [row.evidenceId, Number(row.total)]),
    );

    return {
      caseId: ownedCase.id,
      evidence: rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        category: row.category,
        documentType: row.documentType,
        classificationConfidence: row.classificationConfidence,
        classificationCorrectedBy: row.classificationCorrectedBy,
        extractionStatus: row.extractionStatus,
        extractionError: row.extractionError,
        pageCount: row.pageCount,
        createdAt: String(row.createdAt),
        passageCount: passagesByEvidence.get(row.id) ?? 0,
        citedByFindings: citationsByEvidence.get(row.id) ?? 0,
      })),
    };
  },
});
