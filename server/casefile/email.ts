/**
 * Email (.eml / message/rfc822) extraction.
 *
 * An email is evidence the way a letter is: the headers establish who sent what
 * to whom and when, and the body is the statement itself. This parser reads the
 * message's own MIME structure - it never trusts a filename or a client-supplied
 * content type - and produces text passages with real locators so a finding
 * built on an email points back at the header block or a specific body part.
 *
 * Two limits are deliberate and are reported rather than hidden:
 *
 *  - Attachments are listed by name and type, but their bytes are not extracted
 *    here. Following attachments recursively would let one upload expand into an
 *    unbounded amount of work; a person uploads the attachment as its own
 *    evidence file instead. The listing makes the omission visible.
 *  - HTML-only bodies are reduced to text by removing tags. The reduction is
 *    lossy (layout is lost), so the passage says it came from HTML.
 *
 * Nothing here performs network access, evaluates a template, or follows a
 * link: an email is parsed as text, nothing more.
 */

import type { ExtractedPassage, ExtractionResult } from "./extraction.js";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_CHARS = 4000;
const MAX_MIME_DEPTH = 6;

export interface ParsedEmail {
  headers: Record<string, string>;
  /** The best available body text: text/plain preferred, else text/html reduced. */
  bodyText: string;
  /** Where bodyText came from, so the passage can say so. */
  bodySource: "text/plain" | "text/html" | "none";
  attachments: Array<{ filename: string; contentType: string }>;
  /** True when the message declared a multipart structure we understood. */
  multipart: boolean;
}

function ok(passages: ExtractedPassage[], pageCount?: number): ExtractionResult {
  return { status: "complete", passages, pageCount };
}

function unsupported(limitation: string): ExtractionResult {
  return { status: "unsupported", passages: [], limitation };
}

/** Splits raw message bytes into a header block and a body, on the first blank line. */
function splitHeadersAndBody(text: string): { headerBlock: string; body: string } {
  // A blank line (CRLF CRLF, LF LF, or CR CR) ends the headers.
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  if (!match) return { headerBlock: text, body: "" };
  const index = match.index;
  return { headerBlock: text.slice(0, index), body: text.slice(index + match[0].length) };
}

/**
 * Parses the header block into a lowercase-keyed map. Continuation lines (a
 * leading space or tab) are unfolded onto the previous header, which is how
 * long headers are legally wrapped.
 */
export function parseHeaders(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = headerBlock.split(/\r\n|\n|\r/);
  let currentKey: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      currentKey = null;
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Keep the first occurrence; repeated headers (e.g. Received) are not
    // useful for identification and would otherwise be silently overwritten.
    if (!(key in headers)) headers[key] = value;
    currentKey = key;
  }
  return headers;
}

const CHARSET_ALIASES: Record<string, string> = {
  "utf-8": "utf-8",
  utf8: "utf-8",
  "us-ascii": "utf-8",
  ascii: "utf-8",
  "iso-8859-1": "iso-8859-1",
  latin1: "iso-8859-1",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252",
};

/** Decodes bytes with the charset the part declared, falling back to UTF-8. */
function decodeWithCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = charset ? CHARSET_ALIASES[charset.trim().toLowerCase()] : undefined;
  if (!label) {
    // Unknown or absent charset: UTF-8 is the safe default, and a decode
    // failure is replaced rather than thrown, so one odd byte cannot lose the
    // whole message.
    return new TextDecoder("utf-8").decode(bytes);
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Decodes a header value that may contain RFC 2047 encoded words, e.g.
 * `=?utf-8?B?4piD?=`. Encoded words are decoded; everything else is left as
 * written. This is what makes a non-ASCII subject or sender name readable.
 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, payload: string) => {
      try {
        let bytes: Uint8Array;
        if (encoding.toUpperCase() === "B") {
          bytes = Uint8Array.from(Buffer.from(payload, "base64"));
        } else {
          // Q-encoding: `_` is a space and `=XX` is a raw byte. Build the byte
          // array directly, because encoding the decoded string back to UTF-8
          // would double the bytes of a multi-byte escape like =E2=9C=94.
          bytes = qDecodeBytes(payload);
        }
        return decodeWithCharset(bytes, charset);
      } catch {
        return whole;
      }
    },
  );
}

/** Decodes a Q-encoded payload into raw bytes (RFC 2047 section 4.2). */
function qDecodeBytes(payload: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i += 1) {
    const char = payload[i]!;
    if (char === "_") {
      out.push(0x20);
      continue;
    }
    if (char === "=" && i + 2 < payload.length) {
      const hex = payload.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // A literal character outside the ASCII range is encoded as its UTF-8
    // bytes so it survives the byte-level decode that follows.
    out.push(...new TextEncoder().encode(char));
  }
  return Uint8Array.from(out);
}

/** Decodes a quoted-printable body: soft line breaks vanish, =XX becomes a byte. */
function decodeQuotedPrintable(input: string): Uint8Array {
  const withoutSoftBreaks = input.replace(/=\r\n|=\n|=\r/g, "");
  const out: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i += 1) {
    const char = withoutSoftBreaks[i]!;
    if (char === "=" && i + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(char.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

/** Parses a `Content-Type` header into its media type and parameters. */
function parseContentType(value: string | undefined): {
  type: string;
  params: Record<string, string>;
} {
  if (!value) return { type: "text/plain", params: {} };
  const parts = value.split(";");
  const type = (parts.shift() ?? "").trim().toLowerCase() || "text/plain";
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { type, params };
}

/** Splits a multipart body on its boundary into raw parts, preserving order. */
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments: string[] = [];
  let cursor = 0;
  while (true) {
    const start = body.indexOf(delimiter, cursor);
    if (start === -1) break;
    const afterDelimiter = start + delimiter.length;
    // `--boundary--` closes the multipart section.
    if (body.startsWith("--", afterDelimiter)) break;
    const lineEnd = body.indexOf("\n", afterDelimiter);
    if (lineEnd === -1) break;
    const next = body.indexOf(delimiter, lineEnd);
    const end = next === -1 ? body.length : next;
    segments.push(body.slice(lineEnd + 1, end));
    cursor = end;
  }
  return segments;
}

interface BodyPart {
  type: string;
  text: string;
  charset: string | undefined;
  filename: string | null;
}

/**
 * Walks the MIME tree, collecting text bodies and attachment names. Depth is
 * bounded so a maliciously nested message cannot exhaust the stack.
 */
function walkParts(
  headerBlock: string,
  rawBody: string,
  depth: number,
  texts: BodyPart[],
  attachments: Array<{ filename: string; contentType: string }>,
): boolean {
  if (depth > MAX_MIME_DEPTH) return false;
  const headers = parseHeaders(headerBlock);
  const contentType = parseContentType(headers["content-type"]);
  const encoding = (headers["content-transfer-encoding"] ?? "").trim().toLowerCase();

  if (contentType.type.startsWith("multipart/") && contentType.params.boundary) {
    const segments = splitMultipart(rawBody, contentType.params.boundary);
    let sawMultipart = segments.length > 0;
    for (const segment of segments) {
      const { headerBlock: childHeaders, body: childBody } = splitHeadersAndBody(segment);
      const nested = walkParts(childHeaders, childBody, depth + 1, texts, attachments);
      sawMultipart = sawMultipart || nested;
    }
    return sawMultipart;
  }

  // Decode the transfer encoding to bytes, then to text with the part charset.
  let bytes: Uint8Array;
  if (encoding === "base64") {
    bytes = Uint8Array.from(Buffer.from(rawBody.replace(/\s+/g, ""), "base64"));
  } else if (encoding === "quoted-printable") {
    bytes = decodeQuotedPrintable(rawBody);
  } else {
    bytes = new TextEncoder().encode(rawBody);
  }

  const filename =
    contentType.params.name ??
    (headers["content-disposition"] ? dispositionFilename(headers["content-disposition"]) : null);

  if (filename) {
    attachments.push({ filename, contentType: contentType.type });
    return true;
  }

  if (contentType.type === "text/plain" || contentType.type === "text/html") {
    texts.push({
      type: contentType.type,
      text: decodeWithCharset(bytes, contentType.params.charset),
      charset: contentType.params.charset,
      filename: null,
    });
  } else if (contentType.type.startsWith("image/") || contentType.type === "application/pdf") {
    // An inline non-text part is still a document; name it so it is visible.
    attachments.push({ filename: filename ?? `inline ${contentType.type}`, contentType: contentType.type });
  }
  return true;
}

function dispositionFilename(value: string): string | null {
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(value);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!.trim().replace(/"$/, ""));
  } catch {
    return match[1]!.trim().replace(/"$/, "");
  }
}

/**
 * Reduces HTML to readable text. This is a lossy, layout-free reduction, and
 * the caller records that the text came from HTML so a reviewer is not misled
 * into thinking the email was plain text.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parses a raw .eml message into headers, a chosen body, and an attachment list. */
export function parseEmail(raw: string): ParsedEmail {
  const { headerBlock, body } = splitHeadersAndBody(raw);
  const rawHeaders = parseHeaders(headerBlock);
  // Decode RFC 2047 encoded words once, here, so every caller sees the
  // human-readable value and no caller has to remember to decode.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[key] = decodeEncodedWords(value);
  }
  const texts: BodyPart[] = [];
  const attachments: Array<{ filename: string; contentType: string }> = [];
  const multipart = walkParts(headerBlock, body, 0, texts, attachments);

  const plain = texts.filter((part) => part.type === "text/plain");
  const html = texts.filter((part) => part.type === "text/html");
  let bodyText = "";
  let bodySource: ParsedEmail["bodySource"] = "none";
  if (plain.length > 0) {
    bodyText = plain.map((part) => part.text).join("\n\n").trim();
    bodySource = "text/plain";
  } else if (html.length > 0) {
    bodyText = htmlToText(html.map((part) => part.text).join("\n\n"));
    bodySource = "text/html";
  } else if (!multipart) {
    // A message with no MIME structure at all: treat the remainder as plain text.
    bodyText = body.trim();
    bodySource = bodyText ? "text/plain" : "none";
  }

  return { headers, bodyText, bodySource, attachments, multipart };
}

/** The header block, rendered as readable text so it becomes citable evidence. */
function renderHeaderPassage(email: ParsedEmail): string {
  const fields: Array<[string, string]> = [
    ["From", "from"],
    ["To", "to"],
    ["Cc", "cc"],
    ["Date", "date"],
    ["Subject", "subject"],
  ];
  const lines: string[] = [];
  for (const [label, key] of fields) {
    const value = email.headers[key];
    if (value) lines.push(`${label}: ${value}`);
  }
  if (email.attachments.length > 0) {
    const names = email.attachments.map((att) => att.filename).join(", ");
    lines.push(`Attachments (not extracted; upload separately): ${names}`);
  }
  return lines.join("\n");
}

/**
 * Extracts an .eml message into passages: one for the headers and one per body
 * chunk. Header text is a passage in its own right because the sender, date,
 * and subject are themselves evidence.
 */
export function extractEmail(data: Uint8Array): ExtractionResult {
  if (data.length === 0) return unsupported("The email file is empty.");
  const sample = data.subarray(0, Math.min(data.length, MAX_HEADER_BYTES));
  if (sample.includes(0)) {
    return unsupported("The file contains NUL bytes, so it is not an email message.");
  }

  const raw = new TextDecoder("utf-8").decode(data);
  // A message must start with a header field to be an email; otherwise this is
  // some other text file that happened to be named .eml.
  if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(raw.trimStart())) {
    return unsupported("The file does not begin with email headers, so it is not an .eml message.");
  }

  const email = parseEmail(raw);
  const passages: ExtractedPassage[] = [];

  const headerText = renderHeaderPassage(email);
  if (headerText.trim()) {
    passages.push({
      locatorType: "document",
      locatorValue: 1,
      ref: "email headers",
      text: headerText,
    });
  }

  if (email.bodyText) {
    const sourceNote =
      email.bodySource === "text/html" ? "(body reduced from HTML)\n" : "";
    const chunks: string[] = [];
    const paragraphs = email.bodyText.split(/\n{2,}/);
    let buffer = "";
    const flush = () => {
      if (buffer.trim()) chunks.push(buffer.trim());
      buffer = "";
    };
    for (const paragraph of paragraphs) {
      if ((buffer + "\n\n" + paragraph).length > MAX_BODY_CHARS) flush();
      if (paragraph.length > MAX_BODY_CHARS) {
        flush();
        for (let i = 0; i < paragraph.length; i += MAX_BODY_CHARS) {
          chunks.push(paragraph.slice(i, i + MAX_BODY_CHARS).trim());
        }
        continue;
      }
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
    flush();

    chunks.forEach((chunk, index) => {
      passages.push({
        locatorType: "chunk",
        locatorValue: index + 1,
        ref: `body part ${index + 1}`,
        text: index === 0 && sourceNote ? `${sourceNote}${chunk}` : chunk,
      });
    });
  }

  if (passages.length === 0) {
    return unsupported("The email message had no readable headers or body text.");
  }
  return ok(passages, 1);
}
