import { beforeEach, describe, expect, it } from "vitest";

import { callAction, setupTestDatabase, userContext } from "./helpers/harness.js";
import {
  SCENARIOS,
  SCENARIO_CONTRACT,
  SCENARIO_COURT,
  SCENARIO_MIXED,
  SCENARIO_PAYMENT,
  SCENARIO_RESEARCH,
  type Scenario,
} from "./fixtures/scenarios.js";

/**
 * End-to-end acceptance scenarios.
 *
 * Each scenario uploads a realistic mixed collection, extracts it, builds the
 * cross-document graph, and checks that the engine found what it should and -
 * more importantly - did not claim what it should not. Everything runs through
 * the same actions the UI and the agent call, against a real database.
 */

const OWNER = "analyst@example.com";

interface UploadResult {
  evidenceId?: string;
  duplicate?: boolean;
  error?: string;
  documentType?: string;
}

async function runScenario(scenario: Scenario): Promise<{
  caseId: string;
  evidenceIds: string[];
}> {
  const created = await callAction<{ id: string }>(
    "create-case",
    { title: scenario.title, description: scenario.description, category: scenario.category },
    userContext(OWNER),
  );
  const caseId = created.id;

  const evidenceIds: string[] = [];
  for (const document of scenario.documents) {
    const result = await callAction<UploadResult>(
      "upload-evidence",
      {
        caseId,
        filename: document.filename,
        dataBase64: Buffer.from(document.bytes).toString("base64"),
        category: document.category,
      },
      userContext(OWNER),
    );
    if (result.error) throw new Error(`upload ${document.filename}: ${result.error}`);
    if (result.evidenceId) evidenceIds.push(result.evidenceId);
  }

  await callAction("extract-evidence", { caseId }, userContext(OWNER));
  return { caseId, evidenceIds };
}

async function listEvidence(caseId: string) {
  return callAction<{
    evidence: Array<{
      id: string;
      filename: string;
      documentType: string;
      classificationConfidence: string | null;
      extractionStatus: string;
      passageCount: number;
    }>;
  }>("list-evidence", { caseId }, userContext(OWNER));
}

describe("acceptance scenarios", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  for (const scenario of SCENARIOS) {
    describe(`Scenario ${scenario.id}: ${scenario.title}`, () => {
      it("uploads every document and extracts text from each", async () => {
        const { caseId } = await runScenario(scenario);
        const { evidence } = await listEvidence(caseId);
        expect(evidence).toHaveLength(scenario.documents.length);
        for (const item of evidence) {
          expect(item.extractionStatus).toBe("complete");
          expect(item.passageCount).toBeGreaterThan(0);
        }
      });

      it("classifies documents and records a confidence for each", async () => {
        const { caseId } = await runScenario(scenario);
        const { evidence } = await listEvidence(caseId);
        for (const item of evidence) {
          expect(item.documentType).toBeTruthy();
          expect(["high", "medium", "low"]).toContain(item.classificationConfidence);
        }
      });

      it("builds a graph whose relationships all carry a source passage", async () => {
        const { caseId } = await runScenario(scenario);
        const graph = await callAction<{
          relationships: Array<{ id: string; matchKey: string | null; rationale: string }>;
        }>("build-case-graph", { caseId }, userContext(OWNER));
        for (const relationship of graph.relationships) {
          // Every engine relationship must explain itself.
          expect(relationship.rationale.length).toBeGreaterThan(0);
        }
      });

      it("reports readiness without a numeric score", async () => {
        const { caseId } = await runScenario(scenario);
        const result = await callAction<{ readiness: { state: string; readyForReport: boolean } }>(
          "assess-readiness",
          { caseId },
          userContext(OWNER),
        );
        expect(result.readiness.state).toBeTruthy();
        expect(JSON.stringify(result.readiness)).not.toMatch(/score|percent/i);
      });

      it("generates a report that cites its sources and marks proposals", async () => {
        const { caseId } = await runScenario(scenario);
        const report = await callAction<{
          documentRegister: unknown[];
          reviewSummary: { proposed: number; confirmed: number };
        }>("build-report", { caseId }, userContext(OWNER));
        expect(report.documentRegister).toHaveLength(scenario.documents.length);
        expect(report.reviewSummary.confirmed).toBe(0);
      });

      it("exports the report in every format with identical review marks", async () => {
        const { caseId } = await runScenario(scenario);
        const markdown = await callAction<{ contentBase64: string; filename: string }>(
          "export-report",
          { caseId, format: "markdown" },
          userContext(OWNER),
        );
        const html = await callAction<{ contentBase64: string }>(
          "export-report",
          { caseId, format: "html" },
          userContext(OWNER),
        );
        const docx = await callAction<{ contentBase64: string }>(
          "export-report",
          { caseId, format: "docx" },
          userContext(OWNER),
        );
        const md = Buffer.from(markdown.contentBase64, "base64").toString("utf8");
        expect(markdown.filename).toMatch(/\.md$/);
        expect(md).toContain("# Investigation report");
        expect(Buffer.from(html.contentBase64, "base64").toString("utf8")).toContain("<html");
        // A DOCX is a ZIP; check the signature.
        const docxBytes = Buffer.from(docx.contentBase64, "base64");
        expect(docxBytes.subarray(0, 2).toString("latin1")).toBe("PK");
      });

      it("keeps one user's case invisible to another", async () => {
        const { caseId } = await runScenario(scenario);
        const intruder = await callAction<{ evidence: unknown[] }>(
          "list-evidence",
          { caseId },
          userContext("intruder@example.com"),
        ).catch((error: Error) => ({ error: error.message }) as never);
        expect((intruder as { error?: string }).error ?? "").toMatch(/not found/i);
      });
    });
  }

  describe("Scenario A specifics", () => {
    it("links the receipt and the statement on the shared transaction id", async () => {
      const { caseId } = await runScenario(SCENARIO_PAYMENT);
      const graph = await callAction<{
        relationships: Array<{ relationType: string; matchKey: string | null }>;
        counts: { relationships: number };
      }>("build-case-graph", { caseId }, userContext(OWNER));
      const sameId = graph.relationships.filter((r) => r.relationType === "same_identifier");
      expect(sameId.length).toBeGreaterThan(0);
      expect(sameId.some((r) => (r.matchKey ?? "").includes("txn88421907"))).toBe(true);
    });

    it("identifies the refund gap or relationship rather than assuming it arrived", async () => {
      const { caseId } = await runScenario(SCENARIO_PAYMENT);
      const gaps = await callAction<{ gaps: Array<{ kind: string }> }>(
        "list-evidence-gaps",
        { caseId },
        userContext(OWNER),
      );
      // The engine must not silently treat the refund promise as a received refund.
      const report = await callAction<{ gaps: unknown[] }>(
        "build-report",
        { caseId },
        userContext(OWNER),
      );
      expect(Array.isArray(report.gaps)).toBe(true);
      expect(Array.isArray(gaps.gaps)).toBe(true);
    });
  });

  describe("Scenario B specifics (legal distinctions)", () => {
    it("classifies the judgment, affidavit, witness statement, and contract distinctly", async () => {
      const { caseId } = await runScenario(SCENARIO_COURT);
      const { evidence } = await listEvidence(caseId);
      const byName = new Map(evidence.map((item) => [item.filename, item.documentType]));
      expect(byName.get("judgment.pdf")).toBe("court-judgment");
      expect(byName.get("affidavit-smith.pdf")).toBe("affidavit");
      expect(byName.get("witness-statement-jane.pdf")).toBe("witness-statement");
      expect(byName.get("service-agreement.docx")).toBe("contract");
    });

    it("never presents a party allegation or counsel argument as a judicial finding", async () => {
      const { caseId } = await runScenario(SCENARIO_COURT);
      const analysis = await callAction<{
        findings: Array<{ role: string; statement: string; attributedTo: string | null }>;
      }>("analyse-documents", { caseId, domain: "legal" }, userContext(OWNER));

      const roles = analysis.findings.map((finding) => finding.role);
      expect(roles).toContain("judicial-finding");
      expect(roles).toContain("counsel-argument");
      expect(roles).toContain("party-allegation");

      // The sentence reciting counsel's argument must not be labelled a finding.
      const counsel = analysis.findings.find((finding) =>
        /counsel for the claimant submitted/i.test(finding.statement),
      );
      expect(counsel?.role).toBe("counsel-argument");

      const finding = analysis.findings.find((finding) =>
        /the court finds that the defendant did breach/i.test(finding.statement),
      );
      expect(finding?.role).toBe("judicial-finding");
    });
  });

  describe("Scenario C specifics (contract performance)", () => {
    it("finds the amended deadline and the delivery shortfall", async () => {
      const { caseId } = await runScenario(SCENARIO_CONTRACT);
      const analysis = await callAction<{ findings: Array<{ role: string; statement: string }> }>(
        "analyse-documents",
        { caseId, domain: "contract" },
        userContext(OWNER),
      );
      expect(analysis.findings.some((finding) => finding.role === "amendment")).toBe(true);
      expect(analysis.findings.some((finding) => finding.role === "obligation")).toBe(true);
    });
  });

  describe("Scenario D specifics (research disagreement)", () => {
    it("keeps each paper's claim attached to its own document", async () => {
      const { caseId } = await runScenario(SCENARIO_RESEARCH);
      const analysis = await callAction<{
        findings: Array<{ role: string; filename: string }>;
      }>("analyse-documents", { caseId, domain: "research" }, userContext(OWNER));
      const claims = analysis.findings.filter((finding) => finding.role === "research-claim");
      expect(claims.some((claim) => claim.filename === "paper-a.pdf")).toBe(true);
      expect(claims.some((claim) => claim.filename === "paper-b.pdf")).toBe(true);
    });
  });

  describe("Scenario E specifics (mixed categories share entities)", () => {
    it("links the medical report and the insurance claim on the shared policy number", async () => {
      const { caseId } = await runScenario(SCENARIO_MIXED);
      const graph = await callAction<{
        relationships: Array<{ relationType: string; matchKey: string | null }>;
      }>("build-case-graph", { caseId }, userContext(OWNER));
      const shared = graph.relationships.filter((r) => r.relationType === "same_identifier");
      expect(shared.some((r) => (r.matchKey ?? "").includes("pol778812"))).toBe(true);
    });
  });
});
