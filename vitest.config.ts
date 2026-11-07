import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    env: { DATABASE_URL: "pglite:memory" },
    // The first test in a fresh worker to touch the database pays for installing
    // the schema snapshot (240 migrations). On a cold CI runner that alone has
    // exceeded vitest's 5000ms default and failed a passing test, so give the
    // suite headroom. Still bounded well below a genuinely hung test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/.react-router/**",
      // The PostgreSQL integration suite needs a real server; it runs under
      // `vitest.pg.config.ts` via `pnpm test:pg`.
      "tests/pg/**",
    ],
  },
});
