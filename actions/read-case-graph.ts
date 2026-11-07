import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildCaseGraph, readRelationships } from "../server/casefile/graph.js";
import { attachGapReviews } from "../server/casefile/investigation.js";

/**
 * Reads a case's cross-document view without changing anything.
 *
 * The comparison pass is deterministic, so reading it recomputes the same
 * relationships, comparisons, and gaps a reviewer last saw instead of replaying
 * a stale snapshot. The relationships themselves come from the stored rows, not
 * the recomputation, so a reviewer keeps the ids they need to confirm or dismiss
 * an edge and sees their earlier decisions rather than a fresh proposal set.
 * `persist: false` keeps a page load read-only: only `build-case-graph` writes.
 */
export default defineAction({
  description:
    "Read a case's cross-document evidence graph: the stored relationships between its documents, the cross-document comparisons (agreement, contradiction, or unresolved), and its evidence gaps. Comparisons and gaps are recomputed deterministically and nothing is written. Run build-case-graph to store new relationships.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose graph to read."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: false });
    const relationships = await readRelationships(ownedCase.id, userEmail);
    // Gaps are derived, so their reviewer verdicts are merged in here; the UI
    // shows each gap's review state beside it.
    const gaps = await attachGapReviews(ownedCase.id, userEmail, graph.gaps);

    return {
      caseId: ownedCase.id,
      counts: { ...graph.counts, relationships: relationships.length },
      relationships,
      comparisons: graph.comparisons,
      gaps,
      note: "Relationships and comparisons are proposals. Review them before relying on any of them.",
    };
  },
});
