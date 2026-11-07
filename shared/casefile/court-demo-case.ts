/**
 * The CASEFILE court-document demonstration, as data.
 *
 * Everything here is synthetic. "Acme Ltd", "Northwind Traders", the parties,
 * the case number, and the judgment are invented for the demonstration. This is
 * NOT a real judgment and must never be presented as one: it exists to show how
 * CASEFILE separates a party's allegation from the court's own finding, and a
 * judgment's reasoning from its operative order.
 *
 * The documents are shaped so the deterministic engine does real work on its
 * own: all six carry the same case number (HC-2024-1234), so the graph links
 * them into one proceeding, and the judgment recites a counsel submission, a
 * party allegation, and the court's own finding in separate sentences so the
 * legal analyser must label them differently.
 *
 * Like the payment demonstration, this is read through the same
 * validate-store-extract-classify-graph pipeline as a person's own uploads.
 */

import type { DemoDocument } from "./demo-case.js";

export const COURT_DEMO_CASE = {
  title: "DEMO — court claim, Acme Ltd v Northwind Traders",
  description:
    "Synthetic demonstration case. A claim for breach of a service agreement: a statement of claim, a defence, an affidavit, a witness statement, the agreement they refer to, and a judgment. The judgment recites counsel's submission, the defendant's allegation, and the court's own finding in separate sentences, so the legal analyser must distinguish an allegation from a finding and a judgment's reasoning from its operative order. No real party, contract, or proceeding.",
  category: "contract-dispute",
  amountMinor: 500_000,
  currency: "USD",
} as const;

export const COURT_DEMO_DOCUMENTS: DemoDocument[] = [
  {
    filename: "statement-of-claim.txt",
    mimeType: "text/plain",
    category: "other",
    text: `IN THE HIGH COURT OF JUSTICE
Case No. HC-2024-1234

STATEMENT OF CLAIM

1. The claimant, Acme Ltd, claims damages for breach of a service agreement
   dated 2024-02-01 (Contract No. SA-2024-0042) between Acme Ltd and the
   defendant, Northwind Traders.

2. The claimant alleges that the defendant failed to deliver the goods by the
   agreed delivery date of 2024-03-01.

3. The claimant alleges that the defendant's failure caused loss of 5000.00 USD.
`,
  },
  {
    filename: "defence.txt",
    mimeType: "text/plain",
    category: "other",
    text: `IN THE HIGH COURT OF JUSTICE
Case No. HC-2024-1234

DEFENCE

1. The defendant, Northwind Traders, admits the service agreement dated
   2024-02-01 (Contract No. SA-2024-0042) but denies the alleged breach.

2. The defendant alleges that any delay was caused by the claimant's failure to
   provide the technical specifications on time.

3. The defendant avers that the specifications were provided on 2024-02-20.
`,
  },
  {
    filename: "affidavit-smith.txt",
    mimeType: "text/plain",
    category: "other",
    text: `AFFIDAVIT

I, Robert Smith, of Northwind Traders, make oath and say as follows:

1. I am the managing director of the defendant and the deponent in these
   proceedings (Case No. HC-2024-1234).

2. I did not receive the technical specifications until 2024-02-20.

3. The goods were ready for dispatch on 2024-02-25.
`,
  },
  {
    filename: "witness-statement-jane.txt",
    mimeType: "text/plain",
    category: "other",
    text: `WITNESS STATEMENT of Jane Doe

I am the operations manager of Acme Ltd (Case No. HC-2024-1234).

I saw the delivery arrive on 2024-03-05, five days after the agreed date.

My evidence is that the goods were in good condition when they arrived.
`,
  },
  {
    filename: "service-agreement.txt",
    mimeType: "text/plain",
    category: "contract",
    text: `SERVICE AGREEMENT
Contract No. SA-2024-0042

This agreement is between Acme Ltd (the customer) and Northwind Traders (the
supplier).

The supplier shall deliver the goods by 2024-03-01.

The customer shall pay 1200.00 USD per month for the term of this agreement.

The customer shall provide the technical specifications within 10 days of
signature.

Signed at London on 2024-02-01.
`,
  },
  {
    filename: "judgment.txt",
    mimeType: "text/plain",
    category: "other",
    text: `IN THE HIGH COURT OF JUSTICE
Case No. HC-2024-1234

JUDGMENT

1. This is a claim for breach of a service agreement dated 2024-02-01
   (Contract No. SA-2024-0042) between Acme Ltd (the claimant) and Northwind
   Traders (the defendant).

2. Counsel for the claimant submitted that the defendant failed to deliver the
   goods by the agreed date of 2024-03-01.

3. The defendant alleges that the delay was caused by the claimant's failure to
   provide the specifications.

4. The court finds that the defendant did breach the agreement by failing to
   deliver on time. The court is satisfied that the claimant's specifications
   were provided on 2024-02-10.

5. It is hereby ordered that the defendant pay damages of 5000.00 USD and costs.
`,
  },
];
