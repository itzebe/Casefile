import { and, asc, desc, eq } from "drizzle-orm";

import type { GapRecord } from "./graph.js";
import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";

/**
 * Human review of derived evidence gaps, and investigator notes.
 *
 * Gaps are recomputed on every read (`graph.ts`), so a reviewer's verdict is
 * stored against the gap's stable `gapKey` rather than a row. This module is the
 * single place that joins the two, so every reader - the action, the case
 * loader, the agent - sees the same reviewed/unreviewed state.
 */

export interface GapReviewRow {
  gapKey: string;
  status: string;
  note: string | null;
  reviewedBy: string;
  updatedAt: string;
}

/** A gap with its reviewer verdict merged in. */
export interface ReviewedGap extends GapRecord {
  reviewStatus: string;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export async function loadGapReviews(
  caseId: string,
  userEmail: string,
): Promise<Map<string, GapReviewRow>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.gapReviews)
    .where(
      and(eq(schema.gapReviews.caseId, caseId), eq(schema.gapReviews.ownerEmail, userEmail)),
    );
  return new Map(
    rows.map((row) => [
      row.gapKey,
      {
        gapKey: row.gapKey,
        status: row.status,
        note: row.note,
        reviewedBy: row.reviewedBy,
        updatedAt: row.updatedAt,
      },
    ]),
  );
}

/**
 * Merges reviewer verdicts onto the derived gaps. A gap with no verdict is
 * `open` - the absence of a decision, never an implicit approval.
 */
export async function attachGapReviews(
  caseId: string,
  userEmail: string,
  gaps: GapRecord[],
): Promise<ReviewedGap[]> {
  const reviews = await loadGapReviews(caseId, userEmail);
  return gaps.map((gap) => {
    const review = reviews.get(gap.gapKey);
    return {
      ...gap,
      reviewStatus: review?.status ?? "open",
      reviewNote: review?.note ?? null,
      reviewedBy: review?.reviewedBy ?? null,
      reviewedAt: review?.updatedAt ?? null,
    };
  });
}

export async function listNotes(caseId: string, userEmail: string) {
  const db = getDb();
  return db
    .select()
    .from(schema.investigationNotes)
    .where(
      and(
        eq(schema.investigationNotes.caseId, caseId),
        eq(schema.investigationNotes.ownerEmail, userEmail),
      ),
    )
    .orderBy(desc(schema.investigationNotes.updatedAt), asc(schema.investigationNotes.id));
}
