import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { recordAudit, requireOwnedCase, requireOwnedEvidence } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { classifyDocument } from "../server/casefile/classification.js";
import { evidenceStoreById } from "../server/casefile/evidence-store.js";
import { extractEvidence } from "../server/casefile/extraction.js";
import { newPassageId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Runs text extraction over stored evidence and records the passages.
 *
 * Re-running is safe and idempotent: existing passages for the file are
 * replaced, so a fixed extractor can be re-applied without duplicating text or
 * leaving stale passages behind. The status and any limitation are written to
 * the evidence row either way, so a failure is visible rather than silent.
 */
export default defineAction({
  description:
    "Extract text from a case's evidence so it can be analysed and cited. Pass an evidenceId to extract one file, or omit it to extract every pending file in the case. Records page and row references for each passage.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose evidence to extract."),
    evidenceId: z
      .string()
      .optional()
      .describe("Extract only this file. Omit to extract every file in the case."),
    force: z
      .boolean()
      .default(false)
      .describe("Re-extract files that already have passages."),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const targets = args.evidenceId
      ? [await requireOwnedEvidence(args.evidenceId, userEmail, args.caseId)]
      : await db
          .select()
          .from(schema.evidence)
          .where(
            and(
              eq(schema.evidence.caseId, ownedCase.id),
              eq(schema.evidence.ownerEmail, userEmail),
            ),
          );

    const results: Array<{
      evidenceId: string;
      filename: string;
      status: string;
      passageCount: number;
      pageCount?: number | undefined;
      limitation?: string | undefined;
      error?: string | undefined;
      skipped?: boolean | undefined;
      documentType?: string | undefined;
      classificationConfidence?: string | null | undefined;
    }> = [];

    for (const item of targets) {
      if (
        !args.force &&
        (item.extractionStatus === "complete" || item.extractionStatus === "unsupported")
      ) {
        const existing = await db
          .select({ id: schema.evidencePassages.id })
          .from(schema.evidencePassages)
          .where(eq(schema.evidencePassages.evidenceId, item.id));
        results.push({
          evidenceId: item.id,
          filename: item.filename,
          status: item.extractionStatus,
          passageCount: existing.length,
          pageCount: item.pageCount ?? undefined,
          limitation: item.extractionError ?? undefined,
          skipped: true,
          documentType: item.documentType,
          classificationConfidence: item.classificationConfidence,
        });
        continue;
      }

      await db
        .update(schema.evidence)
        .set({ extractionStatus: "processing", extractionError: null })
        .where(eq(schema.evidence.id, item.id));

      let outcome;
      try {
        const store = evidenceStoreById(item.storageProvider);
        const stored = await store.get({
          ownerEmail: userEmail,
          storageKey: item.storageKey,
        });
        if (!stored) {
          outcome = {
            status: "failed" as const,
            passages: [],
            error: "The stored file could not be found.",
          };
        } else {
          outcome = await extractEvidence({
            mimeType: item.mimeType,
            filename: item.filename,
            data: stored.data,
          });
        }
      } catch (error) {
        outcome = {
          status: "failed" as const,
          passages: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // Replace rather than append, so re-extraction cannot double the record.
      await db
        .delete(schema.evidencePassages)
        .where(eq(schema.evidencePassages.evidenceId, item.id));

      if (outcome.status === "complete" && outcome.passages.length > 0) {
        await db.insert(schema.evidencePassages).values(
          outcome.passages.map((passage, index) => ({
            id: newPassageId(),
            evidenceId: item.id,
            caseId: ownedCase.id,
            ownerEmail: userEmail,
            ordinal: index,
            locatorType: passage.locatorType,
            locatorValue: passage.locatorValue,
            ref: passage.ref,
            text: passage.text,
          })),
        );
      }

      // Classify from the extracted text. A human correction is never
      // overwritten: once someone has set the type, the classifier stays out of
      // the way. An unsupported file is classified from its filename alone, so
      // it still gets a best-effort type rather than none.
      const extractedText = outcome.passages.map((passage) => passage.text).join("\n");
      const classification = classifyDocument({
        filename: item.filename,
        mimeType: item.mimeType,
        text: extractedText,
      });
      const keepHumanType = Boolean(item.classificationCorrectedBy);

      await db
        .update(schema.evidence)
        .set({
          extractionStatus: outcome.status,
          extractionError: outcome.limitation ?? outcome.error ?? null,
          extractedAt: new Date().toISOString(),
          pageCount: outcome.pageCount ?? item.pageCount ?? null,
          ...(keepHumanType
            ? {}
            : {
                documentType: classification.documentType,
                classificationConfidence: classification.confidence,
                classificationRationale: JSON.stringify(classification.rationale),
              }),
        })
        .where(eq(schema.evidence.id, item.id));

      results.push({
        evidenceId: item.id,
        filename: item.filename,
        status: outcome.status,
        passageCount: outcome.passages.length,
        pageCount: outcome.pageCount,
        limitation: outcome.limitation,
        error: outcome.error,
        documentType: keepHumanType ? item.documentType : classification.documentType,
        classificationConfidence: keepHumanType
          ? item.classificationConfidence
          : classification.confidence,
      });
    }

    await touchCase(ownedCase.id, userEmail);

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

    const complete = results.filter((r) => r.status === "complete").length;
    const unsupported = results.filter((r) => r.status === "unsupported").length;
    const failed = results.filter((r) => r.status === "failed").length;

    return {
      caseId: ownedCase.id,
      summary: { total: results.length, complete, unsupported, failed },
      results,
    };
  },
});
