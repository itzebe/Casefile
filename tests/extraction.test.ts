import { describe, expect, it } from "vitest";

import { detectAmounts, detectDates, detectReferences, hasConflictingDates } from "../server/casefile/entities.js";
import { extractCsvFile, extractPdfFile, extractTextFile } from "../server/casefile/extraction.js";
import { RECEIPT_TEXT, STATEMENT_CSV, CONTRACT_TEXT, pdfBytes, textBytes, csvBytes } from "./fixtures/evidence.js";

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
