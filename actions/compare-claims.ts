import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildCaseGraph } from "../server/casefile/graph.js";

/**
 * Compares the assertions in a case across its documents.
 *
 * Read-only and deterministic: it recomputes the comparison from the stored
 * findings and passages, so the same case always yields the same verdicts and a
 * reviewer is never shown a different answer each time they look. It never
 * writes and never calls a model.
 *
 * Pass a `findingId` to see only the comparisons that involve one finding, which
 * is how the UI answers "what in the record agrees with or contradicts this?".
 */
export default defineAction({
  description:
    "Compare claims and events across a case's documents. Returns each pair that is about the same subject with a verdict: direct agreement, partial agreement, contradiction, potential contradiction, or insufficient information. Every comparison keeps both assertions and their exact source passages. Filter to one finding with findingId.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to compare."),
    findingId: agentOptional(
      z.string().describe("Only return comparisons that involve this finding."),
    ),
    verdict: agentOptional(
      z
        .enum([
          "direct_agreement",
          "partial_agreement",
          "contradiction",
          "potential_contradiction",
          "insufficient_information",
        ])
        .describe("Only return comparisons with this verdict."),
    ),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    // Compute without persisting: this action must not mutate the record.
    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: false });

    const comparisons = graph.comparisons
      .filter((comparison) => !args.findingId || comparison.aId === args.findingId || comparison.bId === args.findingId)
      .filter((comparison) => !args.verdict || comparison.verdict === args.verdict);

    return {
      caseId: ownedCase.id,
      comparisons,
      counts: {
        total: comparisons.length,
        contradiction: comparisons.filter((c) => c.verdict === "contradiction").length,
        potentialContradiction: comparisons.filter(
          (c) => c.verdict === "potential_contradiction",
        ).length,
        agreement: comparisons.filter(
          (c) => c.verdict === "direct_agreement" || c.verdict === "partial_agreement",
        ).length,
        insufficient: comparisons.filter((c) => c.verdict === "insufficient_information")
          .length,
      },
      note: "A difference is not automatically a contradiction. Only incompatible assertions about the same subject are reported as contradictions.",
    };
  },
});
