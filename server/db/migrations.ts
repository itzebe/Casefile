import { runMigrations } from "@agent-native/core/db";

import { MIGRATIONS } from "./migration-entries.js";

/**
 * App-owned migrations, applied on local startup.
 *
 * Additive only: create in v1, `ADD COLUMN IF NOT EXISTS` afterwards, never
 * drop or rename. Each entry carries a stable `name` so two branches that both
 * add a migration cannot silently consume each other's version slot.
 */
export default runMigrations(MIGRATIONS, { table: "casefile_migrations" });
