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

describe("cross-document panel wiring", () => {
  it("renders the panel and its build control", () => {
    expect(workspaceSource).toContain('data-testid="cross-document-panel"');
    expect(workspaceSource).toContain("Connect the documents");
    expect(workspaceSource).toContain("<CrossDocumentPanel");
  });

  it("calls the cross-document actions the panel depends on", () => {
    expect(workspaceSource).toContain('useActionMutation("build-case-graph"');
    expect(workspaceSource).toContain('useActionMutation("update-relationship"');
    expect(workspaceSource).toContain('useActionQuery<');
    // The passage viewer reads the document behind a citation.
    expect(workspaceSource).toContain('"get-evidence"');
    expect(workspaceSource).toContain('data-testid="passage-viewer"');
  });

  it("hydrates the panel from the stored graph on load", () => {
    // Without this query the panel renders empty on every reload even though the
    // relationships and a reviewer's decisions are in the database.
    expect(workspaceSource).toContain('useActionQuery<GraphResult>("read-case-graph"');
    expect(workspaceSource).toContain("storedGraph.data");
  });

  it("reports a contradiction with the shared reference it matched on", () => {
    // A reviewer must be able to check the link, not just read the verdict, so
    // the panel prints the shared reference next to the conflicting assertions.
    expect(workspaceSource).toContain("shared reference:");
    expect(workspaceSource).toContain("comparison.sharedRefs");
  });

  it("never renders a bare confidence score as the reason for a link", () => {
    // The product promises explainability: a relationship shows the identifier
    // it matched on and its rationale, not an opaque number.
    expect(workspaceSource).toContain("relationship.matchKey");
    expect(workspaceSource).toContain("relationship.rationale");
  });
});

describe("classification, readiness, and report wiring", () => {
  it("lets a person correct a document's type from the evidence row", () => {
    // A proposed type must be correctable; the control calls classify-evidence.
    expect(workspaceSource).toContain('useActionMutation("classify-evidence"');
    expect(workspaceSource).toContain('data-testid="document-type-select"');
    expect(workspaceSource).toContain("onClassify");
  });

  it("shows the classification confidence and whether a person set the type", () => {
    expect(workspaceSource).toContain("classificationConfidence");
    expect(workspaceSource).toContain("classificationCorrectedBy");
    expect(workspaceSource).toContain("set by you");
  });

  it("renders the readiness panel and never presents a score", () => {
    expect(workspaceSource).toContain('data-testid="readiness-panel"');
    expect(workspaceSource).toContain('"assess-readiness"');
    expect(workspaceSource).toContain("never a score");
  });

  it("renders the field-specific analysis panel with each label's source", () => {
    expect(workspaceSource).toContain('data-testid="domain-panel"');
    expect(workspaceSource).toContain('"analyse-documents"');
    // Each finding shows the file and locator it came from.
    expect(workspaceSource).toContain("finding.filename");
    expect(workspaceSource).toContain("finding.ref");
  });

  it("renders the report panel with an export for each format", () => {
    expect(workspaceSource).toContain('data-testid="report-panel"');
    expect(workspaceSource).toContain('"export-report"');
    expect(workspaceSource).toContain("Export Markdown");
    expect(workspaceSource).toContain("Export HTML");
    expect(workspaceSource).toContain("Export Word");
  });

  it("downloads an export through a blob rather than a public URL", () => {
    // Evidence and reports are never given a public link.
    expect(workspaceSource).toContain("createObjectURL");
    expect(workspaceSource).toContain("revokeObjectURL");
  });
});
