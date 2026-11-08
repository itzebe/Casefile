import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  RELATIONSHIP_BASIS,
  RELATIONSHIP_NODE_TYPES,
  RELATIONSHIP_TYPES,
  REVIEW_STATUSES,
} from "../shared/casefile/types.js";
import { recordAudit, requireOwnedCase } from "../server/casefile/access.js";
import { agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { touchCase } from "../server/casefile/case-queries.js";
import { newRelationshipId } from "../server/casefile/ids.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Proposes, reviews, or dismisses a cross-document relationship.
 *
 * Two uses, both first-class:
 *
 *  - An authorized agent proposes a relationship the deterministic engine did
 *    not find, by naming the two nodes and the identifier they share. The row is
 *    stamped `createdBy: agent` so a reviewer can tell it apart from an edge the
 *    engine derived.
 *  - A person confirms or rejects an existing relationship. A rejected edge is
 *    not deleted and is not recreated by the next graph build, so a reviewer's
 *    decision sticks.
 */
export default defineAction({
  description:
    "Record a human or agent decision about a cross-document relationship, or propose a new one. Pass an existing relationshipId to confirm or reject it, or name two nodes (fromType/fromId/toType/toId), a relationType, and the matchKey they share to propose a new relationship. The engine never overrides a reviewed relationship.",
  schema: z
    .object({
      caseId: z.string().min(1).describe("The case the relationship belongs to."),
      relationshipId: agentOptional(
        z.string().describe("An existing relationship to confirm or reject."),
      ),
      fromType: agentOptional(z.enum(RELATIONSHIP_NODE_TYPES)),
      fromId: agentOptional(z.string()),
      toType: agentOptional(z.enum(RELATIONSHIP_NODE_TYPES)),
      toId: agentOptional(z.string()),
      relationType: agentOptional(z.enum(RELATIONSHIP_TYPES)),
      basis: agentOptional(z.enum(RELATIONSHIP_BASIS)),
      matchKey: agentOptional(
        z
          .string()
          .max(200)
          .describe("The identifier, amount, date, or name the two nodes share."),
      ),
      rationale: agentOptional(z.string().max(500)),
      reviewStatus: agentOptional(
        z
          .enum(REVIEW_STATUSES)
          .describe("confirmed accepts the relationship; rejected dismisses it."),
      ),
    })
    .refine(
      (value) => Boolean(value.relationshipId) || Boolean(value.fromId && value.toId && value.relationType),
      {
        message:
          "Provide either a relationshipId to review, or fromId, toId, and relationType to propose a new relationship.",
      },
    ),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const { userEmail, actor, caller, runId } = casefileContext(ctx);
    const ownedCase = await requireOwnedCase(args.caseId, userEmail);
    const db = getDb();

    if (args.relationshipId) {
      const [existing] = await db
        .select()
        .from(schema.relationships)
        .where(
          and(
            eq(schema.relationships.id, args.relationshipId),
            eq(schema.relationships.caseId, ownedCase.id),
            eq(schema.relationships.ownerEmail, userEmail),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("Relationship not found.");

      const changes: Record<string, unknown> = {};
      if (args.reviewStatus !== undefined) changes.reviewStatus = args.reviewStatus;
      if (args.rationale !== undefined) changes.rationale = args.rationale;
      if (Object.keys(changes).length > 0) {
        changes.correctedBy = userEmail;
        changes.correctedAt = new Date().toISOString();
        await db
          .update(schema.relationships)
          .set(changes)
          .where(
            and(
              eq(schema.relationships.id, existing.id),
              eq(schema.relationships.ownerEmail, userEmail),
            ),
          );
        await touchCase(ownedCase.id, userEmail);
      }

      await recordAudit({
        ownerEmail: userEmail,
        caseId: ownedCase.id,
        actor,
        action: "relationship.review",
        targetType: "relationship",
        targetId: existing.id,
        summary: `Reviewed ${existing.relationType}${args.reviewStatus ? ` -> ${args.reviewStatus}` : ""}`,
        caller,
        runId,
      });

      return {
        id: existing.id,
        reviewStatus: (changes.reviewStatus as string | undefined) ?? existing.reviewStatus,
        created: false,
      };
    }

    // Propose a new relationship, attributed to the caller.
    const id = newRelationshipId();
    await db.insert(schema.relationships).values({
      id,
      caseId: ownedCase.id,
      ownerEmail: userEmail,
      fromType: args.fromType ?? "finding",
      fromId: args.fromId!,
      toType: args.toType ?? "finding",
      toId: args.toId!,
      relationType: args.relationType!,
      basis: args.basis ?? "inferred",
      matchKey: args.matchKey ?? null,
      sourcePassageId: null,
      rationale: args.rationale ?? "",
      confidence: args.basis === "direct" ? "high" : "medium",
      reviewStatus: "proposed",
      createdBy: "agent",
    });
    await touchCase(ownedCase.id, userEmail);

    await recordAudit({
      ownerEmail: userEmail,
      caseId: ownedCase.id,
      actor,
      action: "relationship.propose",
      targetType: "relationship",
      targetId: id,
      summary: `Proposed ${args.relationType}`,
      caller,
      runId,
    });

    return { id, reviewStatus: "proposed", created: true };
  },
});
