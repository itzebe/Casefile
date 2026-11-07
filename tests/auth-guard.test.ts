import { describe, expect, it } from "vitest";

import {
  assertAuthNotDisabledInDeployment,
  AuthDisabledInDeploymentError,
  isAuthDisabled,
  looksLikeDeployment,
} from "../server/casefile/auth-guard.js";

/**
 * The fail-closed boot guard.
 *
 * The framework reports `AUTH_DISABLED` in production but does not refuse to
 * boot with it. This guard closes that gap: on a deployment, auth-disabled must
 * be a hard failure unless the operator opts in explicitly.
 */

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

describe("isAuthDisabled", () => {
  it("matches the values the framework treats as true", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(isAuthDisabled(env({ AUTH_DISABLED: value }))).toBe(true);
    }
  });

  it("is false for unset and for explicit false", () => {
    expect(isAuthDisabled(env({}))).toBe(false);
    expect(isAuthDisabled(env({ AUTH_DISABLED: "false" }))).toBe(false);
    expect(isAuthDisabled(env({ AUTH_DISABLED: "0" }))).toBe(false);
  });
});

describe("looksLikeDeployment", () => {
  it("is true for every hosted-platform marker", () => {
    for (const key of [
      "NETLIFY",
      "NETLIFY_FUNCTION_NAME",
      "VERCEL",
      "VERCEL_REGION",
      "AWS_LAMBDA_FUNCTION_NAME",
      "LAMBDA_TASK_ROOT",
      "FLY_APP_NAME",
      "K_SERVICE",
    ]) {
      expect(looksLikeDeployment(env({ [key]: "1" }))).toBe(true);
    }
  });

  it("is true for a production server build with no platform marker", () => {
    expect(looksLikeDeployment(env({ NODE_ENV: "production" }))).toBe(true);
  });

  it("is false for a local development process", () => {
    expect(looksLikeDeployment(env({ NODE_ENV: "development" }))).toBe(false);
    expect(looksLikeDeployment(env({}))).toBe(false);
  });
});

describe("assertAuthNotDisabledInDeployment", () => {
  it("throws when auth is disabled on a deployment", () => {
    expect(() =>
      assertAuthNotDisabledInDeployment(env({ AUTH_DISABLED: "true", NODE_ENV: "production" })),
    ).toThrow(AuthDisabledInDeploymentError);
  });

  it("throws for a hosted marker even without NODE_ENV=production", () => {
    expect(() =>
      assertAuthNotDisabledInDeployment(env({ AUTH_DISABLED: "1", VERCEL: "1" })),
    ).toThrow(AuthDisabledInDeploymentError);
  });

  it("names the override in the error so the fix is discoverable", () => {
    const error = (() => {
      try {
        assertAuthNotDisabledInDeployment(env({ AUTH_DISABLED: "true", NODE_ENV: "production" }));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain("CASEFILE_ALLOW_AUTH_DISABLED");
  });

  it("allows auth-disabled in local development", () => {
    expect(() =>
      assertAuthNotDisabledInDeployment(env({ AUTH_DISABLED: "true", NODE_ENV: "development" })),
    ).not.toThrow();
  });

  it("allows a deployment to opt in explicitly", () => {
    expect(() =>
      assertAuthNotDisabledInDeployment(
        env({ AUTH_DISABLED: "true", NODE_ENV: "production", CASEFILE_ALLOW_AUTH_DISABLED: "true" }),
      ),
    ).not.toThrow();
  });

  it("does nothing when auth is enabled", () => {
    expect(() =>
      assertAuthNotDisabledInDeployment(env({ NODE_ENV: "production" })),
    ).not.toThrow();
  });
});
