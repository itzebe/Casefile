import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { detectAmounts, detectDates, detectReferences, hasConflictingDates, referenceKeys } from "../server/casefile/entities.js";
import {
  extractCsvFile,
  extractEvidence,
  extractImageFile,
  extractPdfFile,
  extractTextFile,
} from "../server/casefile/extraction.js";
import { detectMimeType, validateEvidenceFile } from "../server/casefile/file-validation.js";
import {
  RECEIPT_TEXT,
  STATEMENT_CSV,
  CONTRACT_TEXT,
  MARKDOWN_TEXT,
  docxBytes,
  pdfBytes,
  textBytes,
  csvBytes,
  xlsxBytes,
  zipBytes,
} from "./fixtures/evidence.js";

describe("detectDates", () => {
  it("parses an unambiguous ISO date", () => {
    const dates = detectDates("Receipt date: 2024-03-15");
    expect(dates).toHaveLength(1);
    expect(dates[0]).toMatchObject({ iso: "2024-03-15", precision: "day", text: "2024-03-15" });
  });
  it("parses a written month name", () => {
    const dates = detectDates("Signed at London on 15 March 2024.");
    expect(dates[0]).toMatchObject({ iso: "2024-03-15", precision: "day" });
  });
  it("does not resolve an ambiguous numeric date", () => {
    const dates = detectDates("Date: 03/04/2024");
    expect(dates[0].iso).toBeNull();
    expect(dates[0].precision).toBe("unknown");
    expect(dates[0].text).toBe("03/04/2024");
  });
  it("keeps month-only precision", () => {
    const dates = detectDates("Statement for March 2024");
    expect(dates[0]).toMatchObject({ iso: "2024-03", precision: "month" });
  });
});

describe("detectAmounts", () => {
  it("converts a symbol amount to minor units", () => {
    const amounts = detectAmounts("Amount: $249.99 USD");
    expect(amounts.some((a) => a.minor === 24999)).toBe(true);
  });
  it("handles thousands separators", () => {
    const amounts = detectAmounts("Total 1,234.56 EUR");
    expect(amounts[0]).toMatchObject({ minor: 123456, currency: "EUR" });
  });
  it("reads a negative refund", () => {
    const amounts = detectAmounts("-249.99 USD");
    expect(amounts[0]?.minor).toBe(24999);
  });
});

describe("detectReferences", () => {
  it("finds a transaction id", () => {
    const refs = detectReferences("Transaction ID: TXN-88421907");
    expect(refs.some((r) => r.kind === "transaction" && r.text.includes("TXN-88421907"))).toBe(true);
  });
  it("finds a hex hash", () => {
    const refs = detectReferences("tx 0xabcdef0123456789abcdef0123456789");
    expect(refs.some((r) => r.kind === "hash")).toBe(true);
  });
  it("keys an identifier by the value, not the label word", () => {
    // "Contract No. SA-2024-0042" is identified by SA-2024-0042. The word
    // "contract" alone must never be a shared key, or every contract in a case
    // would be linked to every other one.
    const refs = detectReferences("Contract No. SA-2024-0042");
    const keys = refs.flatMap((r) => referenceKeys(r));
    expect(keys).toContain("sa20240042");
    expect(keys).not.toContain("contract");
  });
  it("does not treat a bare label word as an identifier", () => {
    const keys = detectReferences("This Agreement is governed by the law.").flatMap((r) =>
      referenceKeys(r),
    );
    expect(keys).not.toContain("agreement");
  });

  it("finds the identifier even when a preceding label word would swallow it", () => {
    // "SERVICE AGREEMENT\nContract No. SA-2024-0042": the pattern for the label
    // "agreement" can match across the newline and capture the next word
    // ("Contract") as its value, so the real identifier was never detected and
    // a contract and its invoice were never linked.
    const text = "SERVICE AGREEMENT\nContract No. SA-2024-0042\nBetween the parties.";
    const keys = detectReferences(text).flatMap((r) => referenceKeys(r));
    expect(keys).toContain("sa20240042");
  });

  it("reads the same contract number from a reference line", () => {
    const contract = detectReferences("Contract No. SA-2024-0042").flatMap((r) =>
      referenceKeys(r),
    );
    const invoice = detectReferences("Reference: Contract No. SA-2024-0042").flatMap((r) =>
      referenceKeys(r),
    );
    expect(contract).toContain("sa20240042");
    expect(invoice).toContain("sa20240042");
  });
});

describe("hasConflictingDates", () => {
  it("flags two different days", () => {
    expect(hasConflictingDates(detectDates("paid 2024-03-15, refunded 2024-03-20"))).toBe(true);
  });
  it("does not flag a repeated date", () => {
    expect(hasConflictingDates(detectDates("2024-03-15 ... 2024-03-15"))).toBe(false);
  });
});

describe("extractTextFile", () => {
  it("returns one passage for short text", () => {
    const result = extractTextFile(textBytes(RECEIPT_TEXT));
    expect(result.status).toBe("complete");
    expect(result.passages[0].text).toContain("Northwind Traders");
  });
  it("rejects invalid UTF-8 instead of producing mojibake", () => {
    const result = extractTextFile(new Uint8Array([0x41, 0xff, 0xfe, 0x80, 0x81]));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/UTF-8/i);
  });
  it("rejects a file with NUL bytes", () => {
    const result = extractTextFile(new Uint8Array([0x41, 0x00, 0x42]));
    expect(result.status).toBe("failed");
  });
});

describe("extractCsvFile", () => {
  it("preserves the source row number for every row", async () => {
    const result = await extractCsvFile(csvBytes(STATEMENT_CSV));
    expect(result.status).toBe("complete");
    const row2 = result.passages.find((p) => p.locatorValue === 2);
    expect(row2?.ref).toBe("row 2");
    expect(row2?.text).toContain("Northwind Traders");
  });
  it("labels cells with their header", async () => {
    const result = await extractCsvFile(csvBytes(STATEMENT_CSV));
    expect(result.passages[1].text).toContain("amount: 249.99");
  });
  it("does not throw on malformed quoting", async () => {
    const result = await extractCsvFile(csvBytes('a,b\n"unterminated,2\n'));
    expect(["complete", "failed"]).toContain(result.status);
  });
});

describe("extractPdfFile", () => {
  it("extracts text per page with page references", async () => {
    const result = await extractPdfFile(pdfBytes(["PAYMENT RECEIPT\nAmount: $249.99", "Page two content"]));
    expect(result.status).toBe("complete");
    expect(result.pageCount).toBe(2);
    expect(result.passages[0]).toMatchObject({ locatorType: "page", locatorValue: 1, ref: "page 1" });
    expect(result.passages[0].text).toContain("PAYMENT RECEIPT");
    expect(result.passages[1].text).toContain("Page two content");
  });
  it("reports a page with no text layer as unsupported, not empty", async () => {
    const result = await extractPdfFile(pdfBytes([""]));
    expect(result.status).toBe("unsupported");
    expect(result.limitation).toMatch(/no embedded text layer/i);
  });
  it("reports a corrupt PDF as failed", async () => {
    const result = await extractPdfFile(textBytes("this is not a pdf at all"));
    expect(result.status).toBe("failed");
  });
});

describe("extractImageFile (OCR)", () => {
  // Gate on the module's own probe rather than reading the environment, so the
  // test skips only when the engine genuinely is not configured.
  let hasEngine = false;
  beforeAll(async () => {
    const { ocrBinaryPath } = await import("../server/casefile/ocr.js");
    hasEngine = ocrBinaryPath() !== null;
  });

  it("discovers a tesseract binary on PATH without an explicit override", async () => {
    // Regression: OCR used to require CASEFILE_TESSERACT_PATH to be set by hand,
    // so a machine with tesseract installed still reported every image as
    // unreadable. Discovery must find a binary on PATH on its own. The test
    // skips only when no engine is installed at all.
    const { discoverTesseractOnPath, ocrBinaryPath } = await import(
      "../server/casefile/ocr.js"
    );
    const { execFileSync } = await import("node:child_process");
    let onPath: string | null = null;
    try {
      onPath = execFileSync("which", ["tesseract"], { encoding: "utf8" }).trim() || null;
    } catch {
      onPath = null;
    }
    if (!onPath) {
      // No engine on this machine; discovery must still answer cleanly.
      expect(discoverTesseractOnPath()).toBeNull();
      expect(ocrBinaryPath()).toBeNull();
      return;
    }
    // A binary exists on PATH, so discovery must find it on its own - the
    // regression this pins was requiring an env var to be set by hand.
    expect(discoverTesseractOnPath()).toBe(onPath);
    expect(ocrBinaryPath()).toBe(onPath);
  });

  it(
    "reads text from a real image with the configured OCR engine",
    async () => {
      // Skipped rather than faked when no engine is configured: a test that
      // stubbed OCR would not prove the real path works.
      if (!hasEngine) return;
      const bytes = new Uint8Array(
        readFileSync(fileURLToPath(new URL("./fixtures/ocr-receipt.png", import.meta.url))),
      );
      const result = await extractImageFile(bytes, "image/png");
      expect(result.status).toBe("complete");
      const text = result.passages.map((passage) => passage.text).join("\n");
      expect(text).toContain("PAYMENT RECEIPT");
      expect(text).toContain("Northwind Traders");
      expect(text).toContain("TXN-88421907");
      expect(text).toContain("249.99");
      expect(result.passages[0].ref).toBe("image text 1");
    },
    // Spawning tesseract on a real image takes several seconds; the default 5s
    // budget is for pure functions, not for an external process.
    30_000,
  );

  it("reports an image with no readable text as unsupported, never empty", async () => {
    if (!hasEngine) return;
    // A blank PNG: OCR succeeds but finds nothing, so the file must be reported
    // as unreadable rather than as an empty document.
    const { pngBytes } = await import("./fixtures/evidence.js");
    const result = await extractImageFile(pngBytes(), "image/png");
    expect(result.status).toBe("unsupported");
    expect(result.limitation).toMatch(/no readable text/i);
  }, 30_000);
});

describe("DOCX extraction", () => {
  it("returns one passage per paragraph, located by paragraph number", async () => {
    const bytes = docxBytes(["SERVICE AGREEMENT", "", "The customer shall pay 1,200.00 USD per month."]);
    const result = await extractEvidence({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "agreement.docx",
      data: bytes,
    });
    expect(result.status).toBe("complete");
    // The empty paragraph is dropped rather than emitted as a blank passage.
    expect(result.passages).toHaveLength(2);
    expect(result.passages[0]).toMatchObject({ ref: "paragraph 1", text: "SERVICE AGREEMENT" });
    expect(result.passages[1]!.text).toContain("1,200.00 USD");
  });

  it("decodes XML entities rather than leaking them into the text", async () => {
    const bytes = docxBytes(["Smith & Co. <Terms> \"quoted\""]);
    const result = await extractEvidence({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "entities.docx",
      data: bytes,
    });
    expect(result.passages[0]!.text).toBe('Smith & Co. <Terms> "quoted"');
  });

  it("reports a corrupt container as failed, not as an empty document", async () => {
    const result = await extractEvidence({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "broken.docx",
      data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(result.passages).toHaveLength(0);
  });
});

describe("XLSX extraction", () => {
  it("returns one passage per row, located by sheet and row number", async () => {
    const bytes = xlsxBytes("Statement", [
      ["date", "description", "amount"],
      ["2024-03-15", "Northwind Traders", "249.99"],
    ]);
    const result = await extractEvidence({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "statement.xlsx",
      data: bytes,
    });
    expect(result.status).toBe("complete");
    expect(result.passages[0]!.ref).toBe("Statement row 1");
    expect(result.passages[1]!.ref).toBe("Statement row 2");
    expect(result.passages[1]!.text).toContain("249.99");
    // Cells are labelled by column letter so a row reads unambiguously.
    expect(result.passages[1]!.text).toContain("C: 249.99");
  });

  it("reports a workbook with no sheets as failed", async () => {
    const bytes = zipBytes([
      { name: "[Content_Types].xml", content: "<Types/>" },
      { name: "xl/workbook.xml", content: "<workbook/>" },
    ]);
    const result = await extractEvidence({
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "empty.xlsx",
      data: bytes,
    });
    expect(result.status).toBe("failed");
  });
});

describe("Markdown extraction", () => {
  it("splits on headings so a citation names the section", async () => {
    const result = await extractEvidence({
      mimeType: "text/markdown",
      filename: "notes.md",
      data: textBytes(MARKDOWN_TEXT),
    });
    expect(result.status).toBe("complete");
    expect(result.passages.length).toBeGreaterThanOrEqual(2);
    expect(result.passages[0]!.ref).toMatch(/section 1/);
  });
});

describe("format detection", () => {
  it("detects a DOCX from its container parts, not its extension", () => {
    const bytes = docxBytes(["hello"]);
    expect(detectMimeType(bytes)).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("detects an XLSX from its container parts", () => {
    const bytes = xlsxBytes("Sheet1", [["a"]]);
    expect(detectMimeType(bytes)).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("rejects a plain ZIP that is not an OOXML document", () => {
    const bytes = zipBytes([{ name: "readme.txt", content: "not a document" }]);
    const result = validateEvidenceFile({ filename: "archive.zip", data: bytes });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported_type");
  });

  it("rejects a binary renamed to .docx", () => {
    const header = new Uint8Array(64);
    header.set([0x4d, 0x5a, 0x90, 0x00], 0); // MZ
    const result = validateEvidenceFile({ filename: "invoice.docx", data: header });
    expect(result.ok).toBe(false);
  });

  it("classifies .md as markdown and .txt as plain text", () => {
    const md = validateEvidenceFile({ filename: "notes.md", data: textBytes("# Title\n\nbody") });
    expect(md.ok && md.mimeType).toBe("text/markdown");
    const txt = validateEvidenceFile({ filename: "notes.txt", data: textBytes("body only") });
    expect(txt.ok && txt.mimeType).toBe("text/plain");
  });

  it("does not mistake prose with commas and newlines for a CSV", () => {
    // A judgment that states "5,000.00 USD" and spans several lines was
    // previously detected as CSV, which split the amount into two columns.
    const prose = textBytes(
      "JUDGMENT\nIt is hereby ordered that the defendant pay damages of 5,000.00 USD and costs.\nThe court finds that the agreement was breached.\n",
    );
    const result = validateEvidenceFile({ filename: "judgment", data: prose });
    expect(result.ok && result.mimeType).toBe("text/plain");
  });

  it("still detects a real delimited file with no extension", () => {
    const csv = textBytes("date,description,amount\n2024-01-01,Widget,10.00\n2024-01-02,Gadget,20.00\n");
    const result = validateEvidenceFile({ filename: "statement", data: csv });
    expect(result.ok && result.mimeType).toBe("text/csv");
  });
});

describe("ZIP safety", () => {
  it("refuses a compression bomb instead of inflating it", async () => {
    // 5 MB of zeros compresses to a few KB; the ratio guard must reject it.
    const bomb = "0".repeat(5 * 1024 * 1024);
    const bytes = zipBytes([{ name: "word/document.xml", content: bomb }]);
    const result = await extractEvidence({
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "bomb.docx",
      data: bytes,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/ratio|budget|limit/i);
  });

  it("rejects a non-ZIP payload that claims to be a ZIP", () => {
    const fake = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeType(fake)).toBeNull();
  });
});
