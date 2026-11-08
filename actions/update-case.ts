import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { CASE_STATUSES, DISPUTE_CATEGORIES } from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { agentClearable, agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

export default defineAction({
  description:
    "Update a case's details or status. Only the fields you pass are changed. Use this to move a case to investigating, review, or closed, or to correct its title, description, category, or amount.",
  schema: z
    .object({
      caseId: z.string().min(1).describe("The case to update."),
      title: agentOptional(z.string().min(1).max(200)),
      description: agentOptional(z.string().max(5000)),
      category: agentOptional(z.enum(DISPUTE_CATEGORIES)),
      status: agentOptional(z.enum(CASE_STATUSES)),
      amountMinor: agentClearable(z.number().int().nonnegative().nullable()),
      currency: agentClearable(z.string().length(3).nullable()),
    })
    .refine(
      (value) =>
        value.title !== undefined ||
        value.description !== undefined ||
        value.category !== undefined ||
        value.status !== undefined ||
        value.amountMinor !== undefined ||
        value.currency !== undefined,
      { message: "Provide at least one field to update." },
    ),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const existing = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const changes: Record<string, unknown> = {};
    if (args.title !== undefined) changes.title = args.title.trim();
    if (args.description !== undefined) changes.description = args.description.trim();
    if (args.category !== undefined) changes.category = args.category;
    if (args.status !== undefined) changes.status = args.status;
    if (args.amountMinor !== undefined) changes.amountMinor = args.amountMinor;
    if (args.currency !== undefined) {
      changes.currency = args.currency ? args.currency.toUpperCase() : null;
    }

    if (Object.keys(changes).length > 0) {
      await db
        .update(schema.cases)
        .set(changes)
        .where(and(eq(schema.cases.id, existing.id), eq(schema.cases.ownerEmail, userEmail)));
      await touchCase(existing.id, userEmail);
    }

    await recordAudit({
      ownerEmail: userEmail,
      caseId: existing.id,
      actor,
      action: "case.update",
      targetType: "case",
      targetId: existing.id,
      // Field names only: a description can contain sensitive narrative.
      summary: `Updated ${Object.keys(changes).join(", ") || "nothing"}`,
      caller,
      runId,
    });

    return { id: existing.id, changed: Object.keys(changes) };
  },
});
