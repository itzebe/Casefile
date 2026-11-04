import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit, requireOwnedCase, requireOwnedEvidence } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { evidenceStoreById } from "../server/casefile/evidence-store.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Removes evidence and everything derived from it.
 *
 * Deleting the row without deleting the findings that cite it would leave
 * citations pointing at a document that no longer exists, which is worse than
 * keeping a stale file. So this reports how many findings depended on the file,
 * deletes their citations, and removes the findings that are left with no
 * support at all.
 */
export default defineAction({
  description:
    "Remove a file from a case's evidence vault, along with its extracted text and any finding that depended only on it. Reports what was removed.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the evidence belongs to."),
    evidenceId: z.string().min(1).describe("The evidence to remove."),
    confirm: z
      .literal(true)
      .describe("Must be true. Removing evidence cannot be undone."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const row = await requireOwnedEvidence(args.evidenceId, userEmail, args.caseId);
    const db = getDb();

    const affectedCitations = await db
      .select({ findingId: schema.findingCitations.findingId })
      .from(schema.findingCitations)
      .where(eq(schema.findingCitations.evidenceId, row.id));
    const affectedFindingIds = [...new Set(affectedCitations.map((c) => c.findingId))];

    await db
      .delete(schema.findingCitations)
      .where(eq(schema.findingCitations.evidenceId, row.id));

    // A finding whose last citation just disappeared no longer has support, so
    // it is removed rather than left claiming a source it lost.
    let removedFindings = 0;
    for (const findingId of affectedFindingIds) {
      const remaining = await db
        .select({ id: schema.findingCitations.id })
        .from(schema.findingCitations)
        .where(eq(schema.findingCitations.findingId, findingId));
      if (remaining.length === 0) {
        await db.delete(schema.findings).where(eq(schema.findings.id, findingId));
        removedFindings += 1;
      }
    }

    await db
      .delete(schema.evidencePassages)
      .where(eq(schema.evidencePassages.evidenceId, row.id));

    // Remove the bytes through the store that owns the key, then the row.
    try {
      const store = evidenceStoreById(row.storageProvider);
      await store.delete({ ownerEmail: userEmail, storageKey: row.storageKey });
    } catch (error) {
      console.warn(
        "[casefile] evidence bytes could not be deleted",
        row.id,
        error instanceof Error ? error.message : String(error),
      );
    }

    await db
      .delete(schema.evidence)
      .where(
        and(eq(schema.evidence.id, row.id), eq(schema.evidence.ownerEmail, userEmail)),
      );
    await touchCase(ownedCase.id, userEmail);

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "evidence.delete",
      targetType: "evidence",
      targetId: row.id,
      summary: `Removed ${row.mimeType} (${row.byteSize} bytes); removed ${removedFindings} unsupported finding(s)`,
      caller,
      runId,
    });

    return {
      removedEvidenceId: row.id,
      removedFindings,
      affectedFindings: affectedFindingIds.length,
    };
  },
});
