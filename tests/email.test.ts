import { describe, expect, it } from "vitest";

import { extractEmail, htmlToText, parseEmail, parseHeaders } from "../server/casefile/email.js";
import { extractEvidence } from "../server/casefile/extraction.js";
import { detectMimeType, validateEvidenceFile } from "../server/casefile/file-validation.js";
import {
  DISPUTE_EMAIL_TEXT,
  ENCODED_SUBJECT_EMAIL_TEXT,
  HTML_EMAIL_TEXT,
  MULTIPART_EMAIL_TEXT,
  emlBytes,
} from "./fixtures/evidence.js";

/**
 * Email ingestion tests.
 *
 * The load-bearing assertions are that an email is recognised by its own header
 * structure (not its extension), that the headers become citable evidence, that
 * a quoted-printable or encoded-word value is decoded correctly, and that an
 * attachment is named rather than silently dropped.
 */

describe("email header parsing", () => {
  it("parses headers into lowercase keys", () => {
    const headers = parseHeaders("From: a@b.c\r\nTo: d@e.f\r\nSubject: Hi");
    expect(headers.from).toBe("a@b.c");
    expect(headers.to).toBe("d@e.f");
    expect(headers.subject).toBe("Hi");
  });

  it("unfolds a continuation line onto its header", () => {
    const headers = parseHeaders("Subject: a long\r\n subject line");
    expect(headers.subject).toBe("a long subject line");
  });
});

describe("email body selection", () => {
  it("prefers a text/plain body and reports its source", () => {
    const email = parseEmail(MULTIPART_EMAIL_TEXT);
    expect(email.bodySource).toBe("text/plain");
    expect(email.bodyText).toContain("INV-4471");
  });

  it("decodes quoted-printable bytes", () => {
    const email = parseEmail(MULTIPART_EMAIL_TEXT);
    // =C2=A3 is the UTF-8 encoding of the pound sign.
    expect(email.bodyText).toContain("£500.00");
  });

  it("names an attachment instead of dropping it", () => {
    const email = parseEmail(MULTIPART_EMAIL_TEXT);
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ filename: "INV-4471.pdf", contentType: "application/pdf" });
  });

  it("reduces an HTML-only body to text", () => {
    const email = parseEmail(HTML_EMAIL_TEXT);
    expect(email.bodySource).toBe("text/html");
    expect(email.bodyText).toContain("ORD-55231");
    expect(email.bodyText).not.toContain("<b>");
  });

  it("decodes RFC 2047 encoded words in headers", () => {
    const email = parseEmail(ENCODED_SUBJECT_EMAIL_TEXT);
    // =E2=9C=94 is U+2714 HEAVY CHECK MARK, encoded as three raw UTF-8 bytes.
    expect(email.headers.subject).toBe("Firma del contrato ✔");
    expect(email.headers.from).toContain("José García");
  });
});

describe("htmlToText", () => {
  it("removes tags and script/style content", () => {
    expect(htmlToText("<p>Hi</p><script>bad()</script><style>x{}</style>")).toBe("Hi");
  });
  it("turns a block boundary into a line break", () => {
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });
});

describe("email MIME detection and extraction", () => {
  it("detects an email from its headers even without a .eml extension", () => {
    expect(detectMimeType(emlBytes(DISPUTE_EMAIL_TEXT))).toBeNull();
    const result = validateEvidenceFile({ filename: "message.txt", data: emlBytes(DISPUTE_EMAIL_TEXT) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).toBe("message/rfc822");
  });

  it("does not accept an ordinary text file named .eml as a message", () => {
    const notEmail = emlBytes("Dear team\n\nThis is just prose rather than an email message.\n");
    const result = validateEvidenceFile({ filename: "letter.eml", data: notEmail });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).not.toBe("message/rfc822");
  });

  it("emits a header passage and body passages with real locators", async () => {
    const result = await extractEvidence({
      mimeType: "message/rfc822",
      filename: "dispute.eml",
      data: emlBytes(DISPUTE_EMAIL_TEXT),
    });
    expect(result.status).toBe("complete");
    const headerPassage = result.passages.find((p) => p.ref === "email headers");
    expect(headerPassage).toBeDefined();
    expect(headerPassage!.text).toContain("From: j.rivera@example.com");
    expect(headerPassage!.text).toContain("Subject: Unauthorised charge TXN-88421907");
    const body = result.passages.find((p) => p.ref.startsWith("body part"));
    expect(body).toBeDefined();
    expect(body!.text).toContain("TXN-88421907");
  });

  it("states in the passage that an HTML body was reduced", async () => {
    const result = await extractEvidence({
      mimeType: "message/rfc822",
      filename: "shipped.eml",
      data: emlBytes(HTML_EMAIL_TEXT),
    });
    const body = result.passages.find((p) => p.ref.startsWith("body part"));
    expect(body!.text).toContain("reduced from HTML");
  });

  it("lists attachment names in the header passage so the omission is visible", async () => {
    const result = await extractEvidence({
      mimeType: "message/rfc822",
      filename: "invoice.eml",
      data: emlBytes(MULTIPART_EMAIL_TEXT),
    });
    const headerPassage = result.passages.find((p) => p.ref === "email headers")!;
    expect(headerPassage.text).toContain("INV-4471.pdf");
    expect(headerPassage.text).toContain("not extracted");
  });

  it("reports an unsupported message rather than returning empty text", () => {
    const result = extractEmail(emlBytes("just some words with no headers"));
    expect(result.status).toBe("unsupported");
    expect(result.limitation).toBeTruthy();
  });

  it("rejects a NUL-byte file as not an email", () => {
    const result = extractEmail(Uint8Array.from([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x00]));
    expect(result.status).toBe("unsupported");
  });
});
