import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";
import { isNullishText } from "../server/casefile/analysis.js";

/**
 * Builds the chronological timeline.
 *
 * Ordering is deliberately partial rather than a total order:
 *
 *  - Events with a known day sort by date.
 *  - Events with only a month or year sort within their coarser bucket and are
 *    flagged, because placing them on a specific day would invent precision the
 *    evidence does not have.
 *  - Events with conflicting sources keep their conflict flag.
 *  - Events with no date at all are returned in a separate `undated` list.
 *
 * Nothing is dropped and no timestamp is invented, so the timeline is honest
 * about what the evidence does and does not establish.
 */
function readUncertainty(value: string | null): string | null {
  if (!value || isNullishText(value)) return null;
  return value;
}

export default defineAction({
  description:
    "Build the chronological timeline for a case. Returns dated events in order, events with only coarse or conflicting dates flagged, and undated events in a separate list. Never invents a timestamp.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to build a timeline for."),
    includeRejected: z
      .boolean()
      .default(false)
      .describe("Include events a reviewer rejected."),
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
      .where(and(eq(schema.findings.caseId, ownedCase.id), eq(schema.findings.kind, "event")));

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
      .filter((row) => args.includeRejected || row.reviewStatus !== "rejected")
      .map((row) => ({
        id: row.id,
        statement: row.statement,
        eventDate: row.eventDate,
        eventDateText: row.eventDateText,
        datePrecision: row.datePrecision,
        dateConflict: row.dateConflict,
        provenance: row.provenance,
        reviewStatus: row.reviewStatus,
        confidence: row.confidence,
        uncertainty: readUncertainty(row.uncertainty),
        correctedBy: row.correctedBy,
        citations: (byFinding.get(row.id) ?? []).map((citation) => ({
          evidenceId: citation.evidenceId,
          passageId: citation.passageId,
          quote: citation.quote,
        })),
      }));

    // Full-precision dates first, then month, then year. A coarser date cannot
    // be compared to a finer one without inventing a day, so they stay in
    // separate bands rather than being interleaved.
    const rank = (event: (typeof events)[number]): number => {
      if (!event.eventDate) return 4;
      if (event.datePrecision === "day") return 0;
      if (event.datePrecision === "month") return 1;
      if (event.datePrecision === "year") return 2;
      if (event.dateConflict) return 3;
      return 3;
    };

    const sortable = events
      .filter((event) => event.eventDate)
      .sort((a, b) => {
        const rankDiff = rank(a) - rank(b);
        if (rankDiff !== 0) return rankDiff;
        return String(a.eventDate).localeCompare(String(b.eventDate));
      });

    const undated = events.filter((event) => !event.eventDate);

    return {
      caseId: ownedCase.id,
      timeline: sortable.map((event) => ({
        ...event,
        // Say why an event is not on an exact day, in the payload itself.
        orderingNote: event.dateConflict
          ? "Sources give conflicting dates; position is approximate."
          : event.datePrecision !== "day"
            ? `Only ${event.datePrecision}-level precision is available.`
            : null,
      })),
      undated: undated.map((event) => ({
        ...event,
        orderingNote: "No determinable date in the evidence.",
      })),
      counts: {
        total: events.length,
        dated: sortable.length,
        undated: undated.length,
        conflicting: events.filter((event) => event.dateConflict).length,
      },
    };
  },
});
