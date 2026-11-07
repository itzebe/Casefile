import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { listNotes } from "../server/casefile/investigation.js";

/**
 * Reads the investigator's own notes for a case.
 *
 * A note is the human's record, so this returns only what a person wrote; the
 * agent reads notes to stay in step with the investigation but never authors
 * one on a person's behalf.
 */
export default defineAction({
  description:
    "List the investigator's notes for a case, newest first. A note may be anchored to a finding. Notes are the human's own record and are never rewritten by analysis.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose notes to read."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const rows = await listNotes(ownedCase.id, userEmail);
    return {
      caseId: ownedCase.id,
      notes: rows.map((row) => ({
        id: row.id,
        findingId: row.findingId,
        body: row.body,
        status: row.status,
        editedBy: row.editedBy,
        editedAt: row.editedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      count: rows.length,
    };
  },
});
