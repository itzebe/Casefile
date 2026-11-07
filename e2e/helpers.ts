import { readFileSync } from "node:fs";
import path from "node:path";

/** HTTP helpers for driving the app's real action endpoints from a test. */
export function apiBase(): string {
  return process.env.E2E_BASE_URL ?? "http://127.0.0.1:12001"; // guard:allow-env-credential — local test server URL, not a credential
}

export interface ActionResult {
  status: number;
  json: unknown;
}

export async function callAction(
  name: string,
  body: unknown = {},
  method: "GET" | "POST" = "POST",
): Promise<ActionResult> {
  // Read-only actions are exposed as GET and reject a POST body with 405, so the
  // caller names the method explicitly rather than the helper guessing.
  const url =
    method === "GET"
      ? `${apiBase()}/_agent-native/actions/${name}?${new URLSearchParams(
          Object.entries(body as Record<string, string>).map(([k, v]) => [k, String(v)]),
        ).toString()}`
      : `${apiBase()}/_agent-native/actions/${name}`;
  const res = await fetch(url, {
    method,
    ...(method === "POST"
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

/** Loads the bundled synthetic demonstration case and returns its id. */
export async function seedDemoCase(scenario: "payment" | "court", title?: string): Promise<string> {
  const { status, json } = await callAction("load-demo-case", {
    scenario,
    // A caller that asserts on the case's *fresh* state passes a unique title,
    // so it gets its own case rather than sharing one other tests have written
    // to (the loader is idempotent by title).
    ...(title ? { title } : {}),
  });
  if (status >= 400) {
    throw new Error(`load-demo-case failed (${status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  const caseId = (json as { caseId?: string }).caseId;
  if (!caseId) throw new Error(`load-demo-case returned no caseId: ${JSON.stringify(json)}`);
  return caseId;
}

export function fixturePath(name: string): string {
  return path.join(process.cwd(), "e2e", "fixtures", name);
}

export function fixtureBytes(name: string): Buffer {
  return readFileSync(fixturePath(name));
}
