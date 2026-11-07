/**
 * Document extraction.
 *
 * One rule governs this file: extraction either produces text with a real
 * location, or it reports why it could not. It never returns empty text as if
 * the document were empty, and never substitutes guessed content for a file it
 * could not read.
 *
 * Every passage carries a locator (page number, row number, or chunk index) so
 * a claim built on it can be traced back to a position in the original file.
 */

import { extractDocx, extractMarkdown, extractXlsx } from "./ooxml.js";
import { extractEmail } from "./email.js";

export type LocatorType = "page" | "row" | "chunk" | "document";

export interface ExtractedPassage {
  locatorType: LocatorType;
  locatorValue: number | null;
  ref: string;
  text: string;
}

export type ExtractionStatus = "complete" | "unsupported" | "failed";

export interface ExtractionResult {
  status: ExtractionStatus;
  passages: ExtractedPassage[];
  pageCount?: number | undefined;
  /** Why extraction could not run at all (unsupported type, OCR absent). */
  limitation?: string | undefined;
  /** Why extraction failed on this specific file (corrupt, mislabelled). */
  error?: string | undefined;
}

const MAX_PASSAGE_CHARS = 4000;
const MAX_CSV_ROWS = 5000;
const MAX_CSV_COLUMNS = 128;
const MAX_CSV_CELL_CHARS = 2000;

function ok(passages: ExtractedPassage[], pageCount?: number): ExtractionResult {
  return { status: "complete", passages, pageCount };
}

function unsupported(limitation: string): ExtractionResult {
  return { status: "unsupported", passages: [], limitation };
}

function failed(error: string): ExtractionResult {
  return { status: "failed", passages: [], error };
}

/** Splits long text into bounded chunks, preserving order. */
function chunkText(text: string): ExtractedPassage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= MAX_PASSAGE_CHARS) {
    return [{ locatorType: "chunk", locatorValue: 1, ref: "part 1", text: trimmed }];
  }
  const passages: ExtractedPassage[] = [];
  // Split on paragraph boundaries where possible so a chunk reads coherently.
  const paragraphs = trimmed.split(/\n{2,}/);
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (!buffer.trim()) return;
    index += 1;
    passages.push({
      locatorType: "chunk",
      locatorValue: index,
      ref: `part ${index}`,
      text: buffer.trim(),
    });
    buffer = "";
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_PASSAGE_CHARS) {
      flush();
      for (let i = 0; i < paragraph.length; i += MAX_PASSAGE_CHARS) {
        index += 1;
        passages.push({
          locatorType: "chunk",
          locatorValue: index,
          ref: `part ${index}`,
          text: paragraph.slice(i, i + MAX_PASSAGE_CHARS).trim(),
        });
      }
      continue;
    }
    if ((buffer + "\n\n" + paragraph).length > MAX_PASSAGE_CHARS) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return passages;
}

/**
 * Decodes text with real validation. A NUL byte means the file is not text, and
 * a fatal UTF-8 decode means the bytes are not UTF-8; both are reported instead
 * of being coerced into mojibake.
 */
function decodeText(data: Uint8Array): { text: string } | { error: string } {
  const sample = data.subarray(0, Math.min(data.length, 8192));
  if (sample.includes(0)) {
    return { error: "File contains NUL bytes, so it is not plain text." };
  }
  // Honour a UTF-16 byte-order mark rather than mangling it as UTF-8.
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(data.subarray(2)) };
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(data.subarray(2)) };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data) };
  } catch {
    return {
      error: "File is not valid UTF-8 text (it may be binary or another encoding).",
    };
  }
}

export function extractTextFile(data: Uint8Array): ExtractionResult {
  const decoded = decodeText(data);
  if ("error" in decoded) return failed(decoded.error);
  const passages = chunkText(decoded.text);
  if (passages.length === 0) return failed("File contains no readable text.");
  return ok(passages);
}

/**
 * Parses CSV with the source row number preserved. Rows are numbered as they
 * appear in the file (the header is row 1), so a citation says "row 42" and
 * means the 42nd line a reviewer will see.
 */
export async function extractCsvFile(data: Uint8Array): Promise<ExtractionResult> {
  const decoded = decodeText(data);
  if ("error" in decoded) return failed(decoded.error);
  try {
    const { parse } = await import("csv-parse/sync");
    const rows = parse(decoded.text, {
      relaxColumnCount: true,
      skipEmptyLines: true,
      bom: true,
      to: MAX_CSV_ROWS,
    }) as string[][];
    if (rows.length === 0) return failed("CSV contains no rows.");

    const header = rows[0] ?? [];
    const columnCount = Math.max(...rows.map((r) => r.length));
    if (columnCount > MAX_CSV_COLUMNS) {
      return unsupported(
        `CSV has ${columnCount} columns, above the ${MAX_CSV_COLUMNS}-column limit.`,
      );
    }

    const passages: ExtractedPassage[] = [];
    rows.forEach((row, index) => {
      const lineNumber = index + 1;
      const cells = row.map((cell) => String(cell ?? "").slice(0, MAX_CSV_CELL_CHARS));
      // Render each row as labelled pairs when a header exists, so the agent
      // reads "amount: 42.00" rather than an unlabelled tuple.
      const rendered =
        index === 0
          ? `Header: ${cells.join(" | ")}`
          : cells
              .map((cell, column) => {
                const name = header[column]?.trim() || `column ${column + 1}`;
                return `${name}: ${cell}`;
              })
              .join("\n");
      if (!rendered.trim()) return;
      passages.push({
        locatorType: "row",
        locatorValue: lineNumber,
        ref: `row ${lineNumber}`,
        text: rendered,
      });
    });

    if (passages.length === 0) return failed("CSV contains no non-empty rows.");
    return ok(passages, rows.length);
  } catch (error) {
    return failed(
      `CSV could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface PdfPage {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
}

interface PdfDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy?: () => Promise<void>;
}

/**
 * Extracts text from a PDF, one passage per page so every quote keeps its page
 * number. `isEvalSupported: false` and `disableFontFace: true` keep an embedded
 * script or font from executing during extraction.
 */
export async function extractPdfFile(data: Uint8Array): Promise<ExtractionResult> {
  let doc: PdfDocument | null = null;
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      getDocument: (options: Record<string, unknown>) => {
        promise: Promise<PdfDocument>;
      };
    };

    // Copy into a fresh buffer: pdf.js transfers (and detaches) the input.
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
    });
    doc = await loadingTask.promise;

    const passages: ExtractedPassage[] = [];
    let emptyPages = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page: PdfPage = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        emptyPages += 1;
        continue;
      }
      passages.push({
        locatorType: "page",
        locatorValue: pageNumber,
        ref: `page ${pageNumber}`,
        text: text.slice(0, MAX_PASSAGE_CHARS),
      });
    }

    const pageCount = doc.numPages;
    if (passages.length === 0) {
      // A scanned PDF is images, not text. Say so, and say what would fix it.
      return unsupported(
        `PDF has ${pageCount} page(s) but no embedded text layer${
          emptyPages > 0 ? " (likely a scan)" : ""
        }. OCR is required for this file.`,
      );
    }
    return ok(passages, pageCount);
  } catch (error) {
    return failed(
      `PDF could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      await doc?.destroy?.();
    } catch {
      // Releasing the document is best-effort; a failure here does not change
      // the extraction result.
    }
  }
}

/**
 * Images. OCR needs a local engine; when none is available the file is stored
 * and shown, but reported as not extractable rather than silently yielding
 * nothing. See `server/casefile/ocr.ts` for the engine probe.
 */
export async function extractImageFile(
  data: Uint8Array,
  mimeType: string,
): Promise<ExtractionResult> {
  const { runOcr, ocrUnavailableReason } = await import("./ocr.js");
  const result = await runOcr(data, mimeType);
  if (result.kind === "ok") {
    const passages = chunkText(result.text).map((passage, index) => ({
      ...passage,
      locatorType: "document" as const,
      locatorValue: index + 1,
      ref: `image text ${index + 1}`,
    }));
    if (passages.length === 0) {
      return unsupported("OCR ran but found no readable text in the image.");
    }
    return ok(passages, 1);
  }
  if (result.kind === "empty") {
    return unsupported("OCR ran but found no readable text in the image.");
  }
  if (result.kind === "failed") return failed(result.error);
  return unsupported(
    ocrUnavailableReason() ?? "OCR is not available in this environment.",
  );
}

export async function extractEvidence(input: {
  mimeType: string;
  filename: string;
  data: Uint8Array;
}): Promise<ExtractionResult> {
  switch (input.mimeType) {
    case "application/pdf":
      return extractPdfFile(input.data);
    case "text/plain":
      return extractTextFile(input.data);
    case "text/markdown":
      return extractMarkdown(input.data);
    case "text/csv":
      return extractCsvFile(input.data);
    case "message/rfc822":
      return extractEmail(input.data);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocx(input.data);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return extractXlsx(input.data);
    case "image/png":
    case "image/jpeg":
      return extractImageFile(input.data, input.mimeType);
    default:
      return unsupported(`Extraction is not supported for ${input.mimeType}.`);
  }
}
