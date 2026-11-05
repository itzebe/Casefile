import { defineAction } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { DOCUMENT_TYPES } from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase, requireOwnedEvidence } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { classifyDocument } from "../server/casefile/classification.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Sets, or re-proposes, a document's type.
 *
 * Omit `documentType` to run the automatic classifier over the file's stored
 * passages again (useful after the classifier improves, or after an
 * unsupported file's text becomes available). Pass `documentType` to record a
 * human decision, which the classifier will not later overwrite.
 *
 * The rationale is stored so the UI can show why a type was proposed, and a
 * human correction records who made it.
 */
export default defineAction({
  description:
    "Classify a document, or correct its classification. Omit documentType to re-run the automatic classifier from the document's extracted text; pass documentType to set the type yourself (which the automatic classifier will then leave alone).",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the evidence belongs to."),
    evidenceId: z.string().min(1).describe("The evidence to classify."),
    documentType: z
      .enum(DOCUMENT_TYPES)
      .optional()
      .describe("The type to set. Omit to re-run automatic classification."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    await requireOwnedCase(args.caseId, userEmail);
    const row = await requireOwnedEvidence(args.evidenceId, userEmail, args.caseId);
    const db = getDb();

    if (args.documentType) {
      await db
        .update(schema.evidence)
        .set({
          documentType: args.documentType,
          classificationConfidence: "high",
          classificationRationale: JSON.stringify(["set by a reviewer"]),
          classificationCorrectedBy: userEmail,
          classificationCorrectedAt: new Date().toISOString(),
        })
        .where(
          and(eq(schema.evidence.id, row.id), eq(schema.evidence.ownerEmail, userEmail)),
        );

      await touchCase(args.caseId, userEmail);
      await recordAudit({
        ownerEmail: userEmail,
        caseId: args.caseId,
        actor,
        action: "evidence.classify",
        targetType: "evidence",
        targetId: row.id,
        summary: `Document type ${row.documentType} -> ${args.documentType} (by reviewer)`,
        caller,
        runId,
      });

      return {
        evidenceId: row.id,
        documentType: args.documentType,
        confidence: "high",
        corrected: true,
      };
    }

    const passages = await db
      .select({ text: schema.evidencePassages.text })
      .from(schema.evidencePassages)
      .where(eq(schema.evidencePassages.evidenceId, row.id))
      .orderBy(asc(schema.evidencePassages.ordinal));

    const classification = classifyDocument({
      filename: row.filename,
      mimeType: row.mimeType,
      text: passages.map((passage) => passage.text).join("\n"),
    });

    await db
      .update(schema.evidence)
      .set({
        documentType: classification.documentType,
        classificationConfidence: classification.confidence,
        classificationRationale: JSON.stringify(classification.rationale),
        // Re-running the classifier clears a prior human correction, because
        // this call is the reviewer explicitly asking for the automatic result.
        classificationCorrectedBy: null,
        classificationCorrectedAt: null,
      })
      .where(and(eq(schema.evidence.id, row.id), eq(schema.evidence.ownerEmail, userEmail)));

    await touchCase(args.caseId, userEmail);
    await recordAudit({
      ownerEmail: userEmail,
      caseId: args.caseId,
      actor,
      action: "evidence.classify",
      targetType: "evidence",
      targetId: row.id,
      summary: `Reclassified as ${classification.documentType} (${classification.confidence})`,
      caller,
      runId,
    });

    return {
      evidenceId: row.id,
      documentType: classification.documentType,
      confidence: classification.confidence,
      rationale: classification.rationale,
      summary: classification.summary,
      corrected: false,
    };
  },
});
