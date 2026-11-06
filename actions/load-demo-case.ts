import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { DEMO_CASE, DEMO_DOCUMENTS } from "../shared/casefile/demo-case.js";
import { recordAudit } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { storeEvidenceFile } from "../server/casefile/evidence-upload.js";
import { extractCaseEvidence } from "../server/casefile/extraction-run.js";
import { buildCaseGraph } from "../server/casefile/graph.js";
import { newCaseId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Loads the synthetic demonstration case into the caller's own workspace.
 *
 * The documents live in `shared/casefile/demo-case.ts` and are written through
 * the same validate-store-extract-graph path a person's own uploads take, so a
 * judge sees the engine run for real rather than a pre-baked fixture. Nothing
 * here is shared or public: the case belongs to the caller, like any other.
 *
 * It is idempotent by title, so a second call returns the case already in the
 * workspace instead of creating a duplicate. A judge who signs up fresh, with
 * an empty workspace, can open the demo in one step.
 */
export default defineAction({
  description:
    "Load the built-in synthetic demonstration case into this workspace: five documents about a disputed refund, extracted, classified, and analysed so the cross-document contradiction, agreement, and gaps can be reviewed. Safe to call more than once; returns the existing demo case if one is already present.",
  schema: z.object({
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Override the demo case title. Rarely needed."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const db = getDb();
    const title = (args.title ?? DEMO_CASE.title).trim();

    const [existing] = await db
      .select({ id: schema.cases.id })
      .from(schema.cases)
      .where(
        and(eq(schema.cases.ownerEmail, userEmail), eq(schema.cases.title, title)),
      )
      .limit(1);

    if (existing) {
      return {
        caseId: existing.id,
        created: false as const,
        message: "The demonstration case is already in your workspace.",
      };
    }

    const caseId = newCaseId();
    await db.insert(schema.cases).values({
      id: caseId,
      ownerEmail: userEmail,
      title,
      description: DEMO_CASE.description,
      category: DEMO_CASE.category,
      amountMinor: DEMO_CASE.amountMinor,
      currency: DEMO_CASE.currency,
      status: "open",
    });

    await recordAudit({
      ownerEmail: userEmail,
      caseId,
      actor,
      action: "case.create",
      targetType: "case",
      targetId: caseId,
      summary: "Loaded the synthetic demonstration case",
      caller,
      runId,
    });

    for (const doc of DEMO_DOCUMENTS) {
      const outcome = await storeEvidenceFile({
        caseId,
        ownerEmail: userEmail,
        filename: doc.filename,
        data: new TextEncoder().encode(doc.text),
        declaredMimeType: doc.mimeType,
        category: doc.category,
      });
      if (outcome.kind === "rejected") {
        // The bundled documents are known-good, so a rejection means the
        // validator and the fixture have diverged. Surface it rather than
        // shipping a demo with a silently missing document.
        throw new Error(`Demo document ${doc.filename} was rejected: ${outcome.message}`);
      }
    }

    const { summary } = await extractCaseEvidence({ caseId, ownerEmail: userEmail });
    const graph = await buildCaseGraph(caseId, userEmail, { persist: true });

    await recordAudit({
      ownerEmail: userEmail,
      caseId,
      actor,
      action: "graph.build",
      targetType: "case",
      targetId: caseId,
      summary: `Demo case loaded: ${summary.complete}/${summary.total} document(s) read, ${graph.counts.contradictions} contradiction(s), ${graph.counts.gaps} gap(s)`,
      caller,
      runId,
    });

    return {
      caseId,
      created: true as const,
      documents: summary,
      counts: graph.counts,
      message: "The demonstration case is ready to review.",
    };
  },
});
