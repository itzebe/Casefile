/**
 * Fail-closed guard against serving a deployment with authentication disabled.
 *
 * `AUTH_DISABLED` is a local-development convenience: it makes every request
 * resolve to a single shared identity. The framework reports it in production
 * but does not refuse to boot with it set, so a deploy that inherited the flag
 * would serve every caller as that one identity — the exact cross-user failure
 * this app's whole access layer exists to prevent.
 *
 * This guard makes the refusal real. It throws at server start when
 * authentication is disabled AND the process looks like a deployment, unless the
 * operator has explicitly opted in for a private, non-public demo.
 *
 * Detection is deliberately broad (any hosted marker, or `NODE_ENV=production`):
 * a false positive costs a developer one explicit opt-in flag, while a false
 * negative would put every tenant in one account. `CASEFILE_ALLOW_AUTH_DISABLED`
 * is the escape hatch, and it is the only way to run a production build without
 * auth.
 */

const AUTH_DISABLED = "AUTH_DISABLED";
const ALLOW_OVERRIDE = "CASEFILE_ALLOW_AUTH_DISABLED";

/** Truthy exactly the way the framework reads `AUTH_DISABLED`. */
export function isAuthDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[AUTH_DISABLED]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * True when the process looks like it is serving a deployment rather than a
 * developer's machine. Any hosted-platform marker counts, as does a production
 * server build (`NODE_ENV=production`, which `agent-native start` and every
 * platform set and `agent-native dev` does not).
 */
export function looksLikeDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  const markers = [
    "NETLIFY",
    "NETLIFY_FUNCTION_NAME",
    "VERCEL",
    "VERCEL_FUNCTION_ID",
    "VERCEL_REGION",
    "AWS_LAMBDA_FUNCTION_NAME",
    "LAMBDA_TASK_ROOT",
    "AWS_EXECUTION_ENV",
    "CF_PAGES",
    "FUNCTIONS_WORKER_RUNTIME",
    "K_SERVICE",
    "RENDER",
    "FLY_APP_NAME",
  ];
  if (markers.some((key) => Boolean(env[key]?.trim()))) return true;
  return env.NODE_ENV?.trim().toLowerCase() === "production";
}

export class AuthDisabledInDeploymentError extends Error {
  readonly code = "auth_disabled_in_deployment";
  constructor() {
    super(
      "Authentication is disabled (AUTH_DISABLED) but this process is serving a " +
        "deployment, where every request would resolve to one shared identity. " +
        "Unset AUTH_DISABLED. To run a production build without auth for a private " +
        `demo, set ${ALLOW_OVERRIDE}=true explicitly.`,
    );
    this.name = "AuthDisabledInDeploymentError";
  }
}

/** Throws when auth is disabled on a deployment without the explicit opt-in. */
export function assertAuthNotDisabledInDeployment(env: NodeJS.ProcessEnv = process.env): void {
  if (!isAuthDisabled(env)) return;
  if (env[ALLOW_OVERRIDE]?.trim().toLowerCase() === "true") return;
  if (!looksLikeDeployment(env)) return;
  throw new AuthDisabledInDeploymentError();
}
