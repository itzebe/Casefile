# CASEFILE — Hackathon submission package

Everything needed to submit CASEFILE to the **Builder.io Agent-Native Hackathon
2026** (deadline **Nov 9, 2026, 11:59 PM PT**), and to record an honest demo of
it. All claims here are backed by a command, a response, or a screenshot taken
from the live deployment on 2026-11-07.

- Live app: https://casefile-fhkr.vercel.app
- Repository: https://github.com/itzebe/Casefile
- Recording tool: https://clips.agent-native.com/

## 1. Submission form answers

The form at https://www.builder.io/hackathon/submit asks for exactly these
fields.

| Field | Required | Value |
| --- | --- | --- |
| First name | yes | (submitter's name) |
| Last name | yes | (submitter's name) |
| Email | yes | (submitter's email) |
| Project name | yes | CASEFILE |
| Project description | yes | see section 2 below |
| Project or GitHub URL | optional | https://github.com/itzebe/Casefile |
| Public Clips recording URL | yes | record per section 5, then paste the link |
| Slides URL | optional | leave blank (the demo is the argument) |
| Agree to Official Rules | yes | check |

## 2. Project description (paste-ready)

CASEFILE is an evidence workspace for a single dispute. You give it the
documents — a receipt, a bank statement, an email thread, a contract, a
judgment — and it reconstructs what the record actually establishes: which
statements are linked by the identifiers they share, which documents contradict
each other about the same reference, and what the record still cannot answer.

It is built for the moment after the documents arrive and before anyone is sure
what they show. Today that work is done by hand: reading every page, keeping a
mental list of the reference numbers, and trying to remember which document said
what. CASEFILE does the mechanical part — extract, link, compare, and list the
gaps — and leaves every judgement to the person.

The design rule that shapes the whole product is **analysis proposes, a person
confirms**. Nothing is shown as established until a reviewer accepts it. A
contradiction is only reported when two documents disagree about the *same*
explicit identifier (a transaction reference, a case number, an amount on a
named reference) — never because two documents share a word. Every statement
resolves to the exact passage it came from, one click away. Missing facts are a
first-class state: a gap is drawn dashed and quiet, with what would help, and is
never filled with a plausible guess. Extraction that fails says so (for example,
a scanned PDF with no text layer is reported as requiring OCR) rather than
silently returning nothing.

The demonstration is real, not a fixture. One click loads a synthetic case
through the same validate-store-extract-classify-graph pipeline a person's own
upload takes. The court demonstration contains a statement of claim, a defence,
an affidavit, a witness statement, the agreement, and a judgment — all carrying
the same case number, so the graph links them into one proceeding, and the
judgment recites counsel's submission, the defendant's allegation, and the
court's own finding in separate sentences, so the analyser must label an
allegation differently from a finding. The payment demonstration is shaped so
the engine finds a genuine contradiction on its own: the merchant's email and
the bank statement both carry refund reference RRF-55210 but state different
amounts, and the customer denies the refund was ever made.

## 3. How it uses Agent-Native

- **One action, shared by every caller.** Every capability is a `defineAction`
  file in `actions/` — 42 of them. The React UI calls them through
  `useActionQuery` / `useActionMutation`; the agent calls the same functions as
  tools; the same code answers HTTP, MCP, A2A, and the CLI. There is no second
  implementation for the agent to drift from.
- **A deliberately small eager tool surface.** Only five actions (`hello`,
  `navigate`, `list-cases`, `get-case`, `read-case-graph`) are loaded into the
  agent's first request; the rest are reachable through `tool-search`. This is a
  measured choice: a provider payload carrying too many tool declarations makes
  the model stop emitting tool calls at all.
- **The interface and the agent read the same record.** The investigation brief,
  the cross-document panel, the gaps, the readiness state, and the report are
  all read from the stored rows the agent writes to. Reloading the page after an
  agent run shows the agent's result in place.
- **The agent proposes; the UI confirms.** A gap the agent (or the engine)
  raises is reviewed by a person through `review-gap`; the badge changes, and the
  change is audited. No control lets the agent confirm on a person's behalf.

## 4. What genuinely works (verified 2026-11-07, production, signed in)

Verified as a freshly registered user against https://casefile-fhkr.vercel.app.

| Beat | Result |
| --- | --- |
| Register a new account, empty workspace | works |
| Load the court demonstration from `/cases` | works — 6 documents |
| Load the payment demonstration | works — 5 documents |
| Format decided from file bytes, not the declared type | works — 6/6 extracted |
| Document type classification | works — pleading, affidavit, witness-statement, contract, court-judgment |
| Cross-document linking by shared identifiers | works — 21 relationships from the case number alone |
| Field-specific labelling (allegation vs finding) | works — 24 labels; `party-allegation`, `judicial-finding`, `counsel-argument`, `court-order` all distinct |
| A finding resolves to its source passage | works — `judgment.txt`, exact locator |
| Gaps listed for review; review persists | works — `review-gap` writes and the badge changes |
| Readiness is a named state, never a score | works — `awaiting-human-review` |
| Report builds; export to Markdown, PDF, DOCX, CSV, JSON | works — all five returned content |
| Search across documents by identifier | works — `RRF-55210` found in the bank statement |
| Notes write and persist | works |
| `hello` action from the UI and over HTTP | works — `{"message":"Hello, Judge!"}` |
| The agent calls actions and writes the result back | works when the model is available (see 6) |
| Contradiction detection on the payment demo | requires `analyze-evidence` (the model) |

## 5. Demo recording script (Clips)

Record at https://clips.agent-native.com/ at 1440×900, on the live URL, signed
in as a **fresh** account so the empty-workspace state is shown honestly. Keep
it under 3 minutes. Six beats, in order:

1. **Sign up** (0:00–0:15). Show the create-account form, then land on the
   empty workspace. Say: "a new account, nothing loaded."
2. **Load the court case** (0:15–0:45). `/cases` → **Load the court demo**.
   Show the six documents and that each is labelled with its own type. Say:
   "one click, and the documents go through the same pipeline a real upload
   takes."
3. **Connect the documents** (0:45–1:15). Click **Connect the documents**. Point
   at the relationship count and the shared case number HC-2024-1234 that links
   all six. Say: "links come from shared identifiers, never from shared words."
4. **Field-specific analysis** (1:15–1:45). Scroll to **Field-specific
   analysis**. Point at `counsel-argument`, `party-allegation`, and
   `judicial-finding` on the judgment. Say: "the court's finding is labelled
   differently from the defendant's allegation — that distinction is the point."
5. **A gap and its review** (1:45–2:15). Scroll to **What the record does not
   yet establish**, open one gap, show **what would help**, then review it. Say:
   "a gap is a first-class state; nothing is filled with a guess."
6. **Export and the agent** (2:15–2:50). Export the report (PDF or Markdown).
   Then open **Ask the agent about this case** and ask it to summarise the
   conflicts, showing the agent working on the same record. Say: "the agent and
   the interface read the same actions and the same data."

Before recording, confirm the model quota is available (section 6). If the agent
beat cannot be shown, stop at beat 5 and say so — do not fake it.

## 6. Blockers and honest limitations

- **The agent's model is a Groq free-tier key with a 200,000 token/day cap.**
  Verification runs on 2026-11-07 exhausted it; the agent then returns
  `Rate limit reached for model openai/gpt-oss-120b ... tokens per day (TPD):
  Limit 200000`. This is a quota limit, not a code defect: the same requests
  succeed when quota is available (observed before exhaustion). **Before
  recording or judging, the quota must be fresh.** The durable fixes are a
  larger paid tier or a fallback provider — both are money, so neither is
  applied under this milestone's "no paid services" constraint. Recommended:
  reset the key, or point `AGENT_ENGINE`/`AGENT_MODEL` at a provider with
  headroom.
- **`analyze-evidence` (claims, events, and the payment demo's contradiction)
  needs the model.** The deterministic beats — extraction, classification,
  graph, domain labelling, gaps, readiness, report, export, search, notes — do
  not. A judge with no model quota still sees a working product; only the
  model-proposed findings are absent.
- **The rate-limit error is shown verbatim to the user.** The chat renders the
  provider's full 429 text. A friendlier in-app message ("the agent is out of
  quota; the rest of the app still works") is a small UI improvement, not yet
  made.
- **Repository description and homepage are unset.** The GitHub App token in
  this environment has no `administration` permission, so metadata cannot be
  set programmatically. Set them in the GitHub web UI.
- **A duplicate Vercel project `casefile` exists and is inert** (no domain,
  `live:false`, missing auth env vars). It double-builds only. Not deleted —
  deleting is destructive.
- **Agent-reliability caveat.** Early in the session, before the quota was
  exhausted, the agent answered and called tools successfully; once exhausted,
  every run failed with the 429 above. Reliability should be re-measured on a
  fresh quota before the demo.
