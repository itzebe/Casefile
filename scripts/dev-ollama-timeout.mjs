// Raise the timeouts on Node's global fetch dispatcher.
//
// Why: this app runs against a local Ollama. The agent's system prompt is
// ~15k tokens, and on a small CPU-only box prefill runs at ~50-90 tok/s, so
// time-to-first-token can reach ~200-300s. Node's built-in fetch defaults to
// headersTimeout = 300_000 ms and aborts the model call with UND_ERR_SOCKET
// just before the first token arrives; the run then retries until it stalls.
//
// Node's global fetch and the npm `undici` package share the same global
// dispatcher symbol, so installing a dispatcher through undici applies to
// fetch(). Load it with NODE_OPTIONS="--import ./scripts/dev-ollama-timeout.mjs".
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const HEADERS_TIMEOUT_MS = 20 * 60_000;
const BODY_TIMEOUT_MS = 20 * 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 60 * 60_000;

function loadUndici() {
  // pnpm does not expose `undici` as a resolvable bare specifier from the app
  // root (it is a transitive dep), so also try pnpm's hoist directory.
  const resolvers = [
    createRequire(path.join(process.cwd(), "node_modules", ".pnpm", "node_modules", "index.js")),
    createRequire(pathToFileURL(path.join(process.cwd(), "package.json"))),
  ];
  for (const req of resolvers) {
    try {
      return req("undici");
    } catch {
      /* try the next resolver */
    }
  }
  return null;
}

const undici = loadUndici();

if (undici) {
  undici.setGlobalDispatcher(
    new undici.Agent({
      headersTimeout: HEADERS_TIMEOUT_MS,
      bodyTimeout: BODY_TIMEOUT_MS,
      keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
      connect: { timeout: 30_000 },
    }),
  );
} else {
  console.warn("[dev-ollama-timeout] undici not resolvable; fetch timeouts left at defaults");
}
