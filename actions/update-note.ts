import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { NOTE_STATUSES } from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { casefileContext } from "../server/casefile/context.js";
import { newNoteId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Creates or edits an investigator note.
 *
 * Notes are a human record. The body is stored verbatim (trimmed), attributed
 * to the resolved caller, and an edit stamps `editedBy`/`editedAt` so the note
 * shows it was changed and by whom. Nothing in extraction or analysis writes
 * here, so a note is never overwritten by a later model run.
 */
export default defineAction({
  description:
    "Create or edit an investigator note on a case, optionally anchored to a finding. Notes are the human's own record: they are attributed, never overwritten by analysis, and can be marked open or resolved.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the note belongs to."),
    noteId: z
      .string()
      .optional()
      .describe("Edit this note. Omit to create a new one."),
    body: z
      .string()
      .min(1)
      .max(4000)
      .describe("The note text. Stored as written."),
    findingId: z
      .string()
      .nullable()
      .optional()
      .describe("Optionally anchor the note to a finding in this case."),
    status: z.enum(NOTE_STATUSES).optional().describe("open or resolved."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    // An anchor must be a finding in this case, or it would let a note point at
    // another case's row.
    if (args.findingId) {
      const [finding] = await db
        .select({ id: schema.findings.id })
        .from(schema.findings)
        .where(
          and(
            eq(schema.findings.id, args.findingId),
            eq(schema.findings.caseId, ownedCase.id),
            eq(schema.findings.ownerEmail, userEmail),
          ),
        )
        .limit(1);
      if (!finding) throw new Error("Finding not found in this case.");
    }

    const now = new Date().toISOString();

    if (args.noteId) {
      const [existing] = await db
        .select()
        .from(schema.investigationNotes)
        .where(
          and(
            eq(schema.investigationNotes.id, args.noteId),
            eq(schema.investigationNotes.caseId, ownedCase.id),
            eq(schema.investigationNotes.ownerEmail, userEmail),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Note not found.");

      await db
        .update(schema.investigationNotes)
        .set({
          body: args.body.trim(),
          findingId: args.findingId === undefined ? existing.findingId : args.findingId,
          status: args.status ?? existing.status,
          editedBy: userEmail,
          editedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.investigationNotes.id, existing.id),
            eq(schema.investigationNotes.ownerEmail, userEmail),
          ),
        );
      await touchCase(ownedCase.id, userEmail);
      await recordAudit({
        ownerEmail: userEmail,
        caseId: ownedCase.id,
        actor,
        action: "note.update",
        targetType: "note",
        targetId: existing.id,
        summary: `Updated note (${args.status ?? existing.status})`,
        caller,
        runId,
      });
      return { id: existing.id, created: false, status: args.status ?? existing.status };
    }

    const id = newNoteId();
    await db.insert(schema.investigationNotes).values({
      id,
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      findingId: args.findingId ?? null,
      body: args.body.trim(),
      status: args.status ?? "open",
    });
    await touchCase(ownedCase.id, userEmail);
    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "note.create",
      targetType: "note",
      targetId: id,
      summary: args.findingId ? "Created note on a finding" : "Created note",
      caller,
      runId,
    });
    return { id, created: true, status: args.status ?? "open" };
  },
});
