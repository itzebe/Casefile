import { docxBytes, pdfBytes, textBytes, xlsxBytes } from "./evidence.js";

/**
 * Synthetic acceptance scenarios.
 *
 * Every document here is invented for testing. No real person, company,
 * payment, or proceeding is represented. Each scenario is a realistic mixed
 * collection so the cross-document engine is exercised the way it would be on a
 * real case, without any real data entering the repository.
 */

export interface ScenarioDocument {
  filename: string;
  bytes: Uint8Array;
  /** The category a user would pick, or "uncategorized" to let it be classified. */
  category: string;
  /** What the document is for, so a failure message is legible. */
  role: string;
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  category: string;
  documents: ScenarioDocument[];
}

/** Scenario A - a payment dispute. */
export const SCENARIO_PAYMENT: Scenario = {
  id: "A",
  title: "Payment dispute",
  description:
    "A customer disputes a card charge; a refund was promised but the record must show whether it arrived.",
  category: "payment-dispute",
  documents: [
    {
      filename: "transfer-receipt.pdf",
      role: "transfer receipt",
      category: "receipt",
      bytes: pdfBytes([
        `TRANSFER RECEIPT
Merchant: Northwind Traders
Date: 2024-03-15
Transaction ID: TXN-88421907
Amount: $249.99 USD
Status: Approved
Card ending: 4242`,
      ]),
    },
    {
      filename: "bank-statement.csv",
      role: "bank statement",
      category: "bank-statement",
      bytes: textBytes(
        `date,description,amount,currency,reference,balance
2024-03-15,Northwind Traders,249.99,USD,TXN-88421907,1000.00
2024-03-20,Refund Northwind,-249.99,USD,TXN-88422001,1250.00
`,
      ),
    },
    {
      filename: "purchase-confirmation.txt",
      role: "purchase confirmation",
      category: "correspondence",
      bytes: textBytes(
        `ORDER CONFIRMATION
Order ID: ORD-55231
Customer: J. Rivera
Date: 2024-03-14
Total: 249.99 USD
Transaction ID: TXN-88421907
Your order has been confirmed and will ship shortly.
`,
      ),
    },
    {
      filename: "seller-correspondence.eml",
      role: "seller correspondence",
      category: "correspondence",
      bytes: textBytes(
        `From: support@northwind.example
To: j.rivera@example.com
Subject: Re: charge TXN-88421907
Date: 2024-03-18

Dear J. Rivera,
We are sorry about the confusion with transaction TXN-88421907 for 249.99 USD.
We have arranged a full refund of 249.99 USD which will appear within 5 days.
Kind regards,
Northwind Traders
`,
      ),
    },
    {
      filename: "refund-promise.txt",
      role: "refund promise",
      category: "correspondence",
      bytes: textBytes(
        `REFUND CONFIRMATION
Reference: TXN-88422001
We confirm a refund of 249.99 USD was sent to card ending 4242 on 2024-03-20.
`,
      ),
    },
  ],
};

/** Scenario B - a court case with a judgment, witness statement, affidavit, contract. */
export const SCENARIO_COURT: Scenario = {
  id: "B",
  title: "Court case",
  description:
    "A judgment, a witness statement, an affidavit, and the contract they refer to. The analysis must separate a party's allegation from the court's finding.",
  category: "contract-dispute",
  documents: [
    {
      filename: "judgment.pdf",
      role: "court judgment",
      category: "other",
      bytes: pdfBytes([
        `IN THE HIGH COURT OF JUSTICE
Case No. 2024-1234
JUDGMENT

1. This is a claim for breach of a service agreement dated 2024-02-01 between Acme Ltd (the claimant) and Northwind Traders (the defendant).

2. Counsel for the claimant submitted that the defendant failed to deliver the goods by the agreed date of 2024-03-01.

3. The defendant alleges that the delay was caused by the claimant's failure to provide specifications.

4. The court finds that the defendant did breach the agreement by failing to deliver on time. The court is satisfied that the claimant's specifications were provided on 2024-02-10.

5. It is hereby ordered that the defendant pay damages of 5,000.00 USD and costs.
`,
      ]),
    },
    {
      filename: "witness-statement-jane.pdf",
      role: "witness statement",
      category: "other",
      bytes: pdfBytes([
        `WITNESS STATEMENT of Jane Doe
I am the operations manager of Acme Ltd.
I saw the delivery arrive on 2024-03-05, five days late.
My evidence is that the goods were in good condition when they arrived.
`,
      ]),
    },
    {
      filename: "affidavit-smith.pdf",
      role: "affidavit",
      category: "other",
      bytes: pdfBytes([
        `AFFIDAVIT
I make oath and say as follows.
I am the defendant's managing director and the deponent in these proceedings.
The specifications were received late. I did not receive the specifications until 2024-02-20.
`,
      ]),
    },
    {
      filename: "service-agreement.docx",
      role: "referenced contract",
      category: "contract",
      bytes: docxBytes([
        "SERVICE AGREEMENT",
        "This agreement is between Acme Ltd and Northwind Traders.",
        "The defendant shall deliver the goods by 2024-03-01.",
        "The customer shall pay 1,200.00 USD per month.",
        "Signed at London on 1 February 2024.",
      ]),
    },
  ],
};

/** Scenario C - a business contract with an amendment, invoice, delivery, correspondence. */
export const SCENARIO_CONTRACT: Scenario = {
  id: "C",
  title: "Business contract",
  description:
    "An original contract, an amendment, an invoice, a delivery record, and correspondence, to test obligation tracking and a performance discrepancy.",
  category: "contract-dispute",
  documents: [
    {
      filename: "contract.pdf",
      role: "original contract",
      category: "contract",
      bytes: pdfBytes([
        `SUPPLY AGREEMENT
This agreement is between Acme Ltd and Northwind Traders.
The supplier shall deliver 100 units by 2024-06-30.
Payment terms: net 30 days from the invoice date.
Either party may terminate with 30 days written notice.
`,
      ]),
    },
    {
      filename: "amendment.pdf",
      role: "amendment",
      category: "contract",
      bytes: pdfBytes([
        `AMENDMENT NO. 1
This agreement is amended to extend the delivery deadline to 2024-07-15.
The quantity remains 100 units. All other terms are unchanged.
`,
      ]),
    },
    {
      filename: "invoice.pdf",
      role: "invoice",
      category: "invoice",
      bytes: pdfBytes([
        `INVOICE INV-2024-0007
Bill to: Northwind Traders
Date: 2024-07-16
Amount due: 12,000.00 USD
Payment terms: net 30 days.
`,
      ]),
    },
    {
      filename: "delivery-record.txt",
      role: "delivery record",
      category: "other",
      bytes: textBytes(
        `DELIVERY NOTE
Reference: DN-9001
Date: 2024-07-20
We delivered 80 units to Northwind Traders.
The remaining 20 units are on backorder.
`,
      ),
    },
    {
      filename: "correspondence.txt",
      role: "correspondence",
      category: "correspondence",
      bytes: textBytes(
        `From: Northwind Traders
To: Acme Ltd
Date: 2024-07-25

We received only 80 of the 100 units ordered under contract reference DN-9001.
Please advise when the outstanding 20 units will be delivered.
`,
      ),
    },
  ],
};

/** Scenario D - research. Two papers, a supporting report, and a data table. */
export const SCENARIO_RESEARCH: Scenario = {
  id: "D",
  title: "Research",
  description:
    "Two publications that disagree, a supporting report, and a data table, to test comparison of claims, methods, and dates with provenance.",
  category: "other",
  documents: [
    {
      filename: "paper-a.pdf",
      role: "research publication A",
      category: "other",
      bytes: pdfBytes([
        `Abstract
We present a study of the effect of compound X on outcome Y.
Methodology: we sampled 200 participants and measured outcome Y over 12 weeks.
Results show a significant improvement (p < 0.05).
We argue that compound X is effective.
doi:10.1000/study-a
`,
      ]),
    },
    {
      filename: "paper-b.pdf",
      role: "research publication B",
      category: "other",
      bytes: pdfBytes([
        `Abstract
We present a replication of the study of compound X on outcome Y.
Methodology: we sampled 150 participants and measured outcome Y over 8 weeks.
The results show no significant difference (p > 0.05).
We argue that the earlier finding does not replicate.
doi:10.1000/study-b
`,
      ]),
    },
    {
      filename: "supporting-report.pdf",
      role: "supporting report",
      category: "other",
      bytes: pdfBytes([
        `Executive summary
This report reviews the evidence on compound X.
Two studies reached different conclusions, published 2024-01-10 and 2024-02-20.
Further research is required to resolve the disagreement.
`,
      ]),
    },
    {
      filename: "data-table.csv",
      role: "data table",
      category: "other",
      bytes: textBytes(
        `study,participants,effect,pvalue,date
Study A,200,positive,0.03,2024-01-10
Study B,150,none,0.42,2024-02-20
`,
      ),
    },
  ],
};

/** Scenario E - mixed documents from different categories in one case. */
export const SCENARIO_MIXED: Scenario = {
  id: "E",
  title: "Mixed documents",
  description:
    "A medical report, an insurance claim, a contract, and an invoice in one case, to test shared entities across categories.",
  category: "other",
  documents: [
    {
      filename: "medical-report.pdf",
      role: "medical report",
      category: "other",
      bytes: pdfBytes([
        `MEDICAL REPORT
Patient: A. Smith
Policy number: POL-778812
The patient reports pain following an incident on 2024-05-01.
On examination, the range of movement was reduced.
Diagnosis: soft tissue injury.
`,
      ]),
    },
    {
      filename: "insurance-claim.pdf",
      role: "insurance claim",
      category: "policy",
      bytes: pdfBytes([
        `INSURANCE CLAIM FORM
Claim number: CLM-334455
Policy holder: A. Smith
Policy number: POL-778812
Date of incident: 2024-05-01
We confirm the claim was received.
`,
      ]),
    },
    {
      filename: "treatment-invoice.pdf",
      role: "treatment invoice",
      category: "invoice",
      bytes: pdfBytes([
        `INVOICE INV-MED-2201
Patient: A. Smith
Date: 2024-05-10
Amount due: 850.00 USD
For treatment following the incident on 2024-05-01.
`,
      ]),
    },
    {
      filename: "ledger.xlsx",
      role: "spreadsheet ledger",
      category: "other",
      bytes: xlsxBytes("Ledger", [
        ["date", "description", "amount", "balance", "reference"],
        ["2024-05-10", "Treatment invoice", "850.00", "4000.00", "INV-MED-2201"],
      ]),
    },
  ],
};

export const SCENARIOS: Scenario[] = [
  SCENARIO_PAYMENT,
  SCENARIO_COURT,
  SCENARIO_CONTRACT,
  SCENARIO_RESEARCH,
  SCENARIO_MIXED,
];

