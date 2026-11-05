import { defineAction } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { casefileContext } from "../server/casefile/context.js";
import { buildCaseGraph } from "../server/casefile/graph.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Explains a single finding from the record.
 *
 * This is the action an agent calls to answer the explainability questions the
 * product promises: which documents support this, what exact passages support
 * it, which documents contradict it, what remains unknown, and what would help
 * resolve the uncertainty. Every answer is assembled from stored rows and the
 * deterministic graph - no model is consulted - so the explanation is the same
 * one a reviewer could derive by hand.
 *
 * When the record does not answer a question, the answer says so rather than
 * filling the gap with a plausible sentence.
 */
export default defineAction({
  description:
    "Explain a claim or event from the stored record: its supporting passages and documents, any assertions that agree with or contradict it, its evidence gaps, and what would resolve them. Assembled from stored rows, not from a model.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case the finding belongs to."),
    findingId: z.string().min(1).describe("The finding to explain."),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    const [finding] = await db
      .select()
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.id, args.findingId),
          eq(schema.findings.caseId, ownedCase.id),
          eq(schema.findings.ownerEmail, userEmail),
        ),
      )
      .limit(1);
    if (!finding) throw new Error("Finding not found.");

    const citationRows = await db
      .select({
        evidenceId: schema.findingCitations.evidenceId,
        passageId: schema.findingCitations.passageId,
        quote: schema.findingCitations.quote,
        ref: schema.evidencePassages.ref,
        text: schema.evidencePassages.text,
        filename: schema.evidence.filename,
      })
      .from(schema.findingCitations)
      .leftJoin(
        schema.evidencePassages,
        eq(schema.evidencePassages.id, schema.findingCitations.passageId),
      )
      .leftJoin(
        schema.evidence,
        eq(schema.evidence.id, schema.findingCitations.evidenceId),
      )
      .where(eq(schema.findingCitations.findingId, finding.id))
      .orderBy(asc(schema.findingCitations.createdAt));

    const supports = citationRows.map((row) => ({
      evidenceId: row.evidenceId,
      filename: row.filename ?? "an unnamed document",
      passageId: row.passageId,
      ref: row.ref ?? null,
      quote: row.quote,
      passageText: row.text ?? null,
    }));

    const graph = await buildCaseGraph(ownedCase.id, userEmail, { persist: false });

    const related = graph.comparisons.filter(
      (comparison) => comparison.aId === finding.id || comparison.bId === finding.id,
    );
    const agrees = related.filter(
      (comparison) =>
        comparison.verdict === "direct_agreement" || comparison.verdict === "partial_agreement",
    );
    const contradicts = related.filter(
      (comparison) =>
        comparison.verdict === "contradiction" ||
        comparison.verdict === "potential_contradiction",
    );
    const gaps = graph.gaps.filter((gap) => gap.affectsFindingId === finding.id);

    const supportingDocuments = [...new Set(supports.map((s) => s.evidenceId))];

    return {
      caseId: ownedCase.id,
      finding: {
        id: finding.id,
        kind: finding.kind,
        statement: finding.statement,
        provenance: finding.provenance,
        reviewStatus: finding.reviewStatus,
        eventDate: finding.eventDate,
        eventDateText: finding.eventDateText,
        dateConflict: finding.dateConflict,
        confidence: finding.confidence,
        uncertainty: finding.uncertainty,
      },
      supportedBy: supports,
      supportingDocumentCount: supportingDocuments.length,
      agreesWith: agrees.map((comparison) => ({
        otherId: comparison.aId === finding.id ? comparison.bId : comparison.aId,
        otherStatement: comparison.aId === finding.id ? comparison.bStatement : comparison.aStatement,
        verdict: comparison.verdict,
        reason: comparison.reason,
      })),
      contradictedBy: contradicts.map((comparison) => ({
        otherId: comparison.aId === finding.id ? comparison.bId : comparison.aId,
        otherStatement: comparison.aId === finding.id ? comparison.bStatement : comparison.aStatement,
        verdict: comparison.verdict,
        reason: comparison.reason,
      })),
      gaps,
      // A direct answer to "what remains unknown", stated plainly.
      whatRemainsUnknown: gaps.length > 0 ? gaps.map((gap) => gap.missing) : [],
      whatWouldResolve: [...new Set(gaps.map((gap) => gap.whatWouldHelp))],
      explanationComplete:
        supports.length > 0
          ? "This explanation is assembled from the passages cited above and the comparisons between them."
          : "This assertion has no cited source, so there is nothing in the record to explain it from.",
    };
  },
});
