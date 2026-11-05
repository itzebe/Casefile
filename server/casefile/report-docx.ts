import type { InvestigationReport } from "./report.js";
import { findingCitationLine } from "./report.js";
import { writeZip } from "./zip.js";

/**
 * DOCX export of an investigation report.
 *
 * A .docx is a ZIP of XML parts, and this writer emits the four parts Word
 * requires: [Content_Types].xml, _rels/.rels, word/document.xml, and
 * word/_rels/document.xml.rels. Paragraphs use a small set of named styles
 * (Title, Heading1, Heading2, ListParagraph) declared in word/styles.xml, so the
 * export opens as a structured document rather than a wall of plain text.
 *
 * The content is built from the same report object the Markdown export uses, so
 * the two exports never diverge: a statement marked proposed in one is marked
 * proposed in the other.
 */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Control characters are not valid in XML and would make Word reject the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

interface Paragraph {
  style?: string | undefined;
  text: string;
}

function paragraph({ style, text }: Paragraph): string {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  // Split on newlines so a multi-line cell does not collapse into one run.
  const runs = text
    .split("\n")
    .map((line, index) =>
      index === 0
        ? `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
        : `<w:r><w:br/><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`,
    )
    .join("");
  return `<w:p>${styleXml}${runs}</w:p>`;
}

const REVIEW_MARK: Record<string, string> = {
  proposed: "[PROPOSED - not yet reviewed]",
  confirmed: "[CONFIRMED by a reviewer]",
  rejected: "[REJECTED by a reviewer]",
};

function buildParagraphs(report: InvestigationReport): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const push = (text: string, style?: string) => paragraphs.push({ text, style });

  push(`Investigation report: ${report.title}`, "Title");
  push(`Generated: ${report.generatedAt}`, "Subtitle");
  push(`Readiness: ${report.readiness.label}`, "Subtitle");
  push(
    "This report is assembled from the case's stored record. Statements marked [PROPOSED] have not been reviewed by a person and must not be treated as findings. Every statement cites its source.",
    "Quote",
  );

  push("1. Overview", "Heading1");
  push(report.overview);

  push("2. Scope and question", "Heading1");
  push(report.scope);

  push("3. Document register", "Heading1");
  for (const document of report.documentRegister) {
    push(
      `${document.filename} — ${document.documentType} — read: ${document.extractionStatus} — pages: ${
        document.pageCount ?? "—"
      } — passages: ${document.passageCount} — citations: ${document.citationCount}`,
      "ListParagraph",
    );
  }

  push("4. Timeline", "Heading1");
  if (report.timeline.length === 0 && report.undated.length === 0) {
    push("No events have been proposed or confirmed.");
  }
  for (const event of report.timeline) {
    push(
      `${event.eventDateText ?? event.eventDate} — ${event.statement} ${REVIEW_MARK[event.reviewStatus] ?? ""}`,
      "ListParagraph",
    );
    push(`Source: ${findingCitationLine(event)}`, "ListParagraph");
    if (event.orderingNote) push(`Note: ${event.orderingNote}`, "ListParagraph");
  }
  if (report.undated.length > 0) {
    push("Undated events (no determinable date):", "Heading2");
    for (const event of report.undated) {
      push(`${event.statement} ${REVIEW_MARK[event.reviewStatus] ?? ""}`, "ListParagraph");
      push(`Source: ${findingCitationLine(event)}`, "ListParagraph");
    }
  }

  push("5. Claims and supporting evidence", "Heading1");
  if (report.claims.length === 0) push("No claims have been proposed or confirmed.");
  for (const claim of report.claims) {
    push(`${claim.statement} ${REVIEW_MARK[claim.reviewStatus] ?? ""}`, "ListParagraph");
    push(`Provenance: ${claim.provenance}`, "ListParagraph");
    push(`Source: ${findingCitationLine(claim)}`, "ListParagraph");
  }

  push("6. Contradictions and competing accounts", "Heading1");
  const contested = report.contradictions;
  if (contested.length === 0) push("No contradictions were identified between the documents.");
  for (const comparison of contested) {
    push(`${comparison.verdict.replace(/_/g, " ")} — ${comparison.reason}`, "ListParagraph");
    push(`A: ${comparison.aStatement}`, "ListParagraph");
    push(`B: ${comparison.bStatement}`, "ListParagraph");
  }

  push("7. Missing evidence", "Heading1");
  if (report.gaps.length === 0) push("No evidence gaps were identified.");
  for (const gap of report.gaps) {
    push(gap.missing, "ListParagraph");
    push(`Why it matters: ${gap.whyItMatters}`, "ListParagraph");
    push(`What would help: ${gap.whatWouldHelp}`, "ListParagraph");
  }

  push("8. Field-specific analysis", "Heading1");
  const byDomain = new Map<string, typeof report.domainFindings>();
  for (const finding of report.domainFindings) {
    const list = byDomain.get(finding.domain) ?? [];
    list.push(finding);
    byDomain.set(finding.domain, list);
  }
  if (byDomain.size === 0) push("No field-specific statements were identified.");
  for (const [domain, findings] of byDomain) {
    push(domain, "Heading2");
    for (const finding of findings) {
      push(
        `[${finding.role}]${finding.attributedTo ? ` (${finding.attributedTo})` : ""} ${finding.statement}`,
        "ListParagraph",
      );
      push(`Source: ${finding.filename} (${finding.ref})`, "ListParagraph");
    }
  }

  push("9. Outstanding questions", "Heading1");
  if (report.outstandingQuestions.length === 0) push("None identified.");
  for (const question of report.outstandingQuestions) push(question, "ListParagraph");

  push("10. Recommended next steps", "Heading1");
  for (const step of report.nextSteps) push(step, "ListParagraph");

  push("11. Review and approval", "Heading1");
  push(`Proposed findings: ${report.reviewSummary.proposed}`, "ListParagraph");
  push(`Confirmed findings: ${report.reviewSummary.confirmed}`, "ListParagraph");
  push(`Rejected findings: ${report.reviewSummary.rejected}`, "ListParagraph");
  push(
    "This report is a working record. It does not determine legal validity, and it is not a substitute for qualified professional advice.",
  );

  return paragraphs;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

/** Renders the report as a .docx file, returned as bytes. */
export function renderReportDocx(report: InvestigationReport): Uint8Array {
  const body = buildParagraphs(report)
    .map((entry) => paragraph(entry))
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body>
</w:document>`;

  return writeZip([
    { name: "[Content_Types].xml", content: CONTENT_TYPES },
    { name: "_rels/.rels", content: ROOT_RELS },
    { name: "word/document.xml", content: document },
    { name: "word/_rels/document.xml.rels", content: DOCUMENT_RELS },
    { name: "word/styles.xml", content: STYLES },
  ]);
}
