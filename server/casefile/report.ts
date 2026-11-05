import { and, asc, eq, inArray } from "drizzle-orm";

import type { DocumentType } from "../../shared/casefile/types.js";
import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import { buildCaseGraph, type CaseGraph } from "./graph.js";
import { analyzeDomainPassages, type DomainFinding } from "./domains.js";
import { assessReadiness, type ReadinessAssessment } from "./readiness.js";

/**
 * Investigation report generation.
 *
 * A report is assembled from the case's stored record, not written by a model:
 * every claim, contradiction, gap, and timeline entry in it already exists as a
 * reviewed or proposed row with a citation. The generator's job is to order and
 * label that material honestly, so a reader can tell what a person confirmed
 * from what the agent proposed, and can follow any statement back to its
 * source.
 *
 * Three rules hold in every section:
 *  - A statement carries its review status. A proposed finding is marked as
 *    proposed, never presented as a finding of the investigation.
 *  - A statement carries its citations, including the exact locator, so it can
 *    be checked.
 *  - The legal distinction survives into the report: a party's allegation is
 *    labelled an allegation, not a finding, even in the summary.
 */

export interface ReportCitation {
  evidenceId: string;
  filename: string;
  passageId: string | null;
  ref: string | null;
  quote: string | null;
}

export interface ReportFinding {
  id: string;
  statement: string;
  provenance: string;
  reviewStatus: string;
  confidence: string | null;
  uncertainty: string | null;
  correctedBy: string | null;
  citations: ReportCitation[];
}

export interface ReportEvent {
  id: string;
  statement: string;
  eventDate: string | null;
  eventDateText: string | null;
  datePrecision: string | null;
  dateConflict: boolean;
  reviewStatus: string;
  citations: ReportCitation[];
  orderingNote: string | null;
}

export interface ReportSection {
  heading: string;
  /** A short statement of what the section shows. */
  introduction: string;
  paragraphs: string[];
}

export interface InvestigationReport {
  caseId: string;
  title: string;
  generatedAt: string;
  overview: string;
  scope: string;
  documentRegister: Array<{
    evidenceId: string;
    filename: string;
    documentType: DocumentType | string;
    classificationConfidence: string | null;
    extractionStatus: string;
    pageCount: number | null;
    passageCount: number;
    citationCount: number;
  }>;
  timeline: ReportEvent[];
  undated: ReportEvent[];
  claims: ReportFinding[];
  events: ReportFinding[];
  contradictions: CaseGraph["comparisons"];
  gaps: CaseGraph["gaps"];
  domainFindings: DomainFinding[];
  readiness: ReadinessAssessment;
  outstandingQuestions: string[];
  nextSteps: string[];
  /** Counts of what is proposed versus reviewed, stated plainly. */
  reviewSummary: { proposed: number; confirmed: number; rejected: number };
}

function citationText(citation: ReportCitation): string {
  const location = citation.ref ? ` (${citation.ref})` : "";
  const quote = citation.quote ? ` — "${citation.quote.slice(0, 200)}"` : "";
  return `${citation.filename}${location}${quote}`;
}

export async function buildReport(
  caseId: string,
  userEmail: string,
): Promise<InvestigationReport> {
  const db = getDb();

  const [ownedCase] = await db
    .select()
    .from(schema.cases)
    .where(and(eq(schema.cases.id, caseId), eq(schema.cases.ownerEmail, userEmail)))
    .limit(1);
  if (!ownedCase) {
    throw new Error("Case not found.");
  }

  const evidenceRows = await db
    .select()
    .from(schema.evidence)
    .where(
      and(eq(schema.evidence.caseId, caseId), eq(schema.evidence.ownerEmail, userEmail)),
    )
    .orderBy(asc(schema.evidence.createdAt));
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));

  const passageRows = await db
    .select()
    .from(schema.evidencePassages)
    .where(eq(schema.evidencePassages.caseId, caseId))
    .orderBy(asc(schema.evidencePassages.ordinal));
  const passageRefById = new Map(passageRows.map((row) => [row.id, row.ref]));
  const passageCountByEvidence = new Map<string, number>();
  for (const passage of passageRows) {
    passageCountByEvidence.set(
      passage.evidenceId,
      (passageCountByEvidence.get(passage.evidenceId) ?? 0) + 1,
    );
  }

  const findingRows = await db
    .select()
    .from(schema.findings)
    .where(and(eq(schema.findings.caseId, caseId), eq(schema.findings.ownerEmail, userEmail)))
    .orderBy(asc(schema.findings.eventDate), asc(schema.findings.createdAt));

  const citationRows = await db
    .select()
    .from(schema.findingCitations)
    .where(eq(schema.findingCitations.caseId, caseId));
  const citationsByFinding = new Map<string, ReportCitation[]>();
  for (const citation of citationRows) {
    const list = citationsByFinding.get(citation.findingId) ?? [];
    list.push({
      evidenceId: citation.evidenceId,
      filename: evidenceById.get(citation.evidenceId)?.filename ?? "unknown document",
      passageId: citation.passageId,
      ref: citation.passageId ? (passageRefById.get(citation.passageId) ?? null) : null,
      quote: citation.quote,
    });
    citationsByFinding.set(citation.findingId, list);
  }

  const toReportFinding = (row: (typeof findingRows)[number]): ReportFinding => ({
    id: row.id,
    statement: row.statement,
    provenance: row.provenance,
    reviewStatus: row.reviewStatus,
    confidence: row.confidence,
    uncertainty: row.uncertainty,
    correctedBy: row.correctedBy,
    citations: citationsByFinding.get(row.id) ?? [],
  });

  const claims = findingRows.filter((row) => row.kind === "claim").map(toReportFinding);
  const eventRows = findingRows.filter((row) => row.kind === "event");

  const toReportEvent = (row: (typeof eventRows)[number]): ReportEvent => ({
    id: row.id,
    statement: row.statement,
    eventDate: row.eventDate,
    eventDateText: row.eventDateText,
    datePrecision: row.datePrecision,
    dateConflict: row.dateConflict,
    reviewStatus: row.reviewStatus,
    citations: citationsByFinding.get(row.id) ?? [],
    orderingNote: row.dateConflict
      ? "Sources give conflicting dates; position is approximate."
      : row.datePrecision && row.datePrecision !== "day"
        ? `Only ${row.datePrecision}-level precision is available.`
        : null,
  });

  const datedEvents = eventRows
    .filter((row) => row.eventDate)
    .sort((a, b) => String(a.eventDate).localeCompare(String(b.eventDate)))
    .map(toReportEvent);
  const undatedEvents = eventRows.filter((row) => !row.eventDate).map(toReportEvent);

  const graph = await buildCaseGraph(caseId, userEmail, { persist: false });

  const domainFindings = analyzeDomainPassages(
    passageRows.map((passage) => ({
      evidenceId: passage.evidenceId,
      filename: evidenceById.get(passage.evidenceId)?.filename ?? "unknown document",
      passageId: passage.id,
      ref: passage.ref,
      text: passage.text,
      documentType: evidenceById.get(passage.evidenceId)?.documentType ?? null,
    })),
  );

  const proposed = findingRows.filter((row) => row.reviewStatus === "proposed").length;
  const confirmed = findingRows.filter((row) => row.reviewStatus === "confirmed").length;
  const rejected = findingRows.filter((row) => row.reviewStatus === "rejected").length;

  const documentRegister = evidenceRows.map((row) => ({
    evidenceId: row.id,
    filename: row.filename,
    documentType: row.documentType,
    classificationConfidence: row.classificationConfidence,
    extractionStatus: row.extractionStatus,
    pageCount: row.pageCount,
    passageCount: passageCountByEvidence.get(row.id) ?? 0,
    citationCount: citationRows.filter((citation) => citation.evidenceId === row.id).length,
  }));

  const readiness = assessReadiness({
    evidenceTotal: evidenceRows.length,
    evidencePending: evidenceRows.filter((row) => row.extractionStatus === "pending").length,
    evidenceUnreadable: evidenceRows.filter(
      (row) => row.extractionStatus === "unsupported" || row.extractionStatus === "failed",
    ).length,
    evidenceRead: evidenceRows.filter((row) => row.extractionStatus === "complete").length,
    claimTotal: claims.length,
    claimConfirmed: claims.filter((claim) => claim.reviewStatus === "confirmed").length,
    eventTotal: eventRows.length,
    eventConfirmed: eventRows.filter((event) => event.reviewStatus === "confirmed").length,
    proposedTotal: proposed,
    unsupportedClaimCount: claims.filter((claim) => claim.citations.length === 0).length,
    contradictionCount: graph.counts.contradictions,
    potentialContradictionCount: graph.counts.potentialContradictions,
    gapCount: graph.counts.gaps,
    reportExists: true,
    documentsWithText: new Set(passageRows.map((passage) => passage.evidenceId)).size,
  });

  const outstandingQuestions: string[] = [];
  for (const gap of graph.gaps) {
    outstandingQuestions.push(
      gap.affectsStatement
        ? `Is there evidence that would resolve: ${gap.affectsStatement.slice(0, 120)}?`
        : `What would address the missing ${gap.kind.replace(/_/g, " ")}?`,
    );
  }
  for (const comparison of graph.comparisons) {
    if (comparison.verdict === "contradiction" || comparison.verdict === "potential_contradiction") {
      outstandingQuestions.push(
        `Which account is correct: "${comparison.aStatement.slice(0, 80)}" or "${comparison.bStatement.slice(0, 80)}"?`,
      );
    }
  }

  const nextSteps = [readiness.nextStep, ...readiness.additionalEvidence].filter(Boolean);

  const scope =
    ownedCase.description.trim() ||
    "No scope was recorded. The investigation covers the documents listed below.";

  const overview =
    `This report was assembled from ${evidenceRows.length} document(s) and ${
      findingRows.length
    } finding(s) in the case "${ownedCase.title}". ` +
    `${confirmed} finding(s) have been confirmed by a reviewer and ${proposed} remain proposed. ` +
    `${graph.counts.contradictions} direct contradiction(s) and ${
      graph.counts.gaps
    } gap(s) were identified. ` +
    `Readiness: ${readiness.label}.`;

  return {
    caseId,
    title: ownedCase.title,
    generatedAt: new Date().toISOString(),
    overview,
    scope,
    documentRegister,
    timeline: datedEvents,
    undated: undatedEvents,
    claims,
    events: eventRows.map(toReportFinding),
    contradictions: graph.comparisons,
    gaps: graph.gaps,
    domainFindings,
    readiness,
    outstandingQuestions,
    nextSteps,
    reviewSummary: { proposed, confirmed, rejected },
  };
}

/** A stable citation string for a finding or event, used in the text exports. */
export function findingCitationLine(finding: { citations: ReportCitation[] }): string {
  if (finding.citations.length === 0) return "No source cited.";
  return finding.citations.map(citationText).join("; ");
}

const REVIEW_MARK: Record<string, string> = {
  proposed: "[PROPOSED — not yet reviewed]",
  confirmed: "[CONFIRMED by a reviewer]",
  rejected: "[REJECTED by a reviewer]",
};

/**
 * Renders the report as Markdown. Markdown is the source format; HTML and DOCX
 * exports are derived from it, so every export shows the same content and the
 * same review marks.
 */
export function renderReportMarkdown(report: InvestigationReport): string {
  const lines: string[] = [];
  lines.push(`# Investigation report: ${report.title}`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Readiness: ${report.readiness.label}`);
  lines.push("");
  lines.push("> This report is assembled from the case's stored record. Statements");
  lines.push("> marked [PROPOSED] have not been reviewed by a person and must not be");
  lines.push("> treated as findings. Every statement cites its source.");
  lines.push("");

  lines.push("## 1. Overview");
  lines.push("");
  lines.push(report.overview);
  lines.push("");

  lines.push("## 2. Scope and question");
  lines.push("");
  lines.push(report.scope);
  lines.push("");

  lines.push("## 3. Document register");
  lines.push("");
  lines.push("| Document | Type | Read | Pages | Passages | Citations |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const document of report.documentRegister) {
    lines.push(
      `| ${document.filename} | ${document.documentType} | ${document.extractionStatus} | ${
        document.pageCount ?? "—"
      } | ${document.passageCount} | ${document.citationCount} |`,
    );
  }
  lines.push("");

  lines.push("## 4. Timeline");
  lines.push("");
  if (report.timeline.length === 0 && report.undated.length === 0) {
    lines.push("No events have been proposed or confirmed.");
    lines.push("");
  }
  for (const event of report.timeline) {
    lines.push(
      `- **${event.eventDateText ?? event.eventDate}** — ${event.statement} ${REVIEW_MARK[event.reviewStatus] ?? ""}`,
    );
    lines.push(`  - Source: ${findingCitationLine(event)}`);
    if (event.orderingNote) lines.push(`  - Note: ${event.orderingNote}`);
  }
  if (report.undated.length > 0) {
    lines.push("");
    lines.push("**Undated events** (no determinable date):");
    for (const event of report.undated) {
      lines.push(`- ${event.statement} ${REVIEW_MARK[event.reviewStatus] ?? ""}`);
      lines.push(`  - Source: ${findingCitationLine(event)}`);
    }
  }
  lines.push("");

  lines.push("## 5. Claims and supporting evidence");
  lines.push("");
  if (report.claims.length === 0) lines.push("No claims have been proposed or confirmed.");
  for (const claim of report.claims) {
    lines.push(`- ${claim.statement} ${REVIEW_MARK[claim.reviewStatus] ?? ""}`);
    lines.push(`  - Provenance: ${claim.provenance}`);
    lines.push(`  - Source: ${findingCitationLine(claim)}`);
  }
  lines.push("");

  lines.push("## 6. Contradictions and competing accounts");
  lines.push("");
  const contested = report.contradictions.filter(
    (comparison) =>
      comparison.verdict === "contradiction" || comparison.verdict === "potential_contradiction",
  );
  if (contested.length === 0) {
    lines.push("No contradictions were identified between the documents.");
  }
  for (const comparison of contested) {
    lines.push(`- **${comparison.verdict.replace(/_/g, " ")}** — ${comparison.reason}`);
    lines.push(`  - A: ${comparison.aStatement}`);
    lines.push(`  - B: ${comparison.bStatement}`);
  }
  lines.push("");

  lines.push("## 7. Missing evidence");
  lines.push("");
  if (report.gaps.length === 0) lines.push("No evidence gaps were identified.");
  for (const gap of report.gaps) {
    lines.push(`- ${gap.missing}`);
    lines.push(`  - Why it matters: ${gap.whyItMatters}`);
    lines.push(`  - What would help: ${gap.whatWouldHelp}`);
  }
  lines.push("");

  lines.push("## 8. Field-specific analysis");
  lines.push("");
  const byDomain = new Map<string, typeof report.domainFindings>();
  for (const finding of report.domainFindings) {
    const list = byDomain.get(finding.domain) ?? [];
    list.push(finding);
    byDomain.set(finding.domain, list);
  }
  if (byDomain.size === 0) lines.push("No field-specific statements were identified.");
  for (const [domain, findings] of byDomain) {
    lines.push(`### ${domain}`);
    lines.push("");
    for (const finding of findings) {
      lines.push(
        `- [${finding.role}]${finding.attributedTo ? ` (${finding.attributedTo})` : ""} ${finding.statement}`,
      );
      lines.push(`  - Source: ${finding.filename} (${finding.ref})`);
    }
    lines.push("");
  }

  lines.push("## 9. Outstanding questions");
  lines.push("");
  if (report.outstandingQuestions.length === 0) lines.push("None identified.");
  for (const question of report.outstandingQuestions) lines.push(`- ${question}`);
  lines.push("");

  lines.push("## 10. Recommended next steps");
  lines.push("");
  for (const step of report.nextSteps) lines.push(`- ${step}`);
  lines.push("");

  lines.push("## 11. Review and approval");
  lines.push("");
  lines.push(`- Proposed findings: ${report.reviewSummary.proposed}`);
  lines.push(`- Confirmed findings: ${report.reviewSummary.confirmed}`);
  lines.push(`- Rejected findings: ${report.reviewSummary.rejected}`);
  lines.push("");
  lines.push(
    "This report is a working record. It does not determine legal validity, and it is not a substitute for qualified professional advice.",
  );

  return lines.join("\n");
}

/**
 * Renders the report as a self-contained HTML document. The Markdown is
 * converted with a small, safe renderer that escapes the content first, so a
 * document containing HTML cannot inject markup into the export.
 */
export function renderReportHtml(report: InvestigationReport): string {
  const markdown = renderReportMarkdown(report);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Investigation report: ${escapeHtml(report.title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem; color: #18181b; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.25rem; margin-top: 2rem; }
  h3 { font-size: 1.05rem; } blockquote { border-left: 3px solid #d4d4d8; margin: 0;
    padding-left: 1rem; color: #52525b; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border: 1px solid #e4e4e7; padding: 0.35rem 0.5rem; text-align: left; }
  code { background: #f4f4f5; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
${markdownToHtml(markdown)}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A deliberately small Markdown renderer for the export. It escapes every input
 * first, so the only markup in the output is markup this function emits.
 */
function markdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push("</table>");
      inTable = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^\|/.test(line)) {
      closeList();
      const cells = line.split("|").slice(1, -1);
      if (cells.every((cell) => /^[\s-]+$/.test(cell))) continue;
      if (!inTable) {
        out.push("<table>");
        inTable = true;
        out.push(
          `<tr>${cells.map((cell) => `<th>${inline(escapeHtml(cell.trim()))}</th>`).join("")}</tr>`,
        );
      } else {
        out.push(
          `<tr>${cells.map((cell) => `<td>${inline(escapeHtml(cell.trim()))}</td>`).join("")}</tr>`,
        );
      }
      continue;
    }
    closeTable();

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(escapeHtml(line.replace(/^>\s?/, "")))}</blockquote>`);
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(escapeHtml(bullet[2]!))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    out.push(`<p>${inline(escapeHtml(line))}</p>`);
  }
  closeList();
  closeTable();
  return out.join("\n");
}

/** Applies inline `code` and **bold** to already-escaped text. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
