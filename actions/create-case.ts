import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { DISPUTE_CATEGORIES, CASE_STATUSES } from "../shared/casefile/types.js";
import { recordAudit } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { newCaseId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

export default defineAction({
  description:
    "Open a new investigation case. Use this before uploading evidence: evidence and findings are always attached to a case. Returns the new case id.",
  schema: z.object({
    title: z.string().min(1).max(200).describe("Short name for the case."),
    description: z
      .string()
      .max(5000)
      .default("")
      .describe("What is being investigated, in the user's own words."),
    category: z
      .enum(DISPUTE_CATEGORIES)
      .default("uncategorized")
      .describe("The kind of dispute under investigation."),
    amountMinor: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Disputed amount in minor units (cents), if known."),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe("ISO 4217 currency code for amountMinor, e.g. USD."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const db = getDb();
    const id = newCaseId();
    const now = new Date().toISOString();

    await db.insert(schema.cases).values({
      id,
      ownerEmail: userEmail,
      title: args.title.trim(),
      description: args.description.trim(),
      category: args.category,
      amountMinor: args.amountMinor ?? null,
      currency: args.currency ? args.currency.toUpperCase() : null,
      status: "open",
    });

    await recordAudit({
      ownerEmail: userEmail,
      caseId: id,
      actor,
      action: "case.create",
      targetType: "case",
      targetId: id,
      summary: `Created case "${args.title.trim().slice(0, 120)}"`,
      caller,
      runId,
    });

    return {
      id,
      title: args.title.trim(),
      status: "open" as const,
      createdAt: now,
    };
  },
});
