import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Archiving is reversible by design. A closed case keeps its evidence and
 * findings so the record stays intact; deleting a case would destroy material a
 * dispute may still need. Evidence removal is a separate, explicit action.
 */
export default defineAction({
  description:
    "Archive a case by setting its status to closed. Evidence and findings are retained. Reopen it with updateCase.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to archive."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const existing = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    await db
      .update(schema.cases)
      .set({ status: "closed" })
      .where(and(eq(schema.cases.id, existing.id), eq(schema.cases.ownerEmail, userEmail)));
    await touchCase(existing.id, userEmail);

    await recordAudit({
      ownerEmail: userEmail,
      caseId: existing.id,
      actor,
      action: "case.archive",
      targetType: "case",
      targetId: existing.id,
      summary: `Archived case (was ${existing.status})`,
      caller,
      runId,
    });

    return { id: existing.id, status: "closed" as const };
  },
});
