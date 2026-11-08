import { defineAction } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Reads the claims recorded for a case, each with the passages it rests on.
 *
 * This reads what analysis already stored rather than calling the model again,
 * so the same input always yields the same claims and a reviewer is never
 * shown a different set each time they look. Run analyzeEvidence to produce
 * proposals.
 */
export default defineAction({
  description:
    "List the claims recorded for a case, with provenance (documented, asserted, inferred, unverified), review status, and the source passages for each. Reads stored results; run analyzeEvidence to produce them.",
  schema: z.object({
    caseId: z.string().min(1).describe("The case whose claims to read."),
    provenance: agentOptional(
      z
        .enum(["documented", "asserted", "inferred", "unverified"])
        .describe("Filter to one provenance kind."),
    ),
    reviewStatus: agentOptional(
      z
        .enum(["proposed", "confirmed", "rejected"])
        .describe("Filter to one review status."),
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
      .where(and(eq(schema.findings.caseId, ownedCase.id), eq(schema.findings.kind, "claim")))
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

    const claims = rows
      .filter((row) => !args.provenance || row.provenance === args.provenance)
      .filter((row) => !args.reviewStatus || row.reviewStatus === args.reviewStatus)
      .map((row) => ({
        id: row.id,
        statement: row.statement,
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

    const unsupported = claims.filter((claim) => claim.citations.length === 0).length;
    return { caseId: ownedCase.id, claims, unsupportedCount: unsupported };
  },
});
