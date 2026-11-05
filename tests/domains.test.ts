import { describe, expect, it } from "vitest";

import {
  analyzeDomainPassages,
  isJudicialConclusion,
  splitSentences,
  summariseDomains,
} from "../server/casefile/domains.js";

/**
 * Domain intelligence tests.
 *
 * The load-bearing assertions are the distinctions: a judgment reciting an
 * argument is not the court's conclusion; an invoice is not a payment; a
 * hedged medical line is not a diagnosis.
 */

function analyse(text: string, documentType = "general-document") {
  return analyzeDomainPassages([
    { evidenceId: "ev_1", filename: "doc.pdf", passageId: "psg_1", ref: "page 1", text, documentType },
  ]);
}

describe("sentence splitting", () => {
  it("splits on sentence boundaries", () => {
    expect(splitSentences("The court finds X. The claimant alleges Y.")).toHaveLength(2);
  });
  it("does not split inside an abbreviation", () => {
    expect(splitSentences("Acme Ltd. paid the invoice.")).toHaveLength(1);
  });
  it("does not split a decimal number", () => {
    expect(splitSentences("The amount was 249.99 USD.")).toHaveLength(1);
  });
});

describe("legal intelligence", () => {
  it("labels the court's own finding as a judicial finding", () => {
    const findings = analyse("The court finds that the defendant breached the agreement.");
    expect(findings[0]).toMatchObject({ domain: "legal", role: "judicial-finding" });
    expect(isJudicialConclusion(findings[0]!.role)).toBe(true);
  });

  it("labels an operative order as a court order, above a finding", () => {
    const findings = analyse("It is hereby ordered that the defendant pay costs of 5,000.00 USD.");
    expect(findings[0]).toMatchObject({ domain: "legal", role: "court-order" });
  });

  it("does NOT read a recital of counsel's argument as the court's conclusion", () => {
    const findings = analyse(
      "Counsel for the claimant submitted that the contract had been repudiated.",
    );
    expect(findings[0]).toMatchObject({ domain: "legal", role: "counsel-argument" });
    expect(isJudicialConclusion(findings[0]!.role)).toBe(false);
    expect(findings[0]!.attributedTo).toBe("claimant");
  });

  it("distinguishes a party allegation from a witness assertion", () => {
    const allegation = analyse("The claimant alleges that the goods were never delivered.");
    expect(allegation[0]).toMatchObject({ role: "party-allegation", attributedTo: "claimant" });

    const witness = analyse("I saw the vehicle leave the scene at 14:00.");
    expect(witness[0]?.role).toBe("witness-assertion");
  });

  it("keeps a judgment that both recites an argument and finds for itself correctly ordered", () => {
    const findings = analyse(
      "Counsel for the defendant argued that the claim was time-barred. The court finds that the claim was brought in time.",
    );
    const roles = findings.map((finding) => finding.role);
    expect(roles).toContain("counsel-argument");
    expect(roles).toContain("judicial-finding");
  });
});

describe("financial intelligence", () => {
  it("distinguishes an invoiced amount from a received one", () => {
    const invoiced = analyse("We invoiced the customer 1,200.00 USD on 2024-03-01.");
    expect(invoiced[0]).toMatchObject({ domain: "financial", role: "amount-invoiced" });

    const received = analyse("We received 1,200.00 USD from the customer.");
    expect(received[0]).toMatchObject({ role: "amount-received" });
  });

  it("labels a refund", () => {
    const findings = analyse("A refund of 249.99 USD was issued on 2024-03-20.");
    expect(findings[0]).toMatchObject({ role: "amount-refunded" });
  });

  it("does not label a financial role on a sentence with no amount", () => {
    const findings = analyse("We received the goods in good order.");
    expect(findings.some((finding) => finding.domain === "financial")).toBe(false);
  });

  it("never reads an invoice as a completed payment", () => {
    const findings = analyse("Invoice INV-2024-0007 for 1,200.00 USD is due on 2024-03-31.");
    expect(findings[0]!.role).not.toBe("amount-received");
    expect(findings[0]!.role).not.toBe("amount-transferred");
  });
});

describe("contract intelligence", () => {
  it("labels an obligation and a payment term", () => {
    const obligation = analyse("The supplier shall deliver the goods by 30 June 2024.");
    expect(obligation.map((f) => f.role)).toContain("obligation");

    const terms = analyse("Payment terms: net 30 days from the invoice date.");
    expect(terms.map((f) => f.role)).toContain("payment-terms");
  });

  it("labels an amendment above the base obligation", () => {
    const findings = analyse("The agreement was amended to extend the delivery deadline.");
    expect(findings[0]!.role).toBe("amendment");
  });
});

describe("medical intelligence", () => {
  it("distinguishes a reported symptom from a recorded observation", () => {
    const symptom = analyse("The patient reports pain in the lower back.");
    expect(symptom[0]).toMatchObject({ role: "reported-symptom" });

    const observation = analyse("On examination, the range of movement was reduced.");
    expect(observation[0]).toMatchObject({ role: "recorded-observation" });
  });

  it("labels a diagnosis as a professional conclusion", () => {
    const findings = analyse("Diagnosis: lumbar strain.");
    expect(findings[0]!.role).toBe("professional-conclusion");
  });

  it("labels hedged language as a hedged interpretation, not a conclusion", () => {
    const findings = analyse("The findings may indicate a minor injury.");
    expect(findings[0]!.role).toBe("hedged-interpretation");
    expect(findings[0]!.confidence).toBe("low");
  });
});

describe("research intelligence", () => {
  it("distinguishes a claim, a method, and a result", () => {
    const claim = analyse("We argue that the effect is causal.");
    expect(claim[0]!.role).toBe("research-claim");

    const method = analyse("We sampled 200 participants from the register.");
    expect(method[0]!.role).toBe("research-method");

    const result = analyse("The results show a significant difference (p < 0.05).");
    expect(result[0]!.role).toBe("research-result");
  });

  it("labels a citation as a source reference", () => {
    const findings = analyse("Prior work (Smith et al., 2020) reached the opposite conclusion.");
    expect(findings.map((f) => f.role)).toContain("source-reference");
  });
});

describe("summaries", () => {
  it("counts by domain and role, and omits empty domains", () => {
    const findings = analyse(
      "The court finds that X. The claimant alleges Y. Invoice for 100.00 USD is due.",
    );
    const summary = summariseDomains(findings);
    const legal = summary.find((entry) => entry.domain === "legal");
    expect(legal?.total).toBe(2);
    expect(summary.some((entry) => entry.domain === "medical")).toBe(false);
  });
});
