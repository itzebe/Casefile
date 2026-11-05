import { describe, expect, it } from "vitest";

import { buildFindingSubject, compareFindings } from "../server/casefile/comparison.js";
import {
  detectAmounts,
  detectDates,
  detectParties,
  detectReferences,
  hasNegation,
  referenceKeys,
} from "../server/casefile/entities.js";

/**
 * Unit tests for the deterministic comparison engine.
 *
 * These are the decision rules that stop a difference from being reported as a
 * contradiction. They are tested directly, without a database, because they are
 * pure functions and because a regression here would silently corrupt every
 * verdict the product shows.
 */

function subject(
  id: string,
  statement: string,
  citations: Array<{ evidenceId: string; text: string }>,
  eventDate?: string | null,
) {
  return buildFindingSubject({ id, kind: "claim", statement, citations, eventDate });
}

describe("entity detection", () => {
  it("reads the same identifier whether or not it carries its label", () => {
    const labelled = detectReferences("Transaction ID: TXN-88421907");
    const bare = detectReferences("reference: TXN-88421907");
    const keys = (refs: typeof labelled) => refs.flatMap((r) => referenceKeys(r));
    // Both forms must share the identifier key, or a receipt and a statement
    // would never be linked.
    expect(keys(labelled)).toContain("txn88421907");
    expect(keys(bare)).toContain("txn88421907");
  });

  it("does not treat a bare number as an identifier", () => {
    // A card's last four digits are not a transaction reference.
    const refs = detectReferences("Card ending: 4242");
    expect(refs.flatMap((r) => referenceKeys(r))).not.toContain("4242");
  });

  it("preserves a date exactly as written alongside its normalisation", () => {
    const [date] = detectDates("Signed at London on 15 March 2024.");
    expect(date?.text).toBe("15 March 2024");
    expect(date?.iso).toBe("2024-03-15");
  });

  it("marks an ambiguous numeric date as unknown rather than guessing", () => {
    // 03/04/2024 could be March 4th or April 3rd.
    const [date] = detectDates("Dated 03/04/2024");
    expect(date?.precision).toBe("unknown");
    expect(date?.iso).toBeNull();
  });

  it("reads a labelled amount with no currency symbol", () => {
    const [amount] = detectAmounts("Amount: 249.99");
    expect(amount?.minor).toBe(24999);
    // No symbol and no code, so no currency is assumed.
    expect(amount?.currency).toBeNull();
  });

  it("reads a party only when a document introduces it", () => {
    const parties = detectParties("Merchant: Northwind Traders\nSome Other Capitalised Words");
    expect(parties.map((p) => p.text)).toContain("Northwind Traders");
    // An unlabelled capitalised phrase is not a party.
    expect(parties.map((p) => p.text)).not.toContain("Some Other Capitalised Words");
  });

  it("detects a denial", () => {
    expect(hasNegation("The customer did not authorise the charge.")).toBe(true);
    expect(hasNegation("The customer authorised the charge.")).toBe(false);
  });
});

describe("comparison verdicts", () => {
  it("reports direct agreement when both sides name the same reference", () => {
    const a = subject("a", "Charge TXN-88421907 of $249.99 was made.", [
      { evidenceId: "e1", text: "Transaction ID: TXN-88421907\nAmount: $249.99" },
    ]);
    const b = subject("b", "Charge TXN-88421907 of $249.99 appears.", [
      { evidenceId: "e2", text: "reference: TXN-88421907\namount: 249.99 USD" },
    ]);
    const comparison = compareFindings(a, b);
    expect(comparison.verdict).toBe("direct_agreement");
    expect(comparison.crossDocument).toBe(true);
  });

  it("reports a contradiction when the same reference carries two amounts", () => {
    const a = subject("a", "The receipt records TXN-88421907 for $249.99.", [
      { evidenceId: "e1", text: "Transaction ID: TXN-88421907\nAmount: $249.99" },
    ]);
    const b = subject("b", "The statement records TXN-88421907 for $499.99.", [
      { evidenceId: "e2", text: "reference: TXN-88421907\namount: 499.99 USD" },
    ]);
    const comparison = compareFindings(a, b);
    expect(comparison.verdict).toBe("contradiction");
    expect(comparison.conflictingAmounts).not.toBeNull();
  });

  it("reports a contradiction when one side affirms and the other denies", () => {
    const a = subject("a", "The customer authorised TXN-88421907.", [
      { evidenceId: "e1", text: "Transaction ID: TXN-88421907" },
    ]);
    const b = subject("b", "The customer did not authorise TXN-88421907.", [
      { evidenceId: "e2", text: "reference: TXN-88421907" },
    ]);
    const comparison = compareFindings(a, b);
    expect(comparison.verdict).toBe("contradiction");
    expect(comparison.polarityDiffers).toBe(true);
  });

  it("reports a date difference as a potential contradiction, not a hard one", () => {
    const a = subject("a", "The charge TXN-88421907 was made on 2024-03-15.", [
      { evidenceId: "e1", text: "reference: TXN-88421907 date 2024-03-15" },
    ]);
    const b = subject("b", "The charge TXN-88421907 was made on 2024-04-01.", [
      { evidenceId: "e2", text: "reference: TXN-88421907 date 2024-04-01" },
    ]);
    const comparison = compareFindings(a, b);
    // The same event is recorded on different dates by different systems, so the
    // evidence alone does not establish a disagreement.
    expect(comparison.verdict).toBe("potential_contradiction");
    expect(comparison.conflictingDates).not.toBeNull();
  });

  it("reports insufficient information when one side has no source", () => {
    const a = subject("a", "The charge was fraudulent.", []);
    const b = subject("b", "A charge of $249.99 was made.", [
      { evidenceId: "e2", text: "Amount: $249.99" },
    ]);
    expect(compareFindings(a, b).verdict).toBe("insufficient_information");
  });

  it("reports unrelated when the two sides are in the same document", () => {
    const a = subject("a", "A charge of $249.99 was made.", [
      { evidenceId: "e1", text: "Amount: $249.99" },
    ]);
    const b = subject("b", "A charge of $249.99 was refunded.", [
      { evidenceId: "e1", text: "Amount: $249.99" },
    ]);
    const comparison = compareFindings(a, b);
    expect(comparison.verdict).toBe("unrelated");
    expect(comparison.crossDocument).toBe(false);
  });

  it("reports unrelated when two documents share only a date", () => {
    const a = subject("a", "A meeting was held.", [
      { evidenceId: "e1", text: "Meeting on 2024-03-15 at the office." },
    ]);
    const b = subject("b", "A delivery arrived.", [
      { evidenceId: "e2", text: "Delivery on 2024-03-15 to the warehouse." },
    ]);
    // A shared date is too weak a link to compare two different events.
    expect(compareFindings(a, b).verdict).toBe("unrelated");
  });

  it("does not call two different amounts a contradiction without a shared reference", () => {
    const a = subject("a", "A payment of $249.99 was made.", [
      { evidenceId: "e1", text: "Amount: $249.99\nMerchant: Northwind Traders" },
    ]);
    const b = subject("b", "A payment of $499.99 was made.", [
      { evidenceId: "e2", text: "Amount: $499.99\nMerchant: Northwind Traders" },
    ]);
    const comparison = compareFindings(a, b);
    // The shared merchant is enough to compare, but with no reference fixing the
    // subject the difference is only a potential contradiction.
    expect(comparison.verdict).toBe("potential_contradiction");
    expect(comparison.conflictingAmounts).not.toBeNull();
  });
});

/**
 * These are the mutation checks. Each asserts the reason a verdict is what it is,
 * so neutralising the corresponding rule in `comparison.ts` changes the verdict
 * and fails the test. A rule that cannot fail is a rule that is not protecting
 * anything.
 */
describe("comparison rules are load-bearing", () => {
  it("distinguishes a denial from a mere difference", () => {
    const affirming = subject("a", "The customer authorised the charge.", [
      { evidenceId: "e1", text: "Merchant: Northwind Traders\nAmount: $249.99" },
    ]);
    const denying = subject("b", "The customer did not authorise the charge.", [
      { evidenceId: "e2", text: "Merchant: Northwind Traders\nAmount: $249.99" },
    ]);
    const different = subject("c", "The customer queried the charge.", [
      { evidenceId: "e3", text: "Merchant: Northwind Traders\nAmount: $249.99" },
    ]);

    // Same subject, opposite polarity: a contradiction.
    expect(compareFindings(affirming, denying).verdict).toBe("contradiction");
    // Same subject, no polarity difference: not a contradiction.
    expect(compareFindings(affirming, different).verdict).not.toBe("contradiction");
  });

  it("requires an explicit identifier before calling two amounts contradictory", () => {
    const withRef = subject("a", "TXN-88421907 is $249.99.", [
      { evidenceId: "e1", text: "reference: TXN-88421907 amount: 249.99" },
    ]);
    const withRefOther = subject("b", "TXN-88421907 is $499.99.", [
      { evidenceId: "e2", text: "reference: TXN-88421907 amount: 499.99" },
    ]);
    expect(compareFindings(withRef, withRefOther).verdict).toBe("contradiction");
  });
});
