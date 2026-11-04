import type { ActionRunContext } from "@agent-native/core/action";
import { runMigrations } from "@agent-native/core/db";
import { sql } from "drizzle-orm";

import { MIGRATIONS } from "../../server/db/migration-entries.js";
import { getDb } from "../../server/db/index.js";
import * as schema from "../../server/db/schema.js";

/**
 * Test harness.
 *
 * Tests call the real action `run` functions with a real context and a real
 * database, so authorization, validation, and persistence are exercised as
 * shipped. Nothing here mocks the database or the action layer.
 */

let migrated = false;

/**
 * Applies the app's migrations once per test file.
 *
 * `runMigrations` returns the Nitro plugin (an async function) rather than
 * running it, so the returned function is invoked here directly.
 */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const plugin = runMigrations(MIGRATIONS, { table: "casefile_migrations" }) as unknown as () => Promise<void>;
  await plugin();
  migrated = true;
}

/** Empties the domain tables so each test starts from a known state. */
export async function resetCasefileTables(): Promise<void> {
  const db = getDb();
  for (const statement of [
    "DELETE FROM casefile_finding_citations",
    "DELETE FROM casefile_findings",
    "DELETE FROM casefile_evidence_passages",
    "DELETE FROM casefile_evidence_blobs",
    "DELETE FROM casefile_evidence",
    "DELETE FROM casefile_audit_log",
    "DELETE FROM casefile_cases",
  ]) {
    await db.execute(sql.raw(statement));
  }
}

export async function setupTestDatabase(): Promise<void> {
  await ensureSchema();
  await resetCasefileTables();
}

/** A run context for a given user, as the framework would resolve it. */
export function userContext(
  userEmail: string,
  caller: ActionRunContext["caller"] = "frontend",
): ActionRunContext {
  return { userEmail, orgId: null, caller } as ActionRunContext;
}

/** A context with no resolved user, for unauthenticated-access tests. */
export function anonymousContext(): ActionRunContext {
  return { orgId: null, caller: "http" } as ActionRunContext;
}

/**
 * Calls an action module's `run`. The path is resolved against the project
 * root so callers can name an action without counting directory levels.
 */
export async function callAction<T = unknown>(
  modulePath: string,
  args: unknown,
  ctx?: ActionRunContext,
): Promise<T> {
  const resolved = modulePath.startsWith("/") ? modulePath : `/actions/${modulePath}`;
  const mod = (await import(/* @vite-ignore */ resolved)) as {
    default: { run: (a: unknown, c?: ActionRunContext) => Promise<T> };
  };
  return mod.default.run(args, ctx);
}

export { getDb, schema };
