import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildCaseGraph } from "../server/casefile/graph.js";
import { attachGapReviews } from "../server/casefile/investigation.js";

/**
 * Reports what is missing from a case's record.
 *
 * Every gap names what is missing, the assertion it affects, why it matters, and
 * the kind of evidence that would resolve it. A gap is never a conclusion that
 * something did not happen; it is a statement that the record does not currently
 * establish it.
 */
export default defineAction({
  description:
    "Identify evidence gaps in a case: assertions with no source, amounts with no matching transaction record, events with conflicting or missing dates, single-source claims, and contractual obligations with no evidence of performance. Each gap says what is missing, why it matters, and what evidence would resolve it. Missing information is never treated as proof an event did not happen.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to analyse for gaps."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: false });
    const gaps = await attachGapReviews(ownedCase.id, userEmail, graph.gaps);

    return {
      caseId: ownedCase.id,
      gaps,
      counts: {
        total: gaps.length,
        reviewed: gaps.filter((gap) => gap.reviewStatus !== "open").length,
        open: gaps.filter((gap) => gap.reviewStatus === "open").length,
        byKind: gaps.reduce<Record<string, number>>((acc, gap) => {
          acc[gap.kind] = (acc[gap.kind] ?? 0) + 1;
          return acc;
        }, {}),
      },
      note: "A gap means the record does not currently establish something. It is not a finding that the event did not occur. reviewStatus is a human verdict on the gap, stored against its stable gapKey.",
    };
  },
});
