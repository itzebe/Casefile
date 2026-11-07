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
    expect(workspaceSource).toContain("Export PDF");
    expect(workspaceSource).toContain("Export JSON");
    expect(workspaceSource).toContain("Export CSV");
  });

  it("offers .eml in the evidence picker", () => {
    expect(workspaceSource).toContain(".eml");
  });

  it("downloads an export through a blob rather than a public URL", () => {
    // Evidence and reports are never given a public link.
    expect(workspaceSource).toContain("createObjectURL");
    expect(workspaceSource).toContain("revokeObjectURL");
  });
});

describe("investigation brief and navigation wiring", () => {
  it("renders the investigation brief and its provenance key", () => {
    expect(workspaceSource).toContain('data-testid="investigation-brief"');
    expect(workspaceSource).toContain('data-testid="provenance-legend"');
    expect(workspaceSource).toContain("<InvestigationBrief");
  });

  it("derives the brief's counts from the stored record, not a model", () => {
    // The brief is a deterministic summary: it reads the investigation status
    // and the persisted graph, and never asks a model for a number.
    expect(workspaceSource).toContain("investigation.claims.confirmed");
    expect(workspaceSource).toContain("investigation.evidence.pending");
    expect(workspaceSource).toContain("graph?.counts.contradictions");
  });

  it("lets a statement jump to the passage it rests on", () => {
    // A finding's citation is a control that opens the source document at the
    // quoted passage, so the reader can check the link rather than trust it.
    expect(workspaceSource).toContain("onSelectEvidence");
    expect(workspaceSource).toContain("onSelectEvidence(citation.evidenceId, citation.passageId)");
  });

  it("shows which findings use the open document", () => {
    // The reverse direction: an open document lists the findings that cite it.
    expect(workspaceSource).toContain('data-testid="passage-viewer-findings"');
    expect(workspaceSource).toContain("Used by ");
  });

  it("brings the cited passage into view when a citation is opened", () => {
    expect(workspaceSource).toContain("selectedPassageRef");
    expect(workspaceSource).toContain("scrollIntoView");
  });

  it("offers a case-scoped entry into the agent", () => {
    expect(workspaceSource).toContain('data-testid="ask-agent-about-case"');
    expect(workspaceSource).toContain("markAgentChatHomeHandoff");
    expect(workspaceSource).toContain("chatThreadPath");
  });
});

describe("analysis timeout hierarchy", () => {
  /**
   * The hosting platform stops a function at 300s. Three budgets have to nest
   * under that limit, or a long analysis dies in a way the browser cannot
   * explain: the platform kill and the client's own abort land together, and
   * the click looks like it did nothing at all.
   */
  const PLATFORM_FUNCTION_LIMIT_MS = 300_000;
  const modelSource = readFileSync(
    fileURLToPath(new URL("../server/casefile/model.ts", import.meta.url)),
    "utf8",
  );

  it("keeps the client's analysis budget under the platform function limit", async () => {
    const { ANALYSIS_TIMEOUT_MS } = await import(
      "../app/components/casefile/CaseWorkspace.tsx"
    );
    expect(ANALYSIS_TIMEOUT_MS).toBeLessThan(PLATFORM_FUNCTION_LIMIT_MS);
  });

  it("keeps the server's model budget under the platform function limit", () => {
    const match = modelSource.match(/const DEFAULT_TIMEOUT_MS = ([\d_]+)/);
    expect(match).not.toBeNull();
    const serverModelTimeoutMs = Number(match![1].replace(/_/g, ""));
    expect(serverModelTimeoutMs).toBeLessThan(PLATFORM_FUNCTION_LIMIT_MS);
  });

  it("lets the client outlast the server so the server's reason is seen", async () => {
    // The client timeout must be strictly above the server's model budget.
    // When it was 240s against a 260s server budget the browser dropped the
    // request 20s before the server would have answered, so the stated reason
    // ("ran out of its 260s budget") never reached the user - the failure read
    // as a dead click. Both numbers sat under the platform limit, so the two
    // checks above passed while the nesting was still wrong.
    const { ANALYSIS_TIMEOUT_MS } = await import(
      "../app/components/casefile/CaseWorkspace.tsx"
    );
    const match = modelSource.match(/const DEFAULT_TIMEOUT_MS = ([\d_]+)/);
    const serverModelTimeoutMs = Number(match![1].replace(/_/g, ""));
    expect(ANALYSIS_TIMEOUT_MS).toBeGreaterThan(serverModelTimeoutMs);
  });
});

describe("analysis progress is visible", () => {
  it("shows how long the running analysis has been going", () => {
    // A button that reads the same at second 1 and second 120 is
    // indistinguishable from a click that never registered.
    expect(workspaceSource).toContain("analysisStartedAt");
    expect(workspaceSource).toContain("analysisElapsed");
    expect(workspaceSource).toContain("Elapsed ${analysisElapsed}s");
  });

  it("clears a previous result and error when a new analysis starts", () => {
    const onClick = workspaceSource.slice(
      workspaceSource.indexOf("setAnalysisStartedAt(Date.now())") - 200,
      workspaceSource.indexOf("setAnalysisStartedAt(Date.now())"),
    );
    expect(onClick).toContain("setNotice(null)");
    expect(onClick).toContain("setError(null)");
  });
});

describe("landing page is product-specific", () => {
  const homeSource = readFileSync(
    fileURLToPath(new URL("../app/components/home/HomePage.tsx", import.meta.url)),
    "utf8",
  );

  it("does not ship the template's generic starter copy", () => {
    expect(homeSource).not.toContain("Open Source");
    expect(homeSource).not.toContain("home.docsAddAction");
    expect(homeSource).not.toContain("home.communityTitle");
  });

  it("states the product's promise and links to the cases", () => {
    expect(homeSource).toContain("Evidence intelligence");
    expect(homeSource).toContain("CASES_PATH");
    expect(homeSource).toContain("Analysis proposes");
  });
});

describe("both demonstrations are reachable from the cases page", () => {
  const casesSource = readFileSync(
    fileURLToPath(new URL("../app/components/casefile/CasesPage.tsx", import.meta.url)),
    "utf8",
  );

  it("offers the payment and court demos, each naming its scenario", () => {
    expect(casesSource).toContain('data-testid="load-demo-case"');
    expect(casesSource).toContain('data-testid="load-court-demo-case"');
    // The court button must actually request the court scenario, not the
    // default, or both buttons load the same case.
    expect(casesSource).toContain('scenario: "court"');
  });

  it("offers both demos from the empty state too", () => {
    expect(casesSource).toContain('data-testid="load-demo-case-empty"');
    expect(casesSource).toContain('data-testid="load-court-demo-case-empty"');
  });
});

/**
 * Tap targets.
 *
 * A control a person must aim at needs a 24x24 CSS-pixel hit area (WCAG 2.5.8,
 * Target Size Minimum). The workspace once shipped block and list controls at
 * 16px tall - a 16px-tall "Confirm" beside a 16px-tall "Dismiss" is a
 * mis-tap waiting to happen. Inline links inside a sentence are exempt, so the
 * one underlined control without vertical padding (the quoted-passage link) is
 * deliberately excluded and asserted here so the exemption stays intentional.
 */
describe("tap targets in the case workspace", () => {
  const buttonTags = [...workspaceSource.matchAll(/<button[\s\S]*?>/g)].map((m) => m[0]);
  const underlined = buttonTags.filter((tag) => tag.includes("underline"));

  it("finds the underlined controls it means to police", () => {
    expect(underlined.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every non-inline underlined control vertical padding", () => {
    const offenders = underlined.filter(
      (tag) => !/\bpy-/.test(tag) && !/ms-1 underline/.test(tag),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps exactly one inline quoted-passage link exempt", () => {
    const exempt = underlined.filter((tag) => /ms-1 underline/.test(tag));
    expect(exempt).toHaveLength(1);
  });
});
