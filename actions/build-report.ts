import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildReport } from "../server/casefile/report.js";

/**
 * Builds the investigation report as structured data.
 *
 * The report is assembled from the case's stored record - claims, events,
 * contradictions, gaps, and the document register - so it can be rendered,
 * reviewed, and exported. It is a read: nothing about the case changes.
 */
export default defineAction({
  description:
    "Build the investigation report for a case as structured data: overview, scope, document register, timeline, claims, contradictions, missing evidence, field-specific analysis, outstanding questions, next steps, and review history. Every statement keeps its citations and review status.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to report on."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    await requireOwnedCase(args.caseId, userEmail);

    const report = await buildReport(args.caseId, userEmail);

    await recordAudit({
      ownerEmail: userEmail,
      caseId: args.caseId,
      actor,
      action: "report.build",
      targetType: "case",
      targetId: args.caseId,
      summary: `Report built: ${report.documentRegister.length} document(s), ${report.claims.length} claim(s), ${report.reviewSummary.proposed} proposed`,
      caller,
      runId,
    });

    return report;
  },
});
