import { and, eq } from "drizzle-orm";

import { touchCase } from "./case-queries.js";
import { classifyDocument } from "./classification.js";
import { evidenceStoreById } from "./evidence-store.js";
import { extractEvidence } from "./extraction.js";
import { newPassageId } from "./ids.js";
import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";

/**
 * Extracts text from a case's evidence and records the passages.
 *
 * This is the whole extraction pass, shared by the `extract-evidence` action
 * and the demo loader so both run the real extractor over the real stored bytes
 * rather than a shortcut. Re-running is idempotent: existing passages for a file
 * are replaced, and the status plus any limitation is written either way, so a
 * failure is visible rather than silent.
 *
 * Callers are responsible for ownership checks before calling this; the queries
 * here are already scoped to `ownerEmail` and `caseId`.
 */

export interface ExtractionResultRow {
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
}

export interface ExtractionRunResult {
  results: ExtractionResultRow[];
  summary: { total: number; complete: number; unsupported: number; failed: number };
}

export async function extractCaseEvidence(input: {
  caseId: string;
  ownerEmail: string;
  evidenceIds?: string[] | undefined;
  force?: boolean | undefined;
}): Promise<ExtractionRunResult> {
  const db = getDb();
  const all = await db
    .select()
    .from(schema.evidence)
    .where(
      and(
        eq(schema.evidence.caseId, input.caseId),
        eq(schema.evidence.ownerEmail, input.ownerEmail),
      ),
    );

  const wanted = input.evidenceIds ? new Set(input.evidenceIds) : null;
  const targets = wanted ? all.filter((row) => wanted.has(row.id)) : all;
  const results: ExtractionResultRow[] = [];

  for (const item of targets) {
    if (
      !input.force &&
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

    // Mark the file as being processed so the UI can show progress. This runs
    // outside the replacement transaction on purpose: it is only a hint, and a
    // status write must never be the thing that serializes extraction.
    await db
      .update(schema.evidence)
      .set({ extractionStatus: "processing", extractionError: null })
      .where(eq(schema.evidence.id, item.id));

    let outcome;
    try {
      const store = evidenceStoreById(item.storageProvider);
      const stored = await store.get({
        ownerEmail: input.ownerEmail,
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

    const extractedText = outcome.passages.map((passage) => passage.text).join("\n");

    // The replacement is the part that must be all-or-nothing: the delete of the
    // stored passages and the insert of the new set commit together or not at
    // all, and the evidence row is locked for the duration (`SELECT … FOR UPDATE`)
    // so two extractions of the same file cannot interleave their writes and
    // leave a doubled or truncated passage set. Extraction itself — the
    // expensive, slow part — runs above, outside the transaction, so a slow file
    // never holds a row lock and concurrent extraction of *different* files never
    // blocks. This lock is a database lock, not a process-local one, so it holds
    // across serverless instances.
    let applied: {
      classification: ReturnType<typeof classifyDocument> | undefined;
      passageCount: number;
    } | null = null;
    try {
      applied = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(schema.evidence)
          .where(
            and(
              eq(schema.evidence.id, item.id),
              eq(schema.evidence.caseId, input.caseId),
              eq(schema.evidence.ownerEmail, input.ownerEmail),
            ),
          )
          .for("update");
        // The row was deleted between the bulk read and here; nothing to update.
        if (!locked) return null;

        // Only a definitive result may replace the stored passages. A failed
        // extraction keeps them: an inability to re-read a file must not destroy
        // text a previous successful run extracted. "unsupported" is a real
        // determination that the file has no text, so it clears them.
        let passageCount: number;
        if (outcome.status === "complete" || outcome.status === "unsupported") {
          await tx
            .delete(schema.evidencePassages)
            .where(eq(schema.evidencePassages.evidenceId, item.id));
          if (outcome.status === "complete" && outcome.passages.length > 0) {
            await tx.insert(schema.evidencePassages).values(
              outcome.passages.map((passage, index) => ({
                id: newPassageId(),
                evidenceId: item.id,
                caseId: input.caseId,
                ownerEmail: input.ownerEmail,
                ordinal: index,
                locatorType: passage.locatorType,
                locatorValue: passage.locatorValue,
                ref: passage.ref,
                text: passage.text,
              })),
            );
          }
          passageCount = outcome.status === "complete" ? outcome.passages.length : 0;
        } else {
          // Failed: the stored set survived, so report its real size rather than 0.
          const surviving = await tx
            .select({ id: schema.evidencePassages.id })
            .from(schema.evidencePassages)
            .where(eq(schema.evidencePassages.evidenceId, item.id));
          passageCount = surviving.length;
        }

        // Classify only from a definitive result. A human correction is never
        // overwritten: once someone has set the type, the classifier stays out of
        // the way. A failed extraction banks nothing new, so it keeps the type the
        // file already had rather than reclassifying it from empty text. An
        // unsupported file is classified from its filename alone, so it still gets
        // a best-effort type rather than none. The correction state is read from
        // the locked row, not the earlier snapshot, so a correction made while
        // extraction was running is respected.
        const keepExistingType =
          Boolean(locked.classificationCorrectedBy) || outcome.status === "failed";
        const classification = keepExistingType
          ? undefined
          : classifyDocument({
              filename: locked.filename,
              mimeType: locked.mimeType,
              text: extractedText,
            });

        await tx
          .update(schema.evidence)
          .set({
            extractionStatus: outcome.status,
            extractionError: outcome.limitation ?? outcome.error ?? null,
            extractedAt: new Date().toISOString(),
            pageCount: outcome.pageCount ?? locked.pageCount ?? null,
            ...(classification
              ? {
                  documentType: classification.documentType,
                  classificationConfidence: classification.confidence,
                  classificationRationale: JSON.stringify(classification.rationale),
                }
              : {}),
          })
          .where(eq(schema.evidence.id, item.id));

        return { classification, passageCount };
      });
    } catch (error) {
      // The replacement transaction rolled back whole: the previous passage set
      // and status are intact. Report the failure in this run's result (so the
      // caller sees it) without overwriting the stored row with a "failed" status
      // that a transient write error does not justify.
      results.push({
        evidenceId: item.id,
        filename: item.filename,
        status: "failed",
        passageCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // The evidence was deleted while we were extracting it; skip reporting.
    if (!applied) continue;

    results.push({
      evidenceId: item.id,
      filename: item.filename,
      status: outcome.status,
      passageCount: applied.passageCount,
      pageCount: outcome.pageCount,
      limitation: outcome.limitation,
      error: outcome.error,
      documentType: applied.classification ? applied.classification.documentType : item.documentType,
      classificationConfidence: applied.classification
        ? applied.classification.confidence
        : item.classificationConfidence,
    });
  }

  await touchCase(input.caseId, input.ownerEmail);

  return {
    results,
    summary: {
      total: results.length,
      complete: results.filter((r) => r.status === "complete").length,
      unsupported: results.filter((r) => r.status === "unsupported").length,
      failed: results.filter((r) => r.status === "failed").length,
    },
  };
}
