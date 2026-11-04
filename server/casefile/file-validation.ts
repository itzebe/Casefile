import { createHash } from "node:crypto";

import {
  MAX_EVIDENCE_BYTES,
  SUPPORTED_MIME_TYPES,
  type SupportedMimeType,
} from "../../shared/casefile/types.js";

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
  return null;
}

const TEXT_EXTENSIONS = [".txt", ".text", ".log", ".md"];
const CSV_EXTENSIONS = [".csv", ".tsv"];

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
  const extension = extensionOf(filename);
  if (CSV_EXTENSIONS.includes(extension)) return "text/csv";
  if (TEXT_EXTENSIONS.includes(extension)) return "text/plain";
  // No recognised extension: a comma-and-newline shape is CSV, otherwise text.
  const head = new TextDecoder("utf-8").decode(sample);
  if (head.includes(",") && head.includes("\n")) return "text/csv";
  return "text/plain";
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
    return {
      ok: false,
      code: "unsupported_type",
      message: `The file is not one of the supported types (${SUPPORTED_MIME_TYPES.join(
        ", ",
      )}). Its contents did not match any of them.`,
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
