import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { agentDefault, agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { extractCaseEvidence } from "../server/casefile/extraction-run.js";

/**
 * Runs text extraction over stored evidence and records the passages.
 *
 * The pass itself lives in `server/casefile/extraction-run.ts` so the demo
 * loader runs the identical code path. Re-running is safe and idempotent:
 * existing passages for the file are replaced, so a fixed extractor can be
 * re-applied without duplicating text or leaving stale passages behind. The
 * status and any limitation are written to the evidence row either way, so a
 * failure is visible rather than silent.
 */
export default defineAction({
  description:
    "Extract text from a case's evidence so it can be analysed and cited. Pass an evidenceId to extract one file, or omit it to extract every pending file in the case. Records page and row references for each passage.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose evidence to extract."),
    evidenceId: agentOptional(
      z.string().describe("Extract only this file. Omit to extract every file in the case."),
    ),
    force: agentDefault(
      z.boolean().describe("Re-extract files that already have passages."),
      false,
    ),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);

    const { results, summary } = await extractCaseEvidence({
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      evidenceIds: args.evidenceId ? [args.evidenceId] : undefined,
      force: args.force,
    });

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "evidence.extract",
      targetType: "case",
      targetId: ownedCase.id,
      summary: `Extracted ${results.length} file(s): ${results
        .map((r) => r.status)
        .join(", ")}`,
      caller,
      runId,
    });

    return { caseId: ownedCase.id, summary, results };
  },
});
