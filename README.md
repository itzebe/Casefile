# CASEFILE

An agent-native evidence workspace. A case holds the documents for one dispute;
CASEFILE reads them, links them by the identifiers they share, and shows what
the record establishes, what conflicts, and what is still unknown — leaving
every decision to the person investigating.

Built for the **Builder.io Agent-Native Hackathon 2026** on
[Agent-Native](https://www.agent-native.com/docs/).

Submission and demo material for the hackathon is in
[`docs/SUBMISSION.md`](./docs/SUBMISSION.md).

## What it does

- **Ingest real documents.** PDF, Word, Excel, PNG/JPEG, plain text, Markdown,
  CSV, and `.eml`. The format is decided from the file's own bytes, never the
  client-supplied type or filename.
- **Reconstruct the record.** Extracted passages are linked by explicit
  identifiers — a transaction reference, an amount, a normalised date, a name.
  A relationship is never drawn because two documents share a word.
- **Propose, never confirm.** Analysis proposes claims, events, and
  relationships. Nothing becomes a fact until a person reviews and confirms it.
- **Show the gaps.** Missing facts and unresolved questions are surfaced as
  gaps with what would help, never smoothed over with a plausible guess.
- **Stay honest.** Extraction reports `unsupported` and `failed` explicitly
  rather than silently yielding nothing (for example, a scanned PDF with no
  text layer is reported as requiring OCR).

## Surfaces

| Path | What it is |
| --- | --- |
| `/` | Sign-in / create account |
| `/home` | Landing surface with the agent composer |
| `/cases` | Case list, search across your own cases, demo loaders |
| `/cases/:caseId` | The case workspace: evidence, graph, findings, gaps, notes, activity, report |
| `/chat` | Agent chat |

Every capability is an **action** — the contract shared by the UI, chat, HTTP,
MCP, A2A, and the CLI. There are 42 actions in `actions/`. The agent starts with
a small eager set (`hello`, `navigate`, `list-cases`, `get-case`,
`read-case-graph`) and reaches the rest through `tool-search`, because a local
model loses native tool-calling once the provider payload carries too many
declarations.

## Develop locally

```bash
corepack enable
pnpm install
pnpm dev
```

The dev server runs on `PORT` (default `12000`). Local sign-in is the
documented `AUTH_DISABLED=1` path; it resolves a signed-in development user so
the app exercises the same routes a person does. `AUTH_DISABLED` must never be
set in a deployment — the auth plugin refuses to boot with it.

### Checks

```bash
pnpm typecheck        # tsc across app, server, actions, tests
pnpm test             # unit suite (vitest)
pnpm test:pg          # PostgreSQL integration (needs CASEFILE_TEST_PG_URL)
pnpm test:e2e         # browser journeys (playwright-core + system Chromium)
pnpm build            # production build
```

The browser suite drives the **system** Chromium through `playwright-core`
(see `e2e/browser.ts`) rather than a Playwright CDN download, so it runs in a
sandbox and in CI alike.

## Database

PostgreSQL via Drizzle. Migrations live in `server/db/migration-entries.ts` and
are applied on boot and by `pnpm migrate:production`. Locally, PGlite is used
when no server DSN is configured. One PGlite data directory can be owned by one
process at a time — stop a running dev server before starting another.

## Environment

Secrets are read from the environment and never committed. The agent engine is
selected by `AGENT_ENGINE` (for example `ai-sdk:groq` with model
`openai/gpt-oss-120b`). See `.agents/skills/secrets` for the framework's rules.

## Layout

```
actions/            one file per action (the shared contract)
app/                routes, components, client libraries
  components/casefile/   the case workspace and case list
  components/home/       the landing surface
server/
  casefile/         domain logic: graph, extraction, investigation, access
  db/               Drizzle schema and migrations
  plugins/          auth and agent-chat plugins
shared/casefile/    types shared by client and server
tests/  e2e/  scripts/
```
