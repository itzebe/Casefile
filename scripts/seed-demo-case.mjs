/**
 * Seeds the CASEFILE demonstration case through the app's real HTTP actions.
 *
 * Everything here is synthetic: an invented merchant, an invented customer, and
 * an invented transfer. No real person, company, payment, or proceeding is
 * represented. The documents are ordinary text and CSV so extraction is
 * deterministic and the case can be rebuilt identically for a demo or a test.
 *
 * Usage:
 *   node scripts/seed-demo-case.mjs [baseUrl]
 *
 * It creates the case, uploads the documents, extracts them, and builds the
 * cross-document graph. It does not call the model: `analyze-evidence` is run
 * from the UI or the agent so a reviewer sees proposals arrive, not a
 * pre-baked result.
 */
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? process.env.BASE ?? "http://localhost:12000";
const ACTIONS = `${BASE}/_agent-native/actions`;

async function call(name, body = {}, method = "POST") {
  const url =
    method === "GET"
      ? `${ACTIONS}/${name}?${new URLSearchParams(body).toString()}`
      : `${ACTIONS}/${name}`;
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (res.status >= 400) {
    throw new Error(`${name} failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

const CASE = {
  title: "DEMO — disputed refund for ORD-77120",
  description:
    "Synthetic demonstration case. A customer paid ₦85,000 for a standing desk that never arrived and asked for a refund. The merchant says the refund was made; the bank statement records a different amount under the same refund reference; the customer says nothing arrived. No real party, payment, or proceeding.",
  category: "payment-dispute",
  amountMinor: 8_500_000,
  currency: "NGN",
};

/**
 * The documents are shaped so that the deterministic engine finds a genuine,
 * checkable contradiction on its own: the merchant email and the bank statement
 * both carry refund reference RRF-55210 but state different amounts (85,000
 * versus 65,000), and the customer's message denies the merchant's assertion
 * that the refund was made. Neither is a difference of wording - each is two
 * sources disagreeing about the same explicit identifier.
 */
const DOCUMENTS = [
  {
    filename: "transfer-receipt.txt",
    mimeType: "text/plain",
    category: "receipt",
    text: `TRANSFER RECEIPT
Merchant: Sunrise Electronics Ltd
Customer: A. Okoro
Date: 2026-02-11
Transaction ID: TXN-44710298
Amount: ₦85,000.00 NGN
Status: Approved
Sender account: 0123456789
Beneficiary account: 9876543210
Goods: 1 x standing desk (order ORD-77120)
`,
  },
  {
    filename: "bank-statement.csv",
    mimeType: "text/csv",
    category: "bank-statement",
    text: `date,description,amount,currency,reference,balance
2026-02-11,Sunrise Electronics Ltd,-85000.00,NGN,TXN-44710298,250000.00
2026-02-22,Refund Sunrise Electronics,65000.00,NGN,RRF-55210,185000.00
`,
  },
  {
    filename: "order-confirmation.txt",
    mimeType: "text/plain",
    category: "correspondence",
    text: `ORDER CONFIRMATION
Order ID: ORD-77120
Customer: A. Okoro
Date: 2026-02-10
Item: 1 x standing desk
Total: 85000.00 NGN
Transaction ID: TXN-44710298
Your order is confirmed and will be delivered within 3 working days.
`,
  },
  {
    filename: "merchant-emails.txt",
    mimeType: "text/plain",
    category: "correspondence",
    text: `From: support@sunrise-electronics.example
To: a.okoro@example.com
Subject: Re: order ORD-77120 (transaction TXN-44710298)
Date: 2026-02-24

Dear A. Okoro,
We are sorry your standing desk did not arrive. We confirm we have refunded
85000.00 NGN for transaction TXN-44710298, reference RRF-55210. The refund was
sent on 2026-02-22 to the account you paid from and should appear within 5
working days.
Kind regards,
Sunrise Electronics Ltd
`,
  },
  {
    filename: "customer-emails.txt",
    mimeType: "text/plain",
    category: "correspondence",
    text: `From: a.okoro@example.com
To: support@sunrise-electronics.example
Subject: Re: order ORD-77120 (transaction TXN-44710298)
Date: 2026-02-26

Dear Sunrise Electronics,
The standing desk I ordered under ORD-77120 has never been delivered. I have
not received any refund for transaction TXN-44710298. The refund you describe
under reference RRF-55210 was never made to my account. Please refund the full
85000.00 NGN that I paid.
Regards,
A. Okoro
`,
  },
];

console.log(`Seeding demo case against ${BASE}`);

const created = await call("create-case", CASE);
const caseId = created.caseId ?? created.id ?? created.case?.id;
if (!caseId) throw new Error(`create-case returned no id: ${JSON.stringify(created)}`);
console.log(`  case ${caseId}`);

const evidenceIds = [];
for (const doc of DOCUMENTS) {
  const up = await call("upload-evidence", {
    caseId,
    filename: doc.filename,
    dataBase64: b64(doc.text),
    mimeType: doc.mimeType,
    category: doc.category,
  });
  const id = up.evidenceId ?? up.id;
  evidenceIds.push(id);
  console.log(`  uploaded ${doc.filename} -> ${id}`);
}

const extracted = await call("extract-evidence", { caseId });
for (const row of extracted.results ?? []) {
  console.log(`  extracted ${row.filename}: ${row.status} (${row.passageCount ?? 0} passages)`);
}

const graph = await call("build-case-graph", { caseId, persist: true });
console.log(
  `  graph: ${graph.counts?.relationships ?? 0} relationships, ` +
    `${graph.counts?.contradictions ?? 0} contradictions, ${graph.counts?.gaps ?? 0} gaps`,
);

console.log(`\nDemo case ready: ${BASE}/cases/${caseId}`);
console.log("Open it, then run Analyse evidence to propose claims and events.");
