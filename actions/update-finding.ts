import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  CONFIDENCE_LEVELS,
  DATE_PRECISION,
  PROVENANCE,
  REVIEW_STATUSES,
} from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { agentClearable, agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Corrects or reviews a finding.
 *
 * This is the human-in-the-loop step: it is how a proposal becomes `confirmed`,
 * how a wrong date is fixed, and how a rejected claim is recorded as rejected
 * rather than deleted. Every edit stamps `correctedBy`/`correctedAt`, so the
 * record shows that the value is a human's and the agent reads the corrected
 * version on its next turn.
 *
 * The agent may call this too, but the actor recorded is always the resolved
 * caller, so an agent edit is distinguishable from a person's.
 */
export default defineAction({
  description:
    "Correct or review a claim or event: fix its wording, set its date, change provenance, or mark it confirmed or rejected. Use this to act on a review decision. Corrections are attributed and preserved.",
  schema: z
    .object({
      caseId: z.string().min(1).describe("The case the finding belongs to."),
      findingId: z.string().min(1).describe("The finding to update."),
      statement: agentOptional(
        z
          .string()
          .min(1)
          .max(2000)
          .describe("Corrected wording of the claim or event."),
      ),
      reviewStatus: agentOptional(
        z
          .enum(REVIEW_STATUSES)
          .describe("confirmed accepts the finding; rejected records that it was not accepted."),
      ),
      provenance: agentOptional(
        z.enum(PROVENANCE).describe("Corrected provenance."),
      ),
      eventDate: agentClearable(
        z
          .string()
          .regex(/^\d{4}-\d{2}(-\d{2})?$/)
          .nullable()
          .describe("Corrected date as YYYY-MM-DD or YYYY-MM. Send null to clear a wrong date."),
      ),
      eventDateText: agentClearable(
        z
          .string()
          .max(120)
          .nullable()
          .describe("The date exactly as the source wrote it."),
      ),
      datePrecision: agentOptional(z.enum(DATE_PRECISION)),
      dateConflict: agentOptional(z.boolean()),
      confidence: agentClearable(z.enum(CONFIDENCE_LEVELS).nullable()),
      uncertainty: agentClearable(z.string().max(1000).nullable()),
    })
    .refine(
      (value) =>
        Object.keys(value).some((key) => key !== "caseId" && key !== "findingId"),
      { message: "Provide at least one field to update." },
    ),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
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

    const changes: Record<string, unknown> = {};
    if (args.statement !== undefined) changes.statement = args.statement.trim();
    if (args.reviewStatus !== undefined) changes.reviewStatus = args.reviewStatus;
    if (args.provenance !== undefined) changes.provenance = args.provenance;
    if (args.eventDate !== undefined) changes.eventDate = args.eventDate;
    if (args.eventDateText !== undefined) changes.eventDateText = args.eventDateText;
    if (args.datePrecision !== undefined) changes.datePrecision = args.datePrecision;
    if (args.dateConflict !== undefined) changes.dateConflict = args.dateConflict;
    if (args.confidence !== undefined) changes.confidence = args.confidence;
    if (args.uncertainty !== undefined) changes.uncertainty = args.uncertainty;

    if (Object.keys(changes).length > 0) {
      changes.correctedBy = userEmail;
      changes.correctedAt = new Date().toISOString();
      await db
        .update(schema.findings)
        .set(changes)
        .where(
          and(eq(schema.findings.id, finding.id), eq(schema.findings.ownerEmail, userEmail)),
        );
      await touchCase(ownedCase.id, userEmail);
    }

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "finding.update",
      targetType: finding.kind,
      targetId: finding.id,
      // Field names and status words only, never the finding text.
      summary: `Updated ${Object.keys(changes)
        .filter((key) => key !== "correctedBy" && key !== "correctedAt")
        .join(", ")}${args.reviewStatus ? ` -> ${args.reviewStatus}` : ""}`,
      caller,
      runId,
    });

    return {
      id: finding.id,
      kind: finding.kind,
      changed: Object.keys(changes).filter(
        (key) => key !== "correctedBy" && key !== "correctedAt",
      ),
      reviewStatus: (changes.reviewStatus as string | undefined) ?? finding.reviewStatus,
    };
  },
});
