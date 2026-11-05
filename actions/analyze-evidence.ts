import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";
import { analyzeCaseEvidence } from "../server/casefile/analysis.js";
import { persistAnalysis } from "../server/casefile/analysis-persistence.js";

/**
 * Runs the investigation model over a case's extracted evidence and records
 * what it proposes.
 *
 * Two properties matter here:
 *
 *  - Only files that extracted cleanly are analysed. A file that could not be
 *    read is reported, never quietly treated as empty evidence.
 *  - Nothing is confirmed. Every row is written with `reviewStatus: proposed`
 *    and the provenance the server derived from the citations, so the UI and
 *    the agent both show a proposal until a human accepts it.
 *
 * Re-running replaces the previous proposals for the case. A proposal that a
 * human already corrected is never overwritten.
 */
export default defineAction({
  description:
    "Analyse a case's extracted evidence and propose claims, events, and parties. Every proposal carries its source passages, and is written as a proposal - never as a confirmed fact. Re-running keeps any finding a human has already reviewed.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to analyse."),
    replaceUnreviewed: z
      .boolean()
      .default(true)
      .describe("Replace previous proposals that no human has reviewed yet."),
  }),
  http: { method: "POST" },
  needsApproval: false,
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const extracted = await db
      .select({ id: schema.evidence.id })
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.caseId, ownedCase.id),
          eq(schema.evidence.ownerEmail, userEmail),
          eq(schema.evidence.extractionStatus, "complete"),
        ),
      );

    if (extracted.length === 0) {
      // Say exactly what to do next instead of returning an empty analysis that
      // looks like "no findings".
      fail(
        "No evidence in this case has extracted text yet. Upload a document and run extractEvidence first.",
        { errorCode: "no_extracted_evidence", statusCode: 409 },
      );
    }

    const analysis = await analyzeCaseEvidence(ownedCase.id, userEmail, {
      signal: ctx?.signal,
    });

    const persisted = await persistAnalysis({
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      analysis,
      replaceUnreviewed: args.replaceUnreviewed,
    });
    const { claimIds, eventIds } = persisted;

    await touchCase(ownedCase.id, userEmail);
    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "evidence.analyze",
      targetType: "case",
      targetId: ownedCase.id,
      summary: `Proposed ${claimIds.length} claim(s), ${eventIds.length} event(s), ${analysis.parties.length} party(ies) from ${analysis.passagesSent} passage(s)`,
      caller,
      runId,
    });

    return {
      caseId: ownedCase.id,
      claimsProposed: claimIds.length,
      eventsProposed: eventIds.length,
      parties: analysis.parties,
      passagesAnalyzed: analysis.passagesSent,
      truncated: analysis.truncated,
      note: "All results are proposals. Review them before relying on any of them.",
    };
  },
});
