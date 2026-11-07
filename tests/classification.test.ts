import { describe, expect, it } from "vitest";

import { classifyDocument } from "../server/casefile/classification.js";

/**
 * Classification tests.
 *
 * Each case states what the document contains and what a reviewer should see.
 * The important assertions are the negative ones: a document that fits no
 * category is `unknown`, and a single weak signal is not `high`.
 */

function classify(text: string, filename = "document.pdf", mimeType = "application/pdf") {
  return classifyDocument({ filename, mimeType, text });
}

describe("document classification", () => {
  it("recognises a court judgment and its findings", () => {
    const result = classify(
      `IN THE HIGH COURT OF JUSTICE\nCase No. 2024-1234\n\nJUDGMENT\n\nThe court finds that the defendant breached the agreement. It is adjudged that the claimant succeeds.`,
      "judgment-2024.pdf",
    );
    expect(result.documentType).toBe("court-judgment");
    expect(result.confidence).toBe("high");
  });

  it("recognises an affidavit", () => {
    const result = classify(
      "I make oath and say as follows. I am the deponent in these proceedings and the facts stated herein are true.",
      "affidavit.pdf",
    );
    expect(result.documentType).toBe("affidavit");
  });

  it("recognises a witness statement", () => {
    const result = classify(
      "WITNESS STATEMENT of Jane Doe\n\nI saw the vehicle leave the scene. My evidence is that the light was red.",
      "witness-statement-jane.pdf",
    );
    expect(result.documentType).toBe("witness-statement");
  });

  it("recognises a bank statement from CSV structure", () => {
    const result = classify(
      "date,description,amount,balance\n2024-03-15,Northwind,249.99,1000.00\n",
      "statement.csv",
      "text/csv",
    );
    expect(result.documentType).toBe("bank-statement");
  });

  it("recognises an invoice", () => {
    const result = classify(
      "INVOICE INV-2024-0007\nBill to: Acme Ltd\nAmount due: 1,200.00 USD\nPayment terms: 30 days\nDue date: 2024-03-31",
      "invoice-0007.pdf",
    );
    expect(result.documentType).toBe("invoice");
  });

  it("recognises a contract", () => {
    const result = classify(
      "SERVICE AGREEMENT\nThis agreement is between Acme Ltd and Northwind Traders. The parties hereby agrees to the following terms and conditions. This deed shall be governed by the law of England.",
      "service-agreement.pdf",
    );
    expect(result.documentType).toBe("contract");
  });

  it("recognises an email from its headers", () => {
    const result = classify(
      "From: j.rivera@example.com\nTo: disputes@northwind.example\nSubject: Unauthorised charge\nDate: 2024-03-18\n\nPlease reverse the charge.",
      "dispute.eml",
      "text/plain",
    );
    expect(result.documentType).toBe("email");
  });

  it("recognises an email structurally from its MIME type, whatever the body says", () => {
    // The body names no email vocabulary at all; only the MIME type marks it.
    const result = classify(
      "Subject: Order ORD-55231\n\nYour parcel left the depot this morning.",
      "message.eml",
      "message/rfc822",
    );
    expect(result.documentType).toBe("email");
  });

  it("recognises a medical report", () => {
    const result = classify(
      "MEDICAL REPORT\nPatient: A. Smith\nThe examination findings are consistent with a soft tissue injury. Diagnosis: sprain. Treatment plan: physiotherapy.",
      "medical-report.pdf",
    );
    expect(result.documentType).toBe("medical-report");
  });

  it("recognises a research paper", () => {
    const result = classify(
      "Abstract\nWe present a study of X. Methodology: we sampled 100 cases. Results show a significant effect. Discussion follows. References: Smith et al. (2020). doi:10.1000/xyz",
      "study.pdf",
    );
    expect(result.documentType).toBe("research-paper");
  });

  it("returns unknown rather than guessing for a document with no signals", () => {
    const result = classify("hello world", "file.pdf");
    expect(result.documentType).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("does not report high confidence on a single weak signal", () => {
    const result = classify("Dear Sir, kind regards.", "letter.pdf");
    expect(result.documentType).toBe("correspondence");
    expect(result.confidence).not.toBe("high");
  });

  it("prefers the more specific type when a judgment also mentions pleadings", () => {
    const result = classify(
      "JUDGMENT\nIn the High Court. The claimant's statement of claim alleged breach. The court finds the claim succeeds and it is hereby ordered that the defendant pay costs.",
      "judgment.pdf",
    );
    expect(result.documentType).toBe("court-judgment");
  });
});
