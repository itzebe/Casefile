import { createGetDb } from "@agent-native/core/db";

import * as schema from "./schema.js";

/** Lazy, typed Drizzle client for the CASEFILE schema. */
export const getDb = createGetDb(schema);
