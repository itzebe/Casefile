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
  // A local-dev switch, never a credential. No secret is read or transmitted.
  const value = process.env.AUTH_DISABLED?.trim().toLowerCase(); // guard:allow-env-credential — local-dev auth switch, not a credential
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
    // Local-demo identity only: reachable solely when AUTH_DISABLED is set,
    // which the framework refuses on a public bind. A real deploy resolves the
    // signed-in session and never reaches this fallback.
    userEmail =
      process.env.CASEFILE_DEV_USER_EMAIL?.trim() || // guard:allow-env-credential — local-dev identity override, not a credential
      "local@localhost"; // guard:allow-localhost-fallback — only under AUTH_DISABLED, which a public bind refuses
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
