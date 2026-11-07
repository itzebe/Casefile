import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import { newCitationId, newFindingId } from "./ids.js";
import type { AnalysisResult } from "./analysis.js";

/**
 * Persists an analysis result as proposed findings.
 *
 * This is separated from the `analyze-evidence` action so the same persistence
 * path can be exercised in tests: a test that only called the analysis function
 * would verify the model plumbing but not what actually lands in the database,
 * and it is the stored row that the UI, the agent, and the cross-document engine
 * all read.
 *
 * Every row is written `proposed`. The server derives provenance from the
 * citations, so a finding the model labelled "documented" but did not cite is
 * stored as `unverified`.
 */
export interface PersistAnalysisInput {
  caseId: string;
  ownerEmail: string;
  analysis: AnalysisResult;
  /** Replace previous proposals no human has reviewed. Reviewed rows are kept. */
  replaceUnreviewed?: boolean;
}

export interface PersistedAnalysis {
  claimIds: string[];
  eventIds: string[];
  removedProposals: number;
}

export async function persistAnalysis(input: PersistAnalysisInput): Promise<PersistedAnalysis> {
  const db = getDb();
  const { caseId, ownerEmail, analysis } = input;
  const replaceUnreviewed = input.replaceUnreviewed ?? true;

  let removedProposals = 0;
  if (replaceUnreviewed) {
    const previous = await db
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.caseId, caseId),
          eq(schema.findings.ownerEmail, ownerEmail),
          eq(schema.findings.reviewStatus, "proposed"),
        ),
      );
    for (const finding of previous) {
      await db
        .delete(schema.findingCitations)
        .where(eq(schema.findingCitations.findingId, finding.id));
      await db.delete(schema.findings).where(eq(schema.findings.id, finding.id));
      removedProposals += 1;
    }
  }

  const insertFinding = async (row: {
    kind: "claim" | "event";
    statement: string;
    provenance: string;
    confidence: string | null;
    uncertainty: string | null;
    citations: Array<{ evidenceId: string; passageId: string | null; quote: string | null }>;
    eventDate?: string | null;
    eventDateText?: string | null;
    datePrecision?: string | null;
    dateConflict?: boolean;
  }): Promise<string> => {
    const id = newFindingId();
    await db.insert(schema.findings).values({
      id,
      caseId,
      ownerEmail,
      kind: row.kind,
      statement: row.statement,
      provenance: row.provenance,
      reviewStatus: "proposed",
      eventDate: row.eventDate ?? null,
      eventDateText: row.eventDateText ?? null,
      datePrecision: row.datePrecision ?? null,
      dateConflict: row.dateConflict ?? false,
      confidence: row.confidence,
      uncertainty: row.uncertainty,
      extractionMethod: row.provenance,
    });
    if (row.citations.length > 0) {
      await db.insert(schema.findingCitations).values(
        row.citations.map((citation) => ({
          id: newCitationId(),
          findingId: id,
          evidenceId: citation.evidenceId,
          passageId: citation.passageId,
          caseId,
          ownerEmail,
          quote: citation.quote,
        })),
      );
    }
    return id;
  };

  const claimIds: string[] = [];
  for (const claim of analysis.claims) {
    claimIds.push(
      await insertFinding({
        kind: "claim",
        statement: claim.statement,
        provenance: claim.provenance,
        confidence: claim.confidence,
        uncertainty: claim.uncertainty,
        citations: claim.citations,
      }),
    );
  }

  const eventIds: string[] = [];
  for (const event of analysis.events) {
    eventIds.push(
      await insertFinding({
        kind: "event",
        statement: event.description,
        provenance: event.provenance,
        confidence: event.confidence,
        uncertainty: event.uncertainty,
        citations: event.citations,
        eventDate: event.dateIso,
        eventDateText: event.dateText,
        datePrecision: event.datePrecision,
        dateConflict: event.dateConflict,
      }),
    );
  }

  return { claimIds, eventIds, removedProposals };
}
