/**
 * Seeds the CASEFILE demonstration case through the app's real HTTP actions.
 *
 * The documents themselves live in `shared/casefile/demo-case.ts`, which the
 * in-app `load-demo-case` action reads too. This script only calls that action,
 * so the CLI seed and the judge's button cannot drift apart.
 *
 * Everything is synthetic: an invented merchant, an invented customer, and an
 * invented transfer. No real person, company, payment, or proceeding is
 * represented. It does not call the model: `analyze-evidence` is run from the UI
 * or the agent so a reviewer sees proposals arrive, not a pre-baked result.
 *
 * Usage:
 *   node scripts/seed-demo-case.mjs [baseUrl] [payment|court]
 */
const BASE = process.argv[2] ?? "http://localhost:12000";
const SCENARIO = process.argv[3] === "court" ? "court" : "payment";
const ACTIONS = `${BASE}/_agent-native/actions`;

async function call(name, body = {}) {
  const res = await fetch(`${ACTIONS}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

console.log(`Seeding the ${SCENARIO} demo case against ${BASE}`);

const result = await call("load-demo-case", { scenario: SCENARIO });
const caseId = result.caseId;
if (!caseId) throw new Error(`load-demo-case returned no id: ${JSON.stringify(result)}`);

console.log(`  case ${caseId} (${result.created ? "created" : "already present"})`);
if (result.documents) {
  console.log(
    `  documents: ${result.documents.complete}/${result.documents.total} read, ` +
      `${result.documents.unsupported} unsupported, ${result.documents.failed} failed`,
  );
}
if (result.counts) {
  console.log(
    `  graph: ${result.counts.relationships} relationships, ` +
      `${result.counts.contradictions} contradictions, ${result.counts.gaps} gaps`,
  );
}

console.log(`\nDemo case ready: ${BASE}/cases/${caseId}`);
console.log("Open it, then run Analyse evidence to propose claims and events.");
