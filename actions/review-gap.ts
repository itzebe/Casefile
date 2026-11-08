import { defineAction, ActionContractError } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { GAP_REVIEW_STATUSES } from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { agentClearable } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildCaseGraph } from "../server/casefile/graph.js";
import { newGapReviewId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Records a reviewer's verdict on a derived evidence gap.
 *
 * Gaps are recomputed on every read, so this stores the verdict against the
 * gap's stable `gapKey`. The key is validated against the gaps the engine
 * currently derives, so a caller cannot invent a verdict for a gap that does not
 * exist. A verdict is a human judgement about the record, not a claim that
 * anything happened: `resolved` means the record now establishes the point,
 * `unresolved` that it still does not, `not_applicable` that the question does
 * not bear on this investigation.
 */
export default defineAction({
  description:
    "Mark an evidence gap resolved, unresolved or not applicable. Gaps are recomputed on every read, so the verdict is stored against the gap's stable key and survives re-analysis. Validates the gap against the current record.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the gap belongs to."),
    gapKey: z
      .string()
      .min(1)
      .max(300)
      .describe("The stable key of the gap, as returned by list-evidence-gaps."),
    status: z.enum(GAP_REVIEW_STATUSES).describe("The reviewer's verdict."),
    note: agentClearable(
      z.string().max(2000).nullable().describe("Optional short reason for the verdict."),
    ),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    // Confirm the gap is one the engine currently derives for this case, so a
    // verdict can only attach to a real gap.
    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: false });
    const gap = graph.gaps.find((g) => g.gapKey === args.gapKey);
    if (!gap) {
      throw new ActionContractError("No such evidence gap in this case.", {
        errorCode: "gap_not_found",
        statusCode: 404,
      });
    }

    const db = getDb();
    const now = new Date().toISOString();
    const [existing] = await db
      .select()
      .from(schema.gapReviews)
      .where(
        and(
          eq(schema.gapReviews.caseId, ownedCase.id),
          eq(schema.gapReviews.gapKey, args.gapKey),
          eq(schema.gapReviews.ownerEmail, userEmail),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(schema.gapReviews)
        .set({
          status: args.status,
          note: args.note ?? null,
          gapKind: gap.kind,
          reviewedBy: userEmail,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.gapReviews.id, existing.id),
            eq(schema.gapReviews.ownerEmail, userEmail),
          ),
        );
    } else {
      await db.insert(schema.gapReviews).values({
        id: newGapReviewId(),
        caseId: ownedCase.id,
        ownerEmail: userEmail,
        gapKey: args.gapKey,
        gapKind: gap.kind,
        status: args.status,
        note: args.note ?? null,
        reviewedBy: userEmail,
      });
    }

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "gap.review",
      targetType: "gap",
      targetId: args.gapKey,
      summary: `Gap ${gap.kind} -> ${args.status}`,
      caller,
      runId,
    });

    return { gapKey: args.gapKey, kind: gap.kind, status: args.status };
  },
});
