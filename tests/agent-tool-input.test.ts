import { executeAgentToolCall, loadActionsFromStaticRegistry } from "@agent-native/core/server";
import { validateActionArgs } from "@agent-native/core/action";
import type { ActionEntry } from "@agent-native/core/action";
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import actionsRegistry from "../.generated/actions-registry.js";
import { setupTestDatabase } from "./helpers/harness.js";

/**
 * The agent reaches the app's actions as native tools. Before a call runs, the
 * framework repairs the model's tool input: an optional field the model sent as
 * an empty placeholder — `null` or `""` — is stripped, but only when the
 * field's JSON schema accepts that placeholder. When one optional field accepts
 * its placeholder and another rejects it, the repair cannot tell a deliberate
 * clear from transport noise and refuses the whole call with
 * `ambiguous_tool_placeholders`; the action never runs and the user sees an
 * error for a call that was correct.
 *
 * A provider that fills every declared property with `null` exposes any action
 * that mixes a nullable field with a bare `z.enum().optional()` or
 * `z.string().min(1)`. `list-cases` was the first to fail this way in
 * production (`{ includeArchived: false, status: null }`). The `agentOptional`,
 * `agentDefault`, and `agentClearable` helpers in
 * `server/casefile/action-input.ts` make each optional field accept its
 * placeholder, so no valid call is lost.
 *
 * These tests drive the real framework entry point — `executeAgentToolCall`,
 * the function the chat loop calls — because the guard lives in the agent loop,
 * not in an action's `run`. A test that called `run` directly would pass on the
 * broken schema and prove nothing. The action list is read from `actions/*.ts`
 * so a new action is covered the moment it lands.
 */

const AGENT_INPUT = { ownerEmail: "owner@example.com", appId: "casefile", caller: "agent" as const };

/**
 * A Slack action the `chat` template ships (`appId: "chat"`), outside CASEFILE's
 * evidence domain and not part of any CASEFILE workflow. It shares the defect
 * but is intentionally left for its owner rather than edited here.
 */
const OUT_OF_SCOPE = new Set(["provider-api-request"]);

function actionNames(): string[] {
  const registered = actions();
  return fs
    .readdirSync(new URL("../actions", import.meta.url))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.replace(/\.ts$/, ""))
    .filter((name) => name in registered && !OUT_OF_SCOPE.has(name))
    .sort();
}

function actions(): Record<string, ActionEntry> {
  return loadActionsFromStaticRegistry(actionsRegistry);
}

/** Input a provider that fills every declared property with `null` would send. */
function nullFilledOptionalInput(entry: ActionEntry): Record<string, unknown> {
  const parameters = entry.tool.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(parameters.required ?? []);
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(parameters.properties ?? {})) {
    if (!required.has(key)) input[key] = null;
  }
  return input;
}

async function callAgentTool(
  name: string,
  input: unknown,
): Promise<{ status: string; output: string }> {
  const result = await executeAgentToolCall({
    actions: actions(),
    name,
    input,
    callId: `test-${name}`,
    ...AGENT_INPUT,
  });
  return { status: result.status, output: result.output };
}

const AMBIGUOUS_MARKER = "mixes invalid placeholders";

describe("agent tool input", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  it("runs list-cases when the model sends an empty status placeholder", async () => {
    // The exact shape observed failing in production.
    const result = await callAgentTool("list-cases", {
      includeArchived: false,
      status: null,
    });

    expect(result.output).not.toContain(AMBIGUOUS_MARKER);
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.output)).toMatchObject({ cases: [], total: 0 });
  });

  it.each(actionNames())(
    "%s accepts a null placeholder on every optional field",
    async (name) => {
      const entry = actions()[name];
      expect(entry, `action ${name} is registered`).toBeDefined();

      const result = await callAgentTool(name, nullFilledOptionalInput(entry));

      expect(result.output, `${name} was rejected as ambiguous`).not.toContain(
        AMBIGUOUS_MARKER,
      );
    },
  );

  // A read-only action is called over HTTP as a GET with query-string
  // arguments, and the framework coerces a string back to the declared type
  // (`?limit=200` -> 200). Wrapping a field in a union erases the top-level
  // `type` the coercion reads, so the helpers must restore it; this pins that.
  it.each([
    ["list-activity", { caseId: "case-1", limit: "200" }, { limit: 200 }],
    ["list-cases", { includeArchived: "false" }, { includeArchived: false }],
    ["get-case", { caseId: "case-1", includeEvidence: "false" }, { includeEvidence: false }],
  ])(
    "%s coerces HTTP query-string arguments to their declared types",
    async (name, query, expected) => {
      const entry = actions()[name]!;
      const parsed = await validateActionArgs(
        entry.schema as never,
        query,
        entry.tool.parameters,
        undefined,
      );
      expect(parsed).toMatchObject(expected);
    },
  );
});
