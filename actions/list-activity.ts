import { defineAction } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Reads a case's activity history: the audit trail of every write that touched
 * it, newest first.
 *
 * The audit log already records each write (see `recordAudit`), but until now
 * nothing read it back, so the trail was write-only. This surfaces it so a
 * reviewer can see who did what and when — including the agent, whose writes are
 * recorded with `caller: "agent"` exactly like a person's. Read-only.
 */
export default defineAction({
  description:
    "Read a case's activity history: the audit trail of writes that touched the case (uploads, extraction, analysis, reviews, exports), newest first, with the actor and whether it came from the UI or the agent. Read-only.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose activity to read."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("How many of the most recent entries to return."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const rows = await db
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        actor: schema.auditLog.actor,
        caller: schema.auditLog.caller,
        targetType: schema.auditLog.targetType,
        targetId: schema.auditLog.targetId,
        summary: schema.auditLog.summary,
        createdAt: schema.auditLog.createdAt,
      })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.caseId, ownedCase.id),
          eq(schema.auditLog.ownerEmail, userEmail),
        ),
      )
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(args.limit);

    return {
      caseId: ownedCase.id,
      count: rows.length,
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        actor: row.actor,
        // A person reaches the app through the UI (frontend/http); the agent
        // reaches it as a tool call. Anything else is treated as agent-side, so
        // an unfamiliar caller is never mislabelled as the person.
        source: row.caller === "frontend" || row.caller === "http" ? "you" : "agent",
        targetType: row.targetType,
        targetId: row.targetId,
        summary: row.summary,
        createdAt: row.createdAt,
      })),
    };
  },
});
