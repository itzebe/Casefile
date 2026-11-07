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
