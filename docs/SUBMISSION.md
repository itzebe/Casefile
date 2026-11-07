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
| Project description | yes | see section 2 below — **must include the pre-existing-work disclosure and team names** |
| Project or GitHub URL | optional | https://github.com/itzebe/Casefile |
| Public Clips recording URL | yes | record per section 5, then paste the link |
| Slides URL | optional | leave blank (the demo is the argument) |
| Agree to Official Rules | yes | check |

The description field's own placeholder reads: *"What it does, how it uses
Agent-Native, any pre-existing work, templates, or third-party assets and what
changed during the event, and the names of everyone on your team"* — so the
disclosure is not optional. Section 2 ends with the disclosure paragraph and a
team line; fill in the team names before submitting.

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

### Pre-existing work, templates, and third-party assets (disclosure)

- **Starting point.** CASEFILE was scaffolded on **Nov 4, 2026** from the
  official Agent-Native standalone **chat** template —
  `npx @agent-native/core@latest create casefile --standalone --template chat`.
  That scaffold is the repository's first commit (`8ab7206`) and it is the only
  pre-existing code. Everything from the second commit on is CASEFILE's own
  work, written during the hackathon window (Nov 4–7, 2026; 56 commits).
- **Framework.** `@agent-native/core` 0.223.0, `@agent-native/agentkit`,
  `@agent-native/toolkit`, `@agent-native/otel`. Used as published; not vendored
  or modified.
- **Third-party libraries.** The chat template's dependency set (React 19,
  React Router 8, Tailwind 4, Radix UI, `better-auth`, Drizzle, and others), the
  AI SDK provider packages (`@ai-sdk/*`, `@openrouter/ai-sdk-provider`,
  `ai-sdk-ollama`), `@electric-sql/pglite`, `pdfjs-dist`, `postgres`, and
  `@fontsource-variable/inter`. All are unmodified upstream packages.
- **Model.** The agent runs on Groq's free tier (`AGENT_MODEL=openai/gpt-oss-20b`).
- **Data.** Every document in the two demonstration cases is synthetic and
  written for this project. No real client data, and no licensed third-party
  content, is included.
- **What changed during the event.** The entire product: the case/document
  domain, the 42 actions, the extraction and analysis pipeline, the graph and
  contradiction logic, the review workflow, the report and export, and the
  tests.

### Team

Solo entry — **Marvin Jones** (GitHub `itzebe`). *Confirm the exact name to put
on the form before submitting.*

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
| The agent calls actions and writes the result back | works — `list-cases` returned the real seeded case; `hello` returned `Hello, Judge!` (see 6) |
| Contradiction detection on the payment demo | works — `analyze-evidence` proposed 12 claims and 6 events; the UI showed 60 contradictions, including `RRF-55210` (see 7) |

## 5. Demo recording script (Clips)

### Before you record (pre-flight)

1. **Clips needs a signed-in account.** https://clips.agent-native.com/ is a
   hosted app: "Sign in with Google", "Continue with email", or create an
   account with a password (12-character minimum). It does **not** offer
   local-dev sign-in from a cloud workspace, so this step is the submitter's to
   do. Sign in first, then start the recording.
2. **Set the window to 1440×900** and close other tabs.
3. **Open the live app:** https://casefile-fhkr.vercel.app — do not use a
   preview URL.
4. **Use a fresh account.** Create a new account on the app so the
   empty-workspace state is shown honestly.
5. **Do not pre-load the demo.** Beats 2–3 are one click each; let them happen
   on camera.
6. **Keep it under 3 minutes.** Six beats, in order, below.

Every button label below is the label the app actually renders.

### Beats

1. **Sign up** (0:00–0:15). Show the create-account form, then land on the
   empty workspace. Say: "a new account, nothing loaded."
2. **Load the court case** (0:15–0:45). Go to `/cases`, click **Load the court
   demo**. Show the six documents, each labelled with its own type. Say: "one
   click, and the documents go through the same pipeline a real upload takes."
3. **Connect the documents** (0:45–1:15). Click **Connect the documents**. Point
   at the relationship count and the shared case number `HC-2024-1234` that
   links all six. Say: "links come from shared identifiers, never from shared
   words."
4. **Field-specific analysis** (1:15–1:45). Scroll to **Field-specific
   analysis**. Point at `counsel-argument`, `party-allegation`, and
   `judicial-finding` on the judgment. Say: "the court's finding is labelled
   differently from the defendant's allegation — that distinction is the point."
5. **A gap and its review** (1:45–2:15). Scroll to **What the record does not
   yet establish**, open one gap, show what would help, then review it. Say: "a
   gap is a first-class state; nothing is filled with a guess."
6. **Export, then one agent turn** (2:15–2:50). Export the report (**Export
   Markdown** or **Export PDF**). Then click **Ask the agent about this case** —
   it opens chat with a message already written — and **send it once**. The
   agent reads the same case and answers on the same record. Say: "the agent and
   the interface call the same actions on the same data."

### The agent beat is one turn, once

The working model (`openai/gpt-oss-20b`) allows **8,000 tokens per minute**
(section 6). One short turn fits. Do not send a second message in the same
minute.

- **If the agent answers:** keep the answer on screen for a beat, then stop.
- **If a raw `Rate limit reached …` message appears:** do **not** retry in a
  loop — that is the provider limit, not a bug. Either wait a minute and send
  **once** more, or fall back to the short verified prompt
  **`List my cases, then stop.`** (this returned the seeded case live on
  2026-11-07).
- **If the agent beat cannot be shown at all:** stop at beat 5 and say so on
  camera. Do not fake it.

## 6. Agent model: recovered, and how to keep it working

The agent runs on a Groq free-tier key. On 2026-11-07 the original model,
`openai/gpt-oss-120b`, exhausted its 200,000 tokens/day cap and every run
failed. The key exposes **per-model quota pools**, so the fix is to pin a
different model rather than to pay:

- `AGENT_MODEL=openai/gpt-oss-20b` — the verified working value.

Verified live after the switch (production, signed in, 2026-11-07):

- `list-cases` — the agent called the action and returned the real case in the
  workspace: `DEMO — court claim, Acme Ltd v Northwind Traders`.
- `hello` — the agent called the action and returned `{"message":"Hello, Judge!"}`.
- `analyze-evidence` — proposed 12 claims and 6 events; the case view then showed
  60 contradictions, including the seeded `RRF-55210` refund contradiction.

Two limits remain, and the demo script is written around them:

- **`gpt-oss-20b` allows 8,000 tokens per minute.** One short agent turn fits;
  several turns in the same minute will trip the limit. The demo asks the agent
  one thing, once.
- **The provider's raw 429 text is shown verbatim when a limit is hit.** The
  framework classifies a failure as a rate limit only when the text contains
  "too many requests" or the literal `429`; Groq's "Rate limit reached" does not
  match, so the message reaches the user unsanitised. This is a framework gap,
  not app code. The app-side fix would be a wrapper `fetch` on the engine that
  maps a 429 body to the framework's own `http_429` code, but the plugin's
  engine option is not reliably merged into the engine the chat actually uses,
  so it is documented rather than shipped.

If quota runs out again, pick another accessible model id, in the same way. The
accessible ids on this key on 2026-11-07 were `openai/gpt-oss-20b` (working) and
`openai/gpt-oss-120b` (access, quota exhausted); every other id tested returned
"does not exist or you do not have access".

## 7. What the model adds, and what stands without it

The model-dependent beats — `analyze-evidence`, which proposes claims, events,
parties, and the payment demo's contradiction — were verified working after the
model switch (section 6). The deterministic beats do not need the model at all:
extraction, format detection, classification, cross-document linking, gaps,
readiness, report, export, search, and notes all run without a single model
call. A judge with no model quota still sees a working product; only the
model-proposed findings are absent.

## 8. Other blockers and honest limitations

- **A duplicate Vercel project `casefile` exists and is inert** (no domain,
  `live:false`, missing auth env vars). It double-builds only. Not deleted —
  deleting is destructive.
- **Repository description and homepage are unset.** The GitHub App token in
  this environment has no `administration` permission, so metadata cannot be set
  programmatically. Set them in the GitHub web UI.
- **The agent's per-minute budget is the one live constraint.** On the working
  model a single turn is reliable; the demo asks for one turn, once. See
  section 6.

## 9. Remaining submission steps (checklist)

The repository work is complete and deployed. What remains needs the
submitter's account or a browser session:

1. **Record the Clips demo** — sign in at https://clips.agent-native.com/,
   record the six beats in section 5, get a **public** share URL.
2. **Set repository metadata in the GitHub web UI** (the only repo-metadata
   task that needs manual access — the API token has no `administration`
   permission):
   - **Description:** `Evidence workspace for a single dispute: every claim resolves to a document you can read. Agent-Native hackathon 2026.`
   - **Homepage:** `https://casefile-fhkr.vercel.app`
3. **Submit the form** at https://www.builder.io/hackathon/submit with the
   values in section 1, the description from section 2 (including the
   disclosure), the GitHub URL, and the public Clips URL.
4. **Do not claim the entry is submitted until the form returns a
   confirmation.** Recording and submitting are separate steps.
