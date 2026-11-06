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

    // Replace rather than append, so re-extraction cannot double the record.
    await db
      .delete(schema.evidencePassages)
      .where(eq(schema.evidencePassages.evidenceId, item.id));

    if (outcome.status === "complete" && outcome.passages.length > 0) {
      await db.insert(schema.evidencePassages).values(
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

    // Classify from the extracted text. A human correction is never
    // overwritten: once someone has set the type, the classifier stays out of
    // the way. An unsupported file is classified from its filename alone, so it
    // still gets a best-effort type rather than none.
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
