import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The workspace's client wiring, checked against its own source.
 *
 * A slow action fails silently in the browser when the component relies on the
 * client's default 60s abort: the server finishes, but the panel never updates
 * and the work looks lost. The timeout is therefore part of the contract, not a
 * detail of the component.
 */

const workspaceSource = readFileSync(
  fileURLToPath(new URL("../app/components/casefile/CaseWorkspace.tsx", import.meta.url)),
  "utf8",
);

describe("workspace client wiring", () => {
  it("gives the analysis action a longer timeout than the client default", async () => {
    const { ANALYSIS_TIMEOUT_MS } = await import(
      "../app/components/casefile/CaseWorkspace.tsx"
    );
    // The framework aborts an action after 60s unless told otherwise.
    expect(ANALYSIS_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("passes that timeout to the analyze-evidence mutation", () => {
    const mutation = workspaceSource.slice(
      workspaceSource.indexOf('useActionMutation("analyze-evidence"'),
      workspaceSource.indexOf('useActionMutation("update-finding"'),
    );
    expect(mutation).toContain("timeoutMs: ANALYSIS_TIMEOUT_MS");
  });

  it("reads the fields the evidence panel renders from get-case", () => {
    // The panel prints `passageCount` and `citedByFindings`; the component's
    // EvidenceItem type must declare them, or the fields are read as undefined.
    expect(workspaceSource).toMatch(/passageCount:\s*number/);
    expect(workspaceSource).toMatch(/citedByFindings:\s*number/);
  });
});
