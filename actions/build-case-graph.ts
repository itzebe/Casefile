import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { buildCaseGraph } from "../server/casefile/graph.js";

/**
 * Builds the cross-document evidence graph for a case.
 *
 * This is the action that makes CASEFILE's cross-document intelligence
 * available to both the UI and the agent: it links passages across documents
 * that share an explicit identifier, amount, party, or date, compares the
 * assertions those passages support, and reports evidence gaps.
 *
 * The relationships it writes are proposals. A person confirms or dismisses an
 * edge, and a dismissed edge is not recreated on the next build.
 */
export default defineAction({
  description:
    "Build the cross-document evidence graph for a case: relationships between documents, cross-document claim comparisons (agreement, contradiction, or unresolved), and evidence gaps. Every relationship records what it matched on and the passage it came from. Results are proposals until a person reviews them.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to build a graph for."),
    persist: z
      .boolean()
      .default(true)
      .describe("Store the derived relationships. Set false to compute without writing."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: args.persist });

    if (args.persist) {
      await touchCase(ownedCase.id, userEmail);
      await recordAudit({
        ownerEmail: userEmail,
        caseId: ownedCase.id,
        actor,
        action: "graph.build",
        targetType: "case",
        targetId: ownedCase.id,
        summary: `${graph.counts.relationships} relationship(s), ${graph.counts.contradictions} contradiction(s), ${graph.counts.gaps} gap(s) across ${graph.counts.documents} document(s)`,
        caller,
        runId,
      });
    }

    return {
      caseId: ownedCase.id,
      counts: graph.counts,
      relationships: graph.relationships,
      comparisons: graph.comparisons,
      gaps: graph.gaps,
      note: "Relationships and comparisons are proposals. Review them before relying on any of them.",
    };
  },
});
