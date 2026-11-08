import { defineAction } from "@agent-native/core/action";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";

import { requireOwnedCase } from "../server/casefile/access.js";
import { agentDefault, agentOptional } from "../server/casefile/action-input.js";
import { casefileContext } from "../server/casefile/context.js";
import { getDb } from "../server/db/index.js";
import * as schema from "../server/db/schema.js";

/**
 * Retrieval across a user's own record.
 *
 * Scope is enforced at the SQL level: every query is filtered by `owner_email`,
 * and a `caseId` narrows to a case the caller owns (checked before the search,
 * so an unowned id is a not-found rather than an empty result). Nothing here
 * reads across users.
 *
 * Matching is deterministic substring matching over stored text - document
 * filenames, passage text, finding statements, and note bodies - plus case
 * titles. It is not a semantic/vector search: it finds the literal term the
 * investigator typed, which keeps every hit explainable and traceable to a real
 * position. Each hit carries the id needed to open its source.
 */

const SEARCH_KINDS = ["cases", "documents", "passages", "findings", "notes"] as const;

export default defineAction({
  description:
    "Search a user's own cases and their contents for a term: case titles, document filenames, passage text, finding statements and investigator notes. Optionally narrow to one case. Returns each hit with the id needed to open its source. Scoped to the caller's cases at the SQL level; never returns another user's data.",
  schema: z.object({
    query: z.string().min(1).max(200).describe("The term to search for."),
    caseId: agentOptional(
      z.string().describe("Narrow the search to one case the caller owns."),
    ),
    kinds: agentOptional(
      z
        .array(z.enum(SEARCH_KINDS))
        .describe("Limit to some result kinds. Omit to search all."),
    ),
    limit: agentDefault(
      z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe("Maximum hits per kind."),
      40,
    ),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args, ctx) => {
    const { userEmail } = casefileContext(ctx);
    const db = getDb();
    const kinds = new Set(args.kinds ?? SEARCH_KINDS);
    const term = `%${args.query.trim()}%`;
    const perKind = args.limit;

    // A case scope is validated up front: an unowned or absent case is a
    // not-found, not a silently empty search.
    let caseScope: string | null = null;
    if (args.caseId) {
      const owned = await requireOwnedCase(args.caseId, userEmail);
      caseScope = owned.id;
    }

    const results: Record<string, unknown[]> = {};

    if (kinds.has("cases")) {
      const where = caseScope
        ? and(eq(schema.cases.ownerEmail, userEmail), eq(schema.cases.id, caseScope))
        : eq(schema.cases.ownerEmail, userEmail);
      const rows = await db
        .select({
          id: schema.cases.id,
          title: schema.cases.title,
          status: schema.cases.status,
          updatedAt: schema.cases.updatedAt,
        })
        .from(schema.cases)
        .where(and(where, ilike(schema.cases.title, term)))
        .orderBy(desc(schema.cases.updatedAt))
        .limit(perKind);
      results.cases = rows;
    }

    if (kinds.has("documents")) {
      const where = caseScope
        ? and(eq(schema.evidence.ownerEmail, userEmail), eq(schema.evidence.caseId, caseScope))
        : eq(schema.evidence.ownerEmail, userEmail);
      const rows = await db
        .select({
          id: schema.evidence.id,
          caseId: schema.evidence.caseId,
          filename: schema.evidence.filename,
          documentType: schema.evidence.documentType,
          extractionStatus: schema.evidence.extractionStatus,
        })
        .from(schema.evidence)
        .where(and(where, ilike(schema.evidence.filename, term)))
        .orderBy(asc(schema.evidence.createdAt))
        .limit(perKind);
      results.documents = rows;
    }

    if (kinds.has("passages")) {
      const where = caseScope
        ? and(
            eq(schema.evidencePassages.ownerEmail, userEmail),
            eq(schema.evidencePassages.caseId, caseScope),
          )
        : eq(schema.evidencePassages.ownerEmail, userEmail);
      const rows = await db
        .select({
          id: schema.evidencePassages.id,
          caseId: schema.evidencePassages.caseId,
          evidenceId: schema.evidencePassages.evidenceId,
          ref: schema.evidencePassages.ref,
          filename: schema.evidence.filename,
          excerpt: sql<string>`substring(${schema.evidencePassages.text}, 1, 280)`,
        })
        .from(schema.evidencePassages)
        .innerJoin(schema.evidence, eq(schema.evidence.id, schema.evidencePassages.evidenceId))
        .where(and(where, ilike(schema.evidencePassages.text, term)))
        .orderBy(asc(schema.evidencePassages.evidenceId), asc(schema.evidencePassages.ordinal))
        .limit(perKind);
      results.passages = rows;
    }

    if (kinds.has("findings")) {
      const where = caseScope
        ? and(eq(schema.findings.ownerEmail, userEmail), eq(schema.findings.caseId, caseScope))
        : eq(schema.findings.ownerEmail, userEmail);
      const rows = await db
        .select({
          id: schema.findings.id,
          caseId: schema.findings.caseId,
          kind: schema.findings.kind,
          statement: schema.findings.statement,
          provenance: schema.findings.provenance,
          reviewStatus: schema.findings.reviewStatus,
        })
        .from(schema.findings)
        .where(and(where, ilike(schema.findings.statement, term)))
        .orderBy(desc(schema.findings.createdAt))
        .limit(perKind);
      results.findings = rows;
    }

    if (kinds.has("notes")) {
      const where = caseScope
        ? and(
            eq(schema.investigationNotes.ownerEmail, userEmail),
            eq(schema.investigationNotes.caseId, caseScope),
          )
        : eq(schema.investigationNotes.ownerEmail, userEmail);
      const rows = await db
        .select({
          id: schema.investigationNotes.id,
          caseId: schema.investigationNotes.caseId,
          findingId: schema.investigationNotes.findingId,
          body: schema.investigationNotes.body,
          status: schema.investigationNotes.status,
        })
        .from(schema.investigationNotes)
        .where(and(where, ilike(schema.investigationNotes.body, term)))
        .orderBy(desc(schema.investigationNotes.updatedAt))
        .limit(perKind);
      results.notes = rows;
    }

    const total = Object.values(results).reduce(
      (sum, list) => sum + (list as unknown[]).length,
      0,
    );

    return {
      query: args.query.trim(),
      caseId: caseScope,
      results,
      total,
      note: "Literal substring match over stored text, scoped to the caller's own cases. Every hit carries the id needed to open its source.",
    };
  },
});
