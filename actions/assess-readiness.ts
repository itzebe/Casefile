import { defineAction } from "@agent-native/core/action";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildCaseGraph } from "../server/casefile/graph.js";
import { assessReadiness, type ReadinessAssessment } from "../server/casefile/readiness.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Assesses how ready a case is to become a report, and says why.
 *
 * The inputs are gathered from the case's own record (evidence statuses,
 * finding review states, the graph's contradictions and gaps), then handed to
 * the pure `assessReadiness` rule set. The result is an explanation, not a
 * score: what is established, unverified, contradicted, missing, what needs
 * review, and the next step.
 */
export default defineAction({
  description:
    "Assess whether a case is ready to become an investigation report, and explain why: what is established, unverified, contradicted, missing, what needs human review, and the next reasonable step. Returns a named readiness state, never a numeric score.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to assess."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const evidenceRows = await db
      .select({ status: schema.evidence.extractionStatus, total: count() })
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.caseId, ownedCase.id),
          eq(schema.evidence.ownerEmail, userEmail),
        ),
      )
      .groupBy(schema.evidence.extractionStatus);
    const byStatus: Record<string, number> = {};
    for (const row of evidenceRows) byStatus[row.status] = Number(row.total);

    const findingRows = await db
      .select({
        kind: schema.findings.kind,
        reviewStatus: schema.findings.reviewStatus,
        total: count(),
      })
      .from(schema.findings)
      .where(eq(schema.findings.caseId, ownedCase.id))
      .groupBy(schema.findings.kind, schema.findings.reviewStatus);

    let claimTotal = 0;
    let claimConfirmed = 0;
    let eventTotal = 0;
    let eventConfirmed = 0;
    let proposedTotal = 0;
    for (const row of findingRows) {
      const total = Number(row.total);
      if (row.kind === "claim") {
        claimTotal += total;
        if (row.reviewStatus === "confirmed") claimConfirmed += total;
      } else if (row.kind === "event") {
        eventTotal += total;
        if (row.reviewStatus === "confirmed") eventConfirmed += total;
      }
      if (row.reviewStatus === "proposed") proposedTotal += total;
    }

    const unsupported = await db
      .select({ total: count() })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.caseId, ownedCase.id),
          eq(schema.findings.kind, "claim"),
          sql`not exists (select 1 from casefile_finding_citations c where c.finding_id = ${schema.findings.id})`,
        ),
      );

    const documentsWithText = await db
      .select({ total: sql<number>`count(distinct ${schema.evidencePassages.evidenceId})` })
      .from(schema.evidencePassages)
      .where(eq(schema.evidencePassages.caseId, ownedCase.id));

    // The graph gives the contradiction and gap counts. It is built without
    // persisting so assessing readiness never mutates the case.
    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: false });

    const assessment: ReadinessAssessment = assessReadiness({
      evidenceTotal: Object.values(byStatus).reduce((a, b) => a + b, 0),
      evidencePending: byStatus.pending ?? 0,
      evidenceUnreadable: (byStatus.unsupported ?? 0) + (byStatus.failed ?? 0),
      evidenceRead: byStatus.complete ?? 0,
      claimTotal,
      claimConfirmed,
      eventTotal,
      eventConfirmed,
      proposedTotal,
      unsupportedClaimCount: Number(unsupported[0]?.total ?? 0),
      contradictionCount: graph.counts.contradictions,
      potentialContradictionCount: graph.counts.potentialContradictions,
      gapCount: graph.counts.gaps,
      reportExists: false,
      documentsWithText: Number(documentsWithText[0]?.total ?? 0),
    });

    return { caseId: ownedCase.id, readiness: assessment, counts: graph.counts };
  },
});
