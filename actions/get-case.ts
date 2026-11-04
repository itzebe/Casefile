import { defineAction } from "@agent-native/core/action";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { isNullishText } from "../server/casefile/analysis.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Rows written before the nullish-text guard may still hold the literal string
 * "null". Normalising on read keeps those old rows out of the UI.
 */
function readUncertainty(value: string | null): string | null {
  if (!value || isNullishText(value)) return null;
  return value;
}

export default defineAction({
  description:
    "Read one case with its evidence, findings, and citations. Use this to ground any statement about a case in the record: the result distinguishes documented facts from party assertions and agent inferences.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case to read."),
    includeEvidence: z
      .boolean()
      .default(true)
      .describe("Include the evidence list and its extraction status."),
    includeFindings: z
      .boolean()
      .default(true)
      .describe("Include claims and events with their citations."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const row = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const evidenceRows = args.includeEvidence
      ? await db
          .select({
            id: schema.evidence.id,
            filename: schema.evidence.filename,
            mimeType: schema.evidence.mimeType,
            byteSize: schema.evidence.byteSize,
            category: schema.evidence.category,
            extractionStatus: schema.evidence.extractionStatus,
            extractionError: schema.evidence.extractionError,
            pageCount: schema.evidence.pageCount,
            createdAt: schema.evidence.createdAt,
          })
          .from(schema.evidence)
          .where(eq(schema.evidence.caseId, row.id))
          .orderBy(asc(schema.evidence.createdAt))
      : [];

    const findingRows = args.includeFindings
      ? await db
          .select()
          .from(schema.findings)
          .where(eq(schema.findings.caseId, row.id))
          .orderBy(desc(schema.findings.createdAt))
      : [];

    const citations = findingRows.length
      ? await db
          .select()
          .from(schema.findingCitations)
          .where(eq(schema.findingCitations.caseId, row.id))
      : [];

    const citationsByFinding = new Map<string, typeof citations>();
    for (const citation of citations) {
      const list = citationsByFinding.get(citation.findingId) ?? [];
      list.push(citation);
      citationsByFinding.set(citation.findingId, list);
    }

    return {
      case: {
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category,
        status: row.status,
        amountMinor: row.amountMinor,
        currency: row.currency,
        revision: row.revision,
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
      },
      evidence: evidenceRows.map((item) => ({
        ...item,
        createdAt: String(item.createdAt),
      })),
      claims: findingRows
        .filter((finding) => finding.kind === "claim")
        .map((finding) => ({
          id: finding.id,
          statement: finding.statement,
          provenance: finding.provenance,
          reviewStatus: finding.reviewStatus,
          confidence: finding.confidence,
          uncertainty: readUncertainty(finding.uncertainty),
          correctedBy: finding.correctedBy,
          citations: (citationsByFinding.get(finding.id) ?? []).map((citation) => ({
            evidenceId: citation.evidenceId,
            passageId: citation.passageId,
            quote: citation.quote,
          })),
        })),
      events: findingRows
        .filter((finding) => finding.kind === "event")
        .map((finding) => ({
          id: finding.id,
          statement: finding.statement,
          provenance: finding.provenance,
          reviewStatus: finding.reviewStatus,
          eventDate: finding.eventDate,
          eventDateText: finding.eventDateText,
          datePrecision: finding.datePrecision,
          dateConflict: finding.dateConflict,
          confidence: finding.confidence,
          uncertainty: readUncertainty(finding.uncertainty),
          correctedBy: finding.correctedBy,
          citations: (citationsByFinding.get(finding.id) ?? []).map((citation) => ({
            evidenceId: citation.evidenceId,
            passageId: citation.passageId,
            quote: citation.quote,
          })),
        })),
    };
  },
});
