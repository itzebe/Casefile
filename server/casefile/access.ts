import { ActionContractError } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import { newAuditId } from "./ids.js";

/**
 * Authorization and audit for every CASEFILE operation.
 *
 * Two rules hold everywhere in this app:
 *
 * 1. The authenticated user comes from the framework's request context, never
 *    from action input. An action that accepted an `ownerEmail` argument would
 *    let any caller read any case by naming its owner.
 * 2. Every read and write is filtered by that resolved email at the SQL level,
 *    so authorization does not depend on a caller remembering to check.
 */

/**
 * A refusal the caller can act on: not signed in, or a case/evidence the caller
 * does not own. Extends the framework's `ActionContractError` so the transport
 * reports the right status (401/404) and a typed `errorCode`, instead of the
 * generic 500 a bare `Error` collapses to. The message stays deliberately
 * non-leaking — "Case not found" is identical for absent and unowned cases.
 */
export class CasefileAuthError extends ActionContractError {
  constructor(code: string, message: string) {
    super(message, {
      errorCode: code,
      statusCode: code === "unauthenticated" ? 401 : 404,
    });
    this.name = "CasefileAuthError";
  }
}

/**
 * The acting user's email. Throws when there is no authenticated user rather
 * than falling back to a shared identity: a silent fallback would make an
 * unauthenticated request succeed against the dev user's data.
 */
export function requireUserEmail(userEmail: string | undefined): string {
  const email = userEmail?.trim();
  if (!email) {
    throw new CasefileAuthError(
      "unauthenticated",
      "This operation requires a signed-in user.",
    );
  }
  return email;
}

/** Loads a case only if the caller owns it; otherwise reports not-found. */
export async function requireOwnedCase(
  caseId: string,
  userEmail: string,
): Promise<typeof schema.cases.$inferSelect> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.cases)
    .where(
      and(eq(schema.cases.id, caseId), eq(schema.cases.ownerEmail, userEmail)),
    )
    .limit(1);
  if (!row) {
    // Deliberately indistinguishable from a missing case, so the response
    // cannot be used to probe which case ids exist.
    throw new CasefileAuthError("case_not_found", "Case not found.");
  }
  return row;
}

/** Loads evidence only if the caller owns it and it belongs to the given case. */
export async function requireOwnedEvidence(
  evidenceId: string,
  userEmail: string,
  caseId?: string,
): Promise<typeof schema.evidence.$inferSelect> {
  const db = getDb();
  const conditions = [
    eq(schema.evidence.id, evidenceId),
    eq(schema.evidence.ownerEmail, userEmail),
  ];
  if (caseId) conditions.push(eq(schema.evidence.caseId, caseId));
  const [row] = await db
    .select()
    .from(schema.evidence)
    .where(and(...conditions))
    .limit(1);
  if (!row) {
    throw new CasefileAuthError("evidence_not_found", "Evidence not found.");
  }
  return row;
}

/**
 * A short, non-sensitive summary for the audit trail. Document text never
 * reaches the log: only counts, ids, and status words.
 */
function safeSummary(summary: string | undefined): string | null {
  if (!summary) return null;
  return summary.replace(/\s+/g, " ").slice(0, 240);
}

export interface AuditInput {
  ownerEmail: string;
  caseId?: string | null;
  actor: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary?: string;
  caller?: string | null;
  runId?: string | null;
}

/**
 * Records a write. Audit failures are logged but never fail the operation they
 * describe: losing a log line must not roll back a user's upload.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const db = getDb();
    await db.insert(schema.auditLog).values({
      id: newAuditId(),
      ownerEmail: input.ownerEmail,
      caseId: input.caseId ?? null,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      summary: safeSummary(input.summary),
      caller: input.caller ?? null,
      runId: input.runId ?? null,
    });
  } catch (error) {
    console.warn(
      "[casefile] audit write failed",
      input.action,
      error instanceof Error ? error.message : String(error),
    );
  }
}
