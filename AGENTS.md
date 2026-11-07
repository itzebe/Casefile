# CASEFILE — Agent Guide

CASEFILE is an agent-native case workspace. A user opens a case, the agent helps
assemble it, and every claim in the finished file resolves to a piece of
evidence that was actually observed. The product exists to make an
evidence-backed record cheap to build and hard to fake.

This file is the contract for anyone — human or agent — working in this repo.
`README.md` and `DESIGN.md` describe the app that exists today; this file
describes what CASEFILE must become and the rules that never bend.

## 1. Product vision

A case is a question that needs a defensible answer: an incident, a dispute, a
due-diligence review, a research question. Today that work is a folder of
screenshots, a spreadsheet, and a memory. CASEFILE replaces the folder.

The core loop:

1. The user states the case and its acceptance criteria in chat.
2. The agent gathers evidence through actions — files, records, connected
   sources, screenshots of what the user can see — and records each item with
   its origin.
3. The agent proposes findings. A finding is only ever a claim plus the exact
   evidence identifiers that support it.
4. The user reviews, challenges, and resolves. The case file exports with its
   provenance intact.

Non-goals: CASEFILE is not a chatbot with a document tab, and not a
general-purpose note app. If a feature does not make an evidence-backed record
faster to build or harder to fake, it is out of scope.

Success is a stranger reading an exported case file and being able to re-derive
every conclusion from the evidence attached to it, without trusting the agent.

## 2. Agent-Native architecture requirements

Agent-Native is the framework and execution platform. AgentKit is the
interaction layer. Toolkit supplies the composer and workspace UI. Do not
substitute another agent framework, and do not build a generic chatbot.

- **Actions are the API.** All app capability lives in `actions/*.ts` as
  `defineAction` operations with zod schemas. The UI and the agent call the
  same action; there is no separate agent-only or UI-only path. Keep actions
  deterministic and narrowly scoped.
- **Normal app data flows through actions.** Do not reach around the action
  surface to mutate domain state from a component.
- **Screens exist for durable workflows.** Add a route only when a workflow
  needs a persistent surface; everything else is chat plus action widgets.
- **Chat is the primary surface.** The `/` route is the AgentKit canvas. Pass
  route controls through its `toolbar` prop; use `slots`/`registry` for
  presentation overrides instead of forking conversation state.
- **Action UI is opt-in** per action through `chatUI.renderer`; register app
  renderers with `registerActionChatRenderer()` using the same renderer id the
  action declares.
- **Persistence is SQL-backed** (PGlite in dev), with SSE for live sync. Keep
  structured state in SQL, large artifacts in configured storage, and persist
  references only.
- **Use the workspace's local docs.** `pnpm action docs-search --query "<topic>"`
  and `pnpm action source-search --query "<pattern>"` answer framework
  questions from the installed version. Prefer them over web research.
- Read `.agents/skills/build-an-app/SKILL.md` before adding a domain workflow
  and `.agents/skills/adding-a-feature/SKILL.md` for a cross-area change.

## 3. Design Constitution

These rules are binding on every UI change. A change that violates one is
rejected even if it looks better in isolation.

1. **Evidence is always visible.** Any claim the agent surfaces renders with a
   way to reach the evidence behind it. Never present an unsourced conclusion.
2. **State the uncertainty, do not smooth it over.** Missing, ambiguous, or
   contradictory evidence is shown as such. Do not fill a gap with a plausible
   guess or an empty state that implies completeness.
3. **Deterministic before intelligent.** A value that can be computed from
   evidence is computed, not asked of a model. Models propose; they do not
   decide what is true.
4. **One action, one responsibility.** If an action needs "and" to describe it,
   split it.
5. **Feedback within 100 ms, never past 400 ms.** Acknowledge before network
   work. Never leave a click unanswered.
6. **Quiet chrome, loud content.** Follow the existing direction: borderless
   lists, soft selected rows, restrained labels, semantic tokens. Do not
   introduce a competing accent, floating chips, or duplicated navigation.
7. **Compose the scaffold.** Reuse the shared component seams and the
   AgentKit/Toolkit primitives. Compare sibling surfaces before inventing a new
   pattern.
8. **No placeholder destinations.** Do not ship a link or control the app does
   not implement.
9. **Accessibility is not a pass.** Every interactive control is keyboard
   reachable and named; color is never the only signal. A control a person
   aims at is at least 24x24 CSS pixels (WCAG 2.5.8) — a block or list
   control needs `py-1` on its base height. Inline links inside a sentence are
   exempt. `tests/ui-contract.test.ts` enforces this; keep the exemption list
   explicit rather than widening the rule.
10. **The case file outlives the session.** Anything a user would expect to
    find later is persisted, not held in component state.

## 4. Security and privacy boundaries

- **Secrets never enter the repo.** No credentials, tokens, API keys, or
  customer data in source, fixtures, tests, logs, or commit history.
  `BETTER_AUTH_SECRET` and `SECRETS_ENCRYPTION_KEY` stay in the environment
  (`.env`, gitignored); `.env.example` documents keys with placeholder values
  only. Read `.agents/skills/secrets/SKILL.md` before handling any credential.
- **Auth is on by default.** `AUTH_DISABLED=true` is for local dev and preview
  only and must never be set in a production deploy. Standalone production
  needs a stable `BETTER_AUTH_SECRET`. This is enforced, not just documented:
  the auth plugin's boot guard (`server/casefile/auth-guard.ts`,
  `assertAuthNotDisabledInDeployment`) **refuses to start** when `AUTH_DISABLED`
  is set and the process looks like a deployment (any hosted-platform marker, or
  `NODE_ENV=production`), because every request would otherwise resolve to one
  shared identity. The only escape hatch is an explicit
  `CASEFILE_ALLOW_AUTH_DISABLED=true`, for a private demo. `tests/auth-guard.test.ts`
  pins both the refusal and the opt-in.
- **Least privilege for integrations.** Reuse the workspace's scoped connection
  resolver. Never hardcode a webhook URL, provider endpoint, or credential.
- **Evidence may be sensitive.** Treat stored evidence as private to the case
  owner. Do not surface it across cases, users, or workspaces, and do not send
  it to a third party without an explicit, per-action reason.
- **Validate at the boundary.** Every action validates its input with a zod
  schema. Never trust a client-supplied identifier to authorize an operation —
  resolve access from the server side.
- **Never expose secrets in errors.** Fail loudly to the log, quietly to the
  user.
- **No paid services or infrastructure.** Local and free tiers only. Do not
  introduce a service that needs a credit card to develop or verify.
- **Shared AI provider for judges.** Provider credentials resolve per request
  through the scopes `user → org → workspace(org) → workspace(solo)` and then a
  **deployment-level** fallback. Because every signup gets its own organization,
  an org- or personal-scoped key serves only that scope; a judge in a fresh
  organization has no provider and cannot run the investigation engine or chat.
  The supported fix is one **deployment-level provider key** in the server
  environment (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, or
  `COHERE_API_KEY`). Any signed-in user with no scoped key then uses it, across
  every organization, and usage is billed to the deployment account. This is the
  framework's documented "app-wide fallback" for self-hosted/standalone
  deployments. Precedence is unchanged: a user-, org-, or workspace-scoped key
  always wins over the deployment key.
  - This app is a **standalone** app (`agent-native.config.ts` sets no
    `workspace.isWorkspace`/`appsJson`), so it is eligible. A production
    **hosted workspace** runtime deliberately blocks deployment provider-key
    fallbacks, and `tests/shared-provider.test.ts` asserts both sides of that.
  - A Builder.io gateway pair (`BUILDER_GATEWAY_TOKEN` +
    `BUILDER_GATEWAY_SPACE_ID`) is **not** shareable across organizations in
    production: the framework refuses Builder-credits pairs outside a trusted
    self-hosted or Fusion-preview runtime. Builder is per-user/per-org only.
  - The key is server-side. It is never written to the database, never returned
    by an API response, and never enters the browser bundle; only the provider
    label and model are ever shown to a user.

## 5. Implementation constraints

- **Scaffold shape is fixed.** This is a standalone Agent-Native app created
  from the official `chat` template. Keep the framework wiring intact.
- **New project.** Do not copy code, config, or data from other repositories.
  CASEFILE is original work for the Builder.io Agent-Native Hackathon 2026.
- **Keep names stable.** Action names and their schemas are a public contract
  the agent depends on. Renaming an action is a breaking change.
- **Small, reviewable changes.** Prefer the smallest edit that satisfies the
  requirement. Do not refactor adjacent code in the same change.
- **Typecheck is the floor.** `pnpm typecheck` must pass before a change is
  considered done.
- **Local model note.** This workspace runs a local Ollama. A cold model needs
  ~200-300s to prefill the ~15k-token system prompt, which exceeds Node's
  default 300s `headersTimeout`. Run the dev server with
  `NODE_OPTIONS="--import ./scripts/dev-ollama-timeout.mjs"` so a slow first
  token is not mistaken for a dead provider. This is a local-dev workaround,
  not a production setting.
- **Long actions need an explicit client timeout.** The framework aborts an
  action call after 60s unless the caller passes `timeoutMs`. An action that
  runs a model over a case's passages (`analyze-evidence`) legitimately takes
  longer, so its mutation sets `timeoutMs`. Without it the request is dropped
  mid-flight while the server keeps working, and the user sees nothing.
- **One concept, one serialiser.** `get-case` and `list-evidence` both feed the
  workspace's evidence panel. Any field the panel renders (`passageCount`,
  `citedByFindings`, `documentType`, `classificationConfidence`,
  `classificationCorrectedBy`) must be present on both, or the panel silently
  blanks. A `<select>` bound to a field the action omits does not error: it
  falls back to its first option, so a missing `documentType` made every file
  read "Court judgment" while the stored type was correct. When you add a
  column to the panel, add it to both actions and assert they agree.
- **The deploy config owns schema, not the request.** A hosted request runtime
  never creates tables (`schemaIsReleaseOwned()` gates DDL), so every release
  migration must run at build time on the production branch. `netlify.toml`
  runs `pnpm migrate:production` when `CONTEXT=production`; `vercel.json` runs
  the same script when `VERCEL_ENV=production`, after the build, and refuses to
  continue if `DATABASE_URL` is unset. When you add or change a deploy target,
  mirror that contract — a framework table that only exists in a migration
  (e.g. `agent_chat_submission_inbox`, chat-threads v5) is absent on production
  until a production build has applied it, and the failure surfaces only at
  runtime as `relation "..." does not exist`.
- **Deployment-level provider defaults.** Every signup gets its own
  organization, so a per-org app model default does not reach a judge in a
  fresh org. Set the deployment default with `AGENT_ENGINE` + `AGENT_MODEL`
  (`ai-sdk:groq` / `openai/gpt-oss-120b`); the framework's hard-coded
  `DEFAULT_MODEL` is retired at Groq and fails with "model does not exist".
  That default is a **reasoning model**: it spends output tokens on hidden
  reasoning before it writes an answer, so the investigation output cap must be
  large enough to clear the reasoning and still leave room for the JSON. A cap
  sized for the answer alone is consumed entirely and the run ends with reason
  `max_tokens` and no text. If a reasoning model returns nothing, raise the cap
  (`analyze-evidence` uses 16384); do not go looking in the prompt.
- **Do not deploy** without an explicit instruction to deploy.

## 6. Testing and verification

- **Verify, do not assume.** Every claim that something works is backed by a
  command, a response, or a screenshot from this environment. "It should work"
  is not a result.
- **Verify the real path.** Exercise the actual action and the actual route. Do
  not substitute a mock for the code under test.
- **Prove both callers.** A new or changed action is verified from the UI
  (its HTTP route) **and** from the agent (the tool call in chat). The two
  paths are the product's promise; one without the other is unverified.
- **Test the failure mode.** For each new invariant, confirm it can fail —
  mutate the guard and watch the test go red. A check that cannot fail is a
  defect.
- **Run the checks that exist.** `pnpm typecheck`, `pnpm test` (vitest,
  PGlite), `pnpm test:pg` (a real PostgreSQL server), `pnpm test:e2e`
  (Playwright, real browser), `pnpm build`, and `pnpm agent-native:doctor`.
  Fix findings before declaring done. Each layer proves something the others
  cannot, so a green unit run is not a green project.
- **Record the evidence.** When a run or verification completes, capture the
  concrete artifact — the response body, the run status, the screenshot — so
  the result is inspectable after the fact.
- **Run the browser journeys against an empty database.** `load-demo-case` is
  idempotent by title, so a journey that seeds the demo reuses the case an
  earlier run already wrote to. A local pass can then depend on rows a previous
  run left behind and hide a real failure that CI, starting from an empty
  database, hits. Before trusting a green `pnpm test:e2e`, stop the dev server,
  delete `data/pglite`, and run the journeys again from nothing — or give the
  journey its own uniquely-titled case (`seedDemoCase(scenario, title)`). A
  journey that asserts on *fresh* state (zero findings, no conflicts) must own
  its case, or the assertion is testing the previous run.
- **Write assertions the engine can actually satisfy.** Findings, and therefore
  cross-document contradictions and gaps, exist only after a model proposes
  claims. With no provider configured, the deterministic engine produces
  relationships from shared identifiers, amounts, parties, and dates — not
  contradictions. A journey that asserts a contradiction without first proposing
  claims is asserting something the environment cannot produce; it will pass
  only where stale claims happen to exist. Assert what the path under test
  really does, and say in a comment why the model-dependent case is covered
  elsewhere.
- **Prefer scoped, exact locators.** Playwright's `getByRole(name)` and
  `getByText` are substring matches by default, so a bare `"Cases"` also matches
  a "No cases yet" heading and a filename also matches the upload notice that
  quotes it. A strict-mode violation is a test defect, not a product defect:
  scope to the section (`page.locator("#evidence")`) and pass `{ exact: true }`.
- **No success without evidence.** If something is blocked, report it as
  blocked with the exact error and the attempted fix, rather than reporting
  success.

## Continuous integration

`.github/workflows/ci.yml` runs four independent jobs on every push and pull
request. All four must pass:

- **unit** — `pnpm typecheck` and `pnpm test` against PGlite.
- **postgres** — `pnpm test:pg` against a real `postgres:16` service. Set
  `CASEFILE_TEST_PG_URL` locally to run the same suite; when it is unset the
  suite is skipped rather than failed, so a missing server is never mistaken for
  a passing one.
- **browser** — `pnpm test:e2e`, the Playwright journeys, with `AUTH_DISABLED=1`
  set only for that ephemeral job. The browser resolves a system Chromium
  (`/usr/bin/chromium`) or, in CI, the one `playwright install chromium` places
  in Playwright's own cache; override with `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.
- **build** — `pnpm build`, so the app still compiles for production.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Demonstrations

Two synthetic cases load through `load-demo-case` and run the real
validate-store-extract-classify-graph pipeline, so neither hardcodes a result.

- `scenario: "payment"` (default) — five documents about a disputed refund. The
  merchant affirms a refund and the customer denies it on the same reference
  (RRF-55210) at different amounts, so `analyze-evidence` proposes a genuine
  contradiction.
- `scenario: "court"` — six court documents that all carry case number
  HC-2024-1234, so the graph links them into one proceeding. The judgment
  recites counsel's submission, the defendant's allegation, and the court's own
  finding in separate sentences, so `analyse-documents` must label them
  differently. No real party, contract, or proceeding is represented.

Loading is idempotent per scenario: reloading returns the existing case. The
cases page offers both; `scripts/seed-demo-case.mjs [baseUrl] [payment|court]`
seeds from the CLI.

## Application state

- `navigation` describes the view and selected ids. Chat is `chat` at `/chat` and `/chat/<threadId>`; the Get started page is `home` at `/home`; `/` opens shared sign-in/signup.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.
