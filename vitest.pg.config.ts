import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * The PostgreSQL integration suite.
 *
 * The default `vitest.config.ts` runs every test against PGlite (an in-process
 * WASM build). That is fast and dependency-free, but it is not the database
 * production runs on, and it can differ in real ways: type handling, index
 * behaviour, constraint enforcement, and transaction semantics. This config runs
 * the same real action layer against a real PostgreSQL server.
 *
 * Point `CASEFILE_TEST_PG_URL` at a scratch database. When it is unset the suite
 * is skipped rather than failing, so `pnpm test:pg` is safe to run anywhere and
 * CI decides whether a server is present.
 */
const pgUrl = process.env.CASEFILE_TEST_PG_URL;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    include: ["tests/pg/**/*.pg.test.ts"],
    // These tests share one database and mutate its tables, so they run in a
    // single file serially rather than in parallel workers.
    fileParallelism: false,
    env: {
      DATABASE_URL: pgUrl ?? "postgres://unset/unset",
      CASEFILE_TEST_PG_URL: pgUrl ?? "",
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
