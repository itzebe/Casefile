import type { ActionRunContext } from "@agent-native/core/action";

import { requireUserEmail } from "./access.js";
import { isAuthDisabled } from "./auth-guard.js";

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

/**
 * Resolves the caller, or throws. `AUTH_DISABLED` deliberately still resolves a
 * single shared identity for local demos, matching the framework's behaviour,
 * but the value is reported in the actor field so an audit trail shows it.
 *
 * The shared identity is only reachable in local development: the auth plugin's
 * boot guard (`assertAuthNotDisabledInDeployment`) refuses to start a deployment
 * with `AUTH_DISABLED` set, so a real deploy resolves the signed-in session and
 * never reaches this fallback.
 */
export function casefileContext(ctx: ActionRunContext | undefined): CasefileContext {
  let userEmail: string | undefined = ctx?.userEmail;
  if (!userEmail && isAuthDisabled()) {
    // Local-demo identity only.
    userEmail =
      process.env.CASEFILE_DEV_USER_EMAIL?.trim() || // guard:allow-env-credential — local-dev identity override, not a credential
      "local@localhost"; // guard:allow-localhost-fallback — only under AUTH_DISABLED, which the boot guard refuses on a deployment
  }
  const resolved = requireUserEmail(userEmail);
  return {
    userEmail: resolved,
    actor: resolved,
    caller: ctx?.caller ?? "unknown",
    runId: ctx?.runId ?? null,
  };
}
