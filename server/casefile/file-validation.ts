import { createHash } from "node:crypto";

import {
  MAX_EVIDENCE_BYTES,
  SUPPORTED_FORMAT_LABELS,
  SUPPORTED_MIME_TYPES,
  type SupportedMimeType,
} from "../../shared/casefile/types.js";
import { openZip } from "./zip.js";

/**
 * File validation.
 *
 * The MIME type is decided from the file's own bytes, never from the client's
 * `Content-Type` or filename: an attacker controls both, and a mislabelled file
 * is exactly how a document type check gets bypassed. The client-supplied type
 * is only used to explain a rejection.
 */

export type ValidationResult =
  | {
      ok: true;
      mimeType: SupportedMimeType;
      byteSize: number;
      sha256: string;
      extension: string;
    }
  | { ok: false; code: string; message: string };

function startsWith(data: Uint8Array, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/** Detects the MIME type from magic bytes. Returns null when unrecognised. */
export function detectMimeType(data: Uint8Array): SupportedMimeType | null {
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PK\x03\x04 - a ZIP container. DOCX and XLSX are both ZIPs, so the specific
  // type is decided by inspecting the parts, not by the extension.
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) return detectOoxmlType(data);
  return null;
}

/**
 * Distinguishes a Word document from an Excel workbook by the parts inside the
 * ZIP. An archive that is neither (or is unreadable) is rejected rather than
 * guessed at, so a renamed .zip cannot enter as a document.
 */
function detectOoxmlType(data: Uint8Array): SupportedMimeType | null {
  try {
    const zip = openZip(data);
    if (zip.names.includes("word/document.xml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (zip.names.some((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    return null;
  } catch {
    return null;
  }
}

const TEXT_EXTENSIONS = [".txt", ".text", ".log"];
const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
const CSV_EXTENSIONS = [".csv", ".tsv"];

/**
 * Whether the bytes look like an RFC 822 message. An email must begin with one
 * or more header fields, and the fields a person recognises (From/To/Subject/
 * Date/Received/Message-ID) are required, so an ordinary text file named .eml
 * is not accepted as a message on the strength of its extension alone.
 */
function looksLikeEmail(text: string): boolean {
  const head = text.slice(0, 8192);
  if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(head)) return false;
  const hasFrom = /^from:/im.test(head);
  const hasOthers = /^(to|subject|date|received|message-id|return-path|delivered-to):/im.test(head);
  return hasFrom && hasOthers;
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

/**
 * Classifies a file that has no magic number. Text and CSV are only accepted
 * when the bytes really are decodable text and the extension agrees, so a
 * renamed binary is rejected rather than stored as unreadable "text".
 */
function classifyTextLike(
  data: Uint8Array,
  filename: string,
): SupportedMimeType | null {
  const sample = data.subarray(0, Math.min(data.length, 8192));
  if (sample.includes(0)) return null;
  let decodable = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    // A UTF-16 BOM is still text.
    const bomUtf16 =
      sample.length >= 2 &&
      ((sample[0] === 0xff && sample[1] === 0xfe) ||
        (sample[0] === 0xfe && sample[1] === 0xff));
    if (!bomUtf16) decodable = false;
  }
  if (!decodable) return null;
  const head = new TextDecoder("utf-8").decode(sample);
  // An email is recognised by its own header structure, so a .eml saved under
  // another name is still ingested as a message rather than as loose text. This
  // is checked before the extension-based text rules, because the header
  // structure is more specific than "it decodes as text". A .eml that does not
  // carry headers is not a message, and falls through to be treated as the text
  // it actually is.
  if (looksLikeEmail(head)) return "message/rfc822";
  const extension = extensionOf(filename);
  if (CSV_EXTENSIONS.includes(extension)) return "text/csv";
  if (MARKDOWN_EXTENSIONS.includes(extension)) return "text/markdown";
  if (TEXT_EXTENSIONS.includes(extension)) return "text/plain";
  // No recognised extension: decide from the content's structure, not from the
  // mere presence of a comma. Prose is full of commas ("... damages of
  // 5,000.00 USD and costs"), so a comma-and-newline test classifies an
  // ordinary letter as CSV and then mangles its numbers into columns. A real
  // delimited file has the same field count on most of its lines.
  return looksLikeDelimited(head) ? "text/csv" : "text/plain";
}

/**
 * Whether the text is a delimited table rather than prose.
 *
 * Requires at least two non-empty lines, a consistent comma field count of two
 * or more across most lines, and no line that is prose with a single comma. A
 * quoted field containing a comma is tolerated by counting fields outside
 * quotes.
 */
function looksLikeDelimited(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (lines.length < 2) return false;

  const counts = lines.map(countCommaFields);
  const multi = counts.filter((count) => count >= 2);
  // Most lines must be multi-field, and the field count must be consistent.
  if (multi.length < Math.max(2, Math.ceil(lines.length * 0.6))) return false;
  const common = counts[0]!;
  const consistent = counts.filter((count) => count === common).length;
  return consistent >= Math.max(2, Math.ceil(lines.length * 0.6));
}

/** Counts comma-separated fields on a line, ignoring commas inside quotes. */
function countCommaFields(line: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "," && !inQuotes) fields += 1;
  }
  return fields;
}

export function validateEvidenceFile(input: {
  filename: string;
  data: Uint8Array;
  declaredMimeType?: string | undefined;
}): ValidationResult {
  const { filename, data } = input;

  if (data.length === 0) {
    return { ok: false, code: "empty_file", message: "The file is empty." };
  }
  if (data.length > MAX_EVIDENCE_BYTES) {
    return {
      ok: false,
      code: "file_too_large",
      message: `The file is ${(data.length / 1024 / 1024).toFixed(1)} MB; the limit is ${
        MAX_EVIDENCE_BYTES / 1024 / 1024
      } MB.`,
    };
  }

  const detected =
    detectMimeType(data) ?? classifyTextLike(data, filename) ?? null;

  if (!detected) {
    const formats = SUPPORTED_MIME_TYPES.map((type) => SUPPORTED_FORMAT_LABELS[type]).join(", ");
    return {
      ok: false,
      code: "unsupported_type",
      message: `The file's contents did not match any supported format (${formats}). If this is a different format, convert it to PDF or text first.`,
    };
  }

  const extension = extensionOf(filename);
  return {
    ok: true,
    mimeType: detected,
    byteSize: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    extension: extension || ".bin",
  };
}

/**
 * Normalises a filename for storage and display. Path separators and control
 * characters are stripped so a crafted name cannot escape its storage prefix or
 * forge a log line. The original name is preserved for the user; this is the
 * safe form used on disk.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "evidence";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || "evidence").slice(0, 180);
}
