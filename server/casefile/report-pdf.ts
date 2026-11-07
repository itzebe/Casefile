/**
 * Renders the investigation report as a PDF, with no third-party dependency.
 *
 * The mission asks for a readable PDF export. No PDF library is installed and
 * no paid service is permitted, so this writes a small, correct PDF 1.4 file
 * directly: the fourteen standard fonts are built into every PDF reader, so
 * nothing has to be embedded.
 *
 * It renders the same section list as the DOCX exporter, from the same report
 * object, so citations and proposed/confirmed marks cannot drift between
 * formats. Text is drawn as real, selectable text - not an image.
 */

import type { InvestigationReport } from "./report.js";

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const REVIEW_MARK: Record<string, string> = {
  proposed: "[PROPOSED]",
  confirmed: "[CONFIRMED]",
  rejected: "[REJECTED]",
};

type Style = "title" | "subtitle" | "heading1" | "heading2" | "body" | "list" | "quote";

interface Block {
  text: string;
  style: Style;
}

const STYLE_METRICS: Record<Style, { size: number; leading: number; bold: boolean; italic: boolean; spaceAfter: number }> = {
  title: { size: 20, leading: 26, bold: true, italic: false, spaceAfter: 10 },
  subtitle: { size: 10, leading: 14, bold: false, italic: true, spaceAfter: 4 },
  heading1: { size: 14, leading: 20, bold: true, italic: false, spaceAfter: 8 },
  heading2: { size: 12, leading: 17, bold: true, italic: false, spaceAfter: 6 },
  body: { size: 10, leading: 15, bold: false, italic: false, spaceAfter: 8 },
  list: { size: 10, leading: 14, bold: false, italic: false, spaceAfter: 4 },
  quote: { size: 9, leading: 13, bold: false, italic: true, spaceAfter: 10 },
};

// Standard Helvetica advance widths (units per 1000) for ASCII 32..126.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * Fold a code point to the WinAnsi byte the standard fonts can draw.
 *
 * Latin-1 is a direct byte; a handful of common typographic characters are
 * mapped to their plain equivalents; anything else becomes "?" so the text is
 * visibly approximated rather than silently dropped.
 */
const PUNCT: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"', 0x2013: "-", 0x2014: "-",
  0x2026: "...", 0x2022: "*", 0x20ac: "EUR", 0x20a6: "NGN", 0x00a0: " ",
};

function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x09) out += "    ";
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (PUNCT[code] !== undefined) out += PUNCT[code];
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else out += "?";
  }
  return out;
}

function measure(text: string, size: number, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const index = code - 32;
    const advance = index >= 0 && index < table.length ? table[index]! : 556;
    width += advance;
  }
  return (width / 1000) * size;
}

/** Greedy word wrap; a word longer than the line is hard-split. */
function wrap(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (measure(word, size, bold) <= maxWidth) {
      current = word;
      continue;
    }
    // A single word wider than the line: split it by characters.
    let piece = "";
    for (const ch of word) {
      if (measure(piece + ch, size, bold) > maxWidth && piece) {
        lines.push(piece);
        piece = ch;
      } else {
        piece += ch;
      }
    }
    current = piece;
  }
  if (current) lines.push(current);
  return lines;
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** The report's sections, in the same order the DOCX exporter uses. */
function reportBlocks(report: InvestigationReport): Block[] {
  const blocks: Block[] = [];
  const push = (text: string, style: Style) => blocks.push({ text, style });

  push(`Investigation report: ${report.title}`, "title");
  push(`Generated: ${report.generatedAt}`, "subtitle");
  push(`Readiness: ${report.readiness.label}`, "subtitle");
  push(
    "This report is assembled from the case's stored record. Statements marked [PROPOSED] have not been reviewed by a person and must not be treated as findings. Every statement cites its source.",
    "quote",
  );

  push("1. Overview", "heading1");
  push(report.overview, "body");

  push("2. Scope and question", "heading1");
  push(report.scope, "body");

  push("3. Document register", "heading1");
  for (const document of report.documentRegister) {
    push(
      `${document.filename} — ${document.documentType} — read: ${document.extractionStatus} — pages: ${
        document.pageCount ?? "—"
      } — passages: ${document.passageCount} — citations: ${document.citationCount}`,
      "list",
    );
  }

  push("4. Timeline", "heading1");
  if (report.timeline.length === 0 && report.undated.length === 0) {
    push("No events have been proposed or confirmed.", "list");
  }
  for (const event of report.timeline) {
    push(
      `${event.eventDateText ?? event.eventDate} — ${event.statement} ${REVIEW_MARK[event.reviewStatus] ?? ""}`.trim(),
      "list",
    );
    push(`Source: ${citationLine(event.citations)}`, "list");
    if (event.orderingNote) push(`Note: ${event.orderingNote}`, "list");
  }
  if (report.undated.length > 0) {
    push("Undated events (no determinable date):", "heading2");
    for (const event of report.undated) {
      push(`${event.statement} ${REVIEW_MARK[event.reviewStatus] ?? ""}`.trim(), "list");
      push(`Source: ${citationLine(event.citations)}`, "list");
    }
  }

  push("5. Claims and supporting evidence", "heading1");
  if (report.claims.length === 0) push("No claims have been proposed or confirmed.", "list");
  for (const claim of report.claims) {
    push(`${claim.statement} ${REVIEW_MARK[claim.reviewStatus] ?? ""}`.trim(), "list");
    push(`Provenance: ${claim.provenance}`, "list");
    push(`Source: ${citationLine(claim.citations)}`, "list");
  }

  push("6. Contradictions and competing accounts", "heading1");
  if (report.contradictions.length === 0) {
    push("No contradictions were identified between the documents.", "list");
  }
  for (const comparison of report.contradictions) {
    push(`${comparison.verdict.replace(/_/g, " ")} — ${comparison.reason}`, "list");
    push(`A: ${comparison.aStatement}`, "list");
    push(`B: ${comparison.bStatement}`, "list");
  }

  push("7. Missing evidence", "heading1");
  if (report.gaps.length === 0) push("No evidence gaps were identified.", "list");
  for (const gap of report.gaps) {
    push(gap.missing, "list");
    push(`Why it matters: ${gap.whyItMatters}`, "list");
    push(`What would help: ${gap.whatWouldHelp}`, "list");
  }

  push("8. Field-specific analysis", "heading1");
  const byDomain = new Map<string, InvestigationReport["domainFindings"]>();
  for (const finding of report.domainFindings) {
    const list = byDomain.get(finding.domain) ?? [];
    list.push(finding);
    byDomain.set(finding.domain, list);
  }
  if (byDomain.size === 0) push("No field-specific statements were identified.", "list");
  for (const [domain, findings] of byDomain) {
    push(domain, "heading2");
    for (const finding of findings) {
      push(
        `[${finding.role}]${finding.attributedTo ? ` (${finding.attributedTo})` : ""} ${finding.statement}`,
        "list",
      );
      push(`Source: ${finding.filename} (${finding.ref})`, "list");
    }
  }

  push("9. Outstanding questions", "heading1");
  if (report.outstandingQuestions.length === 0) push("None identified.", "list");
  for (const question of report.outstandingQuestions) push(question, "list");

  push("10. Recommended next steps", "heading1");
  for (const step of report.nextSteps) push(step, "list");

  push("11. Review and approval", "heading1");
  push(`Proposed findings: ${report.reviewSummary.proposed}`, "list");
  push(`Confirmed findings: ${report.reviewSummary.confirmed}`, "list");
  push(`Rejected findings: ${report.reviewSummary.rejected}`, "list");
  push(
    "This report is a working record. It does not determine legal validity, and it is not a substitute for qualified professional advice.",
    "body",
  );

  return blocks;
}

function citationLine(citations: Array<{ filename: string; ref: string | null }>): string {
  if (citations.length === 0) return "(no source recorded)";
  return citations
    .map((citation) => `${citation.filename}${citation.ref ? ` (${citation.ref})` : ""}`)
    .join("; ");
}

interface LaidOutLine {
  text: string;
  style: Style;
}

/** Places wrapped lines onto pages, returning one array of lines per page. */
function paginate(blocks: Block[]): LaidOutLine[][] {
  const pages: LaidOutLine[][] = [];
  let page: LaidOutLine[] = [];
  let y = MARGIN_TOP;

  const newPage = () => {
    pages.push(page);
    page = [];
    y = MARGIN_TOP;
  };

  for (const block of blocks) {
    const metrics = STYLE_METRICS[block.style];
    const lines = wrap(toWinAnsi(block.text), metrics.size, metrics.bold, CONTENT_WIDTH);
    for (const line of lines) {
      if (y + metrics.leading > PAGE_HEIGHT - MARGIN_BOTTOM) newPage();
      page.push({ text: line, style: block.style });
      y += metrics.leading;
    }
    y += metrics.spaceAfter;
  }
  pages.push(page);
  return pages.filter((candidate, index) => candidate.length > 0 || index === 0);
}

function contentStream(lines: LaidOutLine[]): string {
  const parts: string[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;
  for (const line of lines) {
    const metrics = STYLE_METRICS[line.style];
    // Advance first so the baseline sits inside the line box.
    y -= metrics.leading;
    const font = metrics.bold ? "/F2" : metrics.italic ? "/F3" : "/F1";
    parts.push(
      `BT ${font} ${metrics.size} Tf 1 0 0 1 ${MARGIN_X.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(line.text)}) Tj ET`,
    );
  }
  return parts.join("\n");
}

/** Renders the report as a PDF file, returned as bytes. */
export function renderReportPdf(report: InvestigationReport): Uint8Array {
  const pages = paginate(reportBlocks(report));
  const objects: string[] = [];

  // Object numbering: 1 = Catalog, 2 = Pages, 3 = F1, 4 = F2, 5 = F3,
  // then two objects per page (Page, Contents).
  const pageObjectNumbers: number[] = [];
  const firstPageObject = 6;
  pages.forEach((_, index) => pageObjectNumbers.push(firstPageObject + index * 2));

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers
    .map((number) => `${number} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>";

  pages.forEach((lines, index) => {
    const pageNumber = pageObjectNumbers[index]!;
    const contentNumber = pageNumber + 1;
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentNumber} 0 R >>`;
    const stream = contentStream(lines);
    objects[contentNumber] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let number = 1; number < objects.length; number++) {
    const body = objects[number];
    if (body === undefined) continue;
    offsets[number] = Buffer.byteLength(pdf, "latin1");
    pdf += `${number} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  const maxObject = objects.length;
  pdf += `xref\n0 ${maxObject}\n`;
  pdf += "0000000000 65535 f \n";
  for (let number = 1; number < maxObject; number++) {
    const offset = offsets[number] ?? 0;
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObject} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
