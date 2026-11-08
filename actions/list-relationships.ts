import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { readRelationships } from "../server/casefile/graph.js";

/**
 * Reads the stored cross-document relationships for a case.
 *
 * Distinct from build-case-graph: this only reads what is already stored and
 * never recomputes or writes, so a page load is cheap and a reviewer sees the
 * relationships as they were last built - including any they confirmed or
 * dismissed.
 */
export default defineAction({
  description:
    "List the stored cross-document relationships for a case, each with the identifier it matched on, whether it is direct or inferred, its review status, and the passage it came from. Run buildCaseGraph to produce them.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose relationships to read."),
    relationType: agentOptional(
      z
        .enum([
          "same_identifier",
          "same_amount",
          "same_date",
          "same_party",
          "corroborates",
          "contradicts",
          "potential_contradiction",
          "addresses_gap",
        ])
        .describe("Filter to one relationship type."),
    ),
    reviewStatus: agentOptional(
      z
        .enum(["proposed", "confirmed", "rejected"])
        .describe("Filter to one review status."),
    ),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    const relationships = (await readRelationships(ownedCase.id, userEmail))
      .filter((row) => !args.relationType || row.relationType === args.relationType)
      .filter((row) => !args.reviewStatus || row.reviewStatus === args.reviewStatus);

    return {
      caseId: ownedCase.id,
      relationships,
      counts: {
        total: relationships.length,
        byType: relationships.reduce<Record<string, number>>((acc, row) => {
          acc[row.relationType] = (acc[row.relationType] ?? 0) + 1;
          return acc;
        }, {}),
      },
    };
  },
});
