import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  registerBuiltinEngines,
  resolveEngine,
} from "@agent-native/core/agent/engine";
import { runWithRequestContext } from "@agent-native/core/server";

/**
 * Judge-wide AI access through a deployment-level provider key.
 *
 * Every signup gets its own organization, and provider credentials are scoped
 * to a user, an organization, or a workspace. Without a credential in their own
 * scope, a judge's organization cannot reach any model. The framework's
 * supported shared fallback is a deployment-level provider key in the server
 * environment: any signed-in user with no scoped key uses it, and usage is
 * billed to the deployment account.
 *
 * These tests drive the real `resolveEngine` against two independent
 * organizations. They fail if the shared provider stops reaching a second
 * organization, and if a production hosted-workspace runtime starts honoring
 * the deployment key (which would break organization isolation).
 */

const ORG_A = "org_a_shared_provider";
const ORG_B = "org_b_shared_provider";
const EMAIL_A = "judge-a@example.com";
const EMAIL_B = "judge-b@example.com";

/** A fake key. Only its presence is observed; it is never sent anywhere. */
const SHARED_KEY = "gsk_casefile_test_shared_provider_key";

/**
 * Sets or clears the fake deployment provider key.
 *
 * `process.env` is the deployment's shared provider surface: the whole point of
 * this test is that a key set here reaches every organization. The value is a
 * test literal, never a real credential.
 */
function useSharedKey(enabled: boolean): void {
  if (enabled) process.env.GROQ_API_KEY = SHARED_KEY; // guard:allow-env-credential — fake deployment key, presence-only probe
  else delete process.env.GROQ_API_KEY; // guard:allow-env-credential — clears the fake deployment key this suite sets
}

const ORIGINAL_ENGINE = process.env.AGENT_ENGINE;
const ORIGINAL_WORKSPACE = process.env.AGENT_NATIVE_WORKSPACE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv(): void {
  if (ORIGINAL_ENGINE === undefined) delete process.env.AGENT_ENGINE;
  else process.env.AGENT_ENGINE = ORIGINAL_ENGINE;
  if (ORIGINAL_WORKSPACE === undefined)
    delete process.env.AGENT_NATIVE_WORKSPACE;
  else process.env.AGENT_NATIVE_WORKSPACE = ORIGINAL_WORKSPACE;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  useSharedKey(false);
}

/** Resolves the engine the investigation and chat paths would use. */
async function engineForOrg(orgId: string, email: string) {
  return runWithRequestContext({ userEmail: email, orgId }, async () => {
    const engine = await resolveEngine({ appId: "casefile" });
    return { name: engine.name, apiKey: engine.apiKey };
  });
}

describe("deployment-level shared provider", () => {
  beforeEach(() => {
    // No explicit engine: prove a judge needs no configuration of their own.
    delete process.env.AGENT_ENGINE;
    delete process.env.AGENT_NATIVE_WORKSPACE;
    useSharedKey(false);
    registerBuiltinEngines();
  });

  afterEach(restoreEnv);

  it("serves two independent organizations from one deployment key", async () => {
    useSharedKey(true);

    const a = await engineForOrg(ORG_A, EMAIL_A);
    const b = await engineForOrg(ORG_B, EMAIL_B);

    expect(a.name).toBe("ai-sdk:groq");
    expect(b.name).toBe("ai-sdk:groq");
    // Both organizations are served by the same deployment credential, which
    // lives on the server-side engine object only.
    expect(a.apiKey).toBe(SHARED_KEY);
    expect(b.apiKey).toBe(SHARED_KEY);
  });

  it("does not serve either organization without the deployment key", async () => {
    const a = await engineForOrg(ORG_A, EMAIL_A);
    const b = await engineForOrg(ORG_B, EMAIL_B);

    // The deployment key is what enables the provider; without it the resolver
    // cannot pick Groq for anyone.
    expect(a.name).not.toBe("ai-sdk:groq");
    expect(b.name).not.toBe("ai-sdk:groq");
  });

  it("refuses the deployment key in a production hosted workspace", async () => {
    useSharedKey(true);
    // A hosted workspace is a shared multi-app deployment; the framework must
    // not let one deployment credential act for every organization there.
    process.env.AGENT_NATIVE_WORKSPACE = "true";
    process.env.NODE_ENV = "production";

    const a = await engineForOrg(ORG_A, EMAIL_A);
    const b = await engineForOrg(ORG_B, EMAIL_B);

    expect(a.name).not.toBe("ai-sdk:groq");
    expect(b.name).not.toBe("ai-sdk:groq");
  });
});
