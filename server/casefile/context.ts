import type { ActionRunContext } from "@agent-native/core/action";

import { CasefileAuthError, requireUserEmail } from "./access.js";

/**
 * Shared request-identity helpers for CASEFILE actions.
 *
 * The acting user always comes from the framework's resolved request context.
 * No action accepts an owner or actor in its input, so a caller cannot name
 * someone else's identity.
 */

export interface CasefileContext {
  userEmail: string;
  actor: string;
  caller: string;
  runId: string | null;
}

/** Mirrors the framework's own parsing of `AUTH_DISABLED` so the two agree. */
function authDisabled(): boolean {
  const value = process.env.AUTH_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Resolves the caller, or throws. `AUTH_DISABLED` deliberately still resolves a
 * single shared identity for local demos, matching the framework's behaviour,
 * but the value is reported in the actor field so an audit trail shows it.
 */
export function casefileContext(ctx: ActionRunContext | undefined): CasefileContext {
  let userEmail: string | undefined = ctx?.userEmail;
  if (!userEmail && authDisabled()) {
    userEmail = process.env.CASEFILE_DEV_USER_EMAIL?.trim() || "local@localhost";
  }
  const resolved = requireUserEmail(userEmail);
  return {
    userEmail: resolved,
    actor: resolved,
    caller: ctx?.caller ?? "unknown",
    runId: ctx?.runId ?? null,
  };
}

/** Maps an authorization failure onto a stable, non-leaking error code. */
export function toActionError(error: unknown): never {
  if (error instanceof CasefileAuthError) {
    const err = new Error(error.message);
    err.name = error.code;
    throw err;
  }
  throw error;
}
