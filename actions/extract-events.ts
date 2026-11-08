import { defineAction } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { agentDefault } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Reads the events recorded for a case.
 *
 * Events keep both the resolved date and the date as the document wrote it, so
 * a partial or conflicting date is visible instead of silently normalised. An
 * event with no date is returned with `eventDate: null` and precision
 * "unknown" rather than being dropped or given an invented timestamp.
 */
export default defineAction({
  description:
    "List the events recorded for a case, with their date as written, resolved date, precision, conflict flag, and source passages. Events with no determinable date are included and marked unknown.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose events to read."),
    conflictsOnly: agentDefault(
      z.boolean().describe("Return only events whose sources give conflicting dates."),
      false,
    ),
    undatedOnly: agentDefault(
      z.boolean().describe("Return only events with no determinable date."),
      false,
    ),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const rows = await db
      .select()
      .from(schema.findings)
      .where(and(eq(schema.findings.caseId, ownedCase.id), eq(schema.findings.kind, "event")))
      .orderBy(desc(schema.findings.createdAt));

    const citations = await db
      .select()
      .from(schema.findingCitations)
      .where(eq(schema.findingCitations.caseId, ownedCase.id));
    const byFinding = new Map<string, typeof citations>();
    for (const citation of citations) {
      const list = byFinding.get(citation.findingId) ?? [];
      list.push(citation);
      byFinding.set(citation.findingId, list);
    }

    const events = rows
      .filter((row) => !args.conflictsOnly || row.dateConflict)
      .filter((row) => !args.undatedOnly || !row.eventDate)
      .map((row) => ({
        id: row.id,
        description: row.statement,
        eventDate: row.eventDate,
        eventDateText: row.eventDateText,
        datePrecision: row.datePrecision,
        dateConflict: row.dateConflict,
        provenance: row.provenance,
        reviewStatus: row.reviewStatus,
        confidence: row.confidence,
        uncertainty: row.uncertainty,
        correctedBy: row.correctedBy,
        citations: (byFinding.get(row.id) ?? []).map((citation) => ({
          evidenceId: citation.evidenceId,
          passageId: citation.passageId,
          quote: citation.quote,
        })),
      }));

    return {
      caseId: ownedCase.id,
      events,
      conflictCount: events.filter((event) => event.dateConflict).length,
      undatedCount: events.filter((event) => !event.eventDate).length,
    };
  },
});
