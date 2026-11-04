import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { EVIDENCE_CATEGORIES } from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase, requireOwnedEvidence } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

export default defineAction({
  description:
    "Change the category of a piece of evidence (receipt, invoice, bank statement, contract, correspondence, policy, screenshot, log, identity, other).",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the evidence belongs to."),
    evidenceId: z.string().min(1).describe("The evidence to recategorize."),
    category: z.enum(EVIDENCE_CATEGORIES).describe("The new category."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    await requireOwnedCase(args.caseId, userEmail);
    const row = await requireOwnedEvidence(args.evidenceId, userEmail, args.caseId);
    const db = getDb();

    await db
      .update(schema.evidence)
      .set({ category: args.category })
      .where(
        and(eq(schema.evidence.id, row.id), eq(schema.evidence.ownerEmail, userEmail)),
      );

    await recordAudit({
      ownerEmail: userEmail,
      caseId: args.caseId,
      actor,
      action: "evidence.categorize",
      targetType: "evidence",
      targetId: row.id,
      summary: `Category ${row.category} -> ${args.category}`,
      caller,
      runId,
    });

    return { evidenceId: row.id, category: args.category };
  },
});
