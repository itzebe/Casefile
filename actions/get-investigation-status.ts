import { defineAction } from "@agent-native/core/action";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Reports how far a case's investigation has got, and what to do next.
 *
 * This is the action an agent should call first on an unfamiliar case: it
 * returns counts, the concrete blockers, and the next recommended step, so a
 * caller does not have to guess whether evidence still needs extracting before
 * analysis can run.
 */
export default defineAction({
  description:
    "Report the investigation status of a case: evidence counts by extraction status, how many findings are proposed versus confirmed, what is blocking progress, and the next recommended step.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to report on."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const evidenceRows = await db
      .select({
        status: schema.evidence.extractionStatus,
        total: count(),
      })
      .from(schema.evidence)
      .where(eq(schema.evidence.caseId, ownedCase.id))
      .groupBy(schema.evidence.extractionStatus);
    const evidenceByStatus: Record<string, number> = {};
    for (const row of evidenceRows) evidenceByStatus[row.status] = Number(row.total);

    const findingRows = await db
      .select({
        kind: schema.findings.kind,
        reviewStatus: schema.findings.reviewStatus,
        total: count(),
      })
      .from(schema.findings)
      .where(eq(schema.findings.caseId, ownedCase.id))
      .groupBy(schema.findings.kind, schema.findings.reviewStatus);

    const claims = { proposed: 0, confirmed: 0, rejected: 0 };
    const events = { proposed: 0, confirmed: 0, rejected: 0 };
    for (const row of findingRows) {
      const bucket = row.kind === "claim" ? claims : events;
      const key = row.reviewStatus as keyof typeof bucket;
      if (key in bucket) bucket[key] = Number(row.total);
    }

    const unsupportedClaims = await db
      .select({ total: count() })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.caseId, ownedCase.id),
          eq(schema.findings.kind, "claim"),
          sql`not exists (select 1 from casefile_finding_citations c where c.finding_id = ${schema.findings.id})`,
        ),
      );
    const unsupported = Number(unsupportedClaims[0]?.total ?? 0);

    const conflictingEvents = await db
      .select({ total: count() })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.caseId, ownedCase.id),
          eq(schema.findings.kind, "event"),
          eq(schema.findings.dateConflict, true),
        ),
      );

    const totalEvidence = Object.values(evidenceByStatus).reduce((a, b) => a + b, 0);
    const extracted = evidenceByStatus.complete ?? 0;
    const pending = evidenceByStatus.pending ?? 0;
    const notExtractable =
      (evidenceByStatus.unsupported ?? 0) + (evidenceByStatus.failed ?? 0);

    const blockers: string[] = [];
    if (totalEvidence === 0) blockers.push("No evidence has been uploaded yet.");
    if (pending > 0) blockers.push(`${pending} file(s) still need text extraction.`);
    if (notExtractable > 0) {
      blockers.push(
        `${notExtractable} file(s) could not be read, so their contents are not part of the analysis.`,
      );
    }
    if (extracted === 0 && totalEvidence > 0) {
      blockers.push("No file has usable text, so analysis cannot run.");
    }
    if (claims.proposed + events.proposed > 0) {
      blockers.push(
        `${claims.proposed + events.proposed} finding(s) are still proposals and need review.`,
      );
    }
    if (unsupported > 0) {
      blockers.push(`${unsupported} claim(s) have no supporting passage.`);
    }

    let nextStep: string;
    if (totalEvidence === 0) nextStep = "Upload evidence for this case.";
    else if (pending > 0) nextStep = "Run extractEvidence to read the uploaded files.";
    else if (extracted === 0) nextStep = "Add a file whose text can be extracted (PDF, TXT, or CSV).";
    else if (claims.proposed + events.proposed > 0 && claims.confirmed + events.confirmed === 0) {
      nextStep = "Review the proposed findings and confirm or reject each one.";
    } else if (claims.confirmed + events.confirmed === 0) {
      nextStep = "Run analyzeEvidence to propose claims and events.";
    } else {
      nextStep = "Review remaining proposals, then close the case when the record is complete.";
    }

    return {
      caseId: ownedCase.id,
      caseStatus: ownedCase.status,
      evidence: {
        total: totalEvidence,
        byStatus: evidenceByStatus,
        extracted,
        pending,
        notExtractable,
      },
      claims,
      events,
      unsupportedClaims: unsupported,
      conflictingEvents: Number(conflictingEvents[0]?.total ?? 0),
      blockers,
      nextStep,
    };
  },
});
