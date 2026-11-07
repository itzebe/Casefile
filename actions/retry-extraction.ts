import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { extractCaseEvidence } from "../server/casefile/extraction-run.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Retries extraction for the files in a case that failed or never ran.
 *
 * `extract-evidence` can re-run any file, but a person looking at a case needs
 * the narrow operation: try again the ones that are not done. This selects only
 * `failed` and `pending` files (a `complete` or `unsupported` file is a
 * determination, not a failure, and is left alone) and runs the same shared
 * extraction pass. A failed extraction keeps its previously extracted passages,
 * so a retry never destroys text a successful earlier run produced.
 */
export default defineAction({
  description:
    "Retry text extraction for the files in a case that failed or are still pending. Leaves successfully extracted files alone. Re-runs the same extraction pass as extract-evidence and reports each file's new status.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose failed files to retry."),
    evidenceId: z
      .string()
      .optional()
      .describe("Retry only this file. Omit to retry every failed or pending file."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const rows = await db
      .select({
        id: schema.evidence.id,
        extractionStatus: schema.evidence.extractionStatus,
      })
      .from(schema.evidence)
      .where(
        and(
          eq(schema.evidence.caseId, ownedCase.id),
          eq(schema.evidence.ownerEmail, userEmail),
        ),
      );

    const targets = rows
      .filter((row) =>
        args.evidenceId ? row.id === args.evidenceId : row.extractionStatus !== "complete",
      )
      // A complete/unsupported file is a determination, not a failure: only a
      // failed or pending file is retried.
      .filter((row) =>
        args.evidenceId
          ? true
          : row.extractionStatus === "failed" || row.extractionStatus === "pending",
      )
      .map((row) => row.id);

    if (targets.length === 0) {
      return {
        caseId: ownedCase.id,
        retried: 0,
        summary: { total: 0, complete: 0, unsupported: 0, failed: 0 },
        results: [],
        note: "No failed or pending files to retry.",
      };
    }

    const { results, summary } = await extractCaseEvidence({
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      evidenceIds: targets,
      force: true,
    });

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "evidence.retry",
      targetType: "case",
      targetId: ownedCase.id,
      summary: `Retried ${targets.length} file(s): ${results.map((r) => r.status).join(", ")}`,
      caller,
      runId,
    });

    return { caseId: ownedCase.id, retried: targets.length, summary, results };
  },
});
