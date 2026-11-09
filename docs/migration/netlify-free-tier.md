# Migrating CASEFILE to Netlify (free tier)

Why: the Vercel team that hosts CASEFILE is under a Hobby fair-use soft block
(`FAIR_USE_LIMITS_EXCEEDED` / `fluidCpuDuration`), so every project in it returns
`HTTP 402 DEPLOYMENT_DISABLED`. Netlify is a genuinely free alternative that this
app is already built for.

## Status: no application code change is required

`netlify.toml` is already in the repository and `pnpm build` already emits a
complete Netlify artifact under `NITRO_PRESET=netlify`:

- `dist/` — the static publish directory (`publish = "dist"`).
- `.netlify/functions-internal/server/` — the SSR catch-all function.
- `.netlify/functions-internal/server-agent-background/` — the background
  (long-running) function, reachable at `/.netlify/functions/server-agent-background`.
- `.netlify/functions-internal/agent-native-recurring-jobs/` — the scheduled
  function that drives the daily recurring-job sweep (replaces Vercel cron).

The auth base URL is resolved from the platform: on Netlify the framework reads
`URL`/`DEPLOY_URL` (`@agent-native/core` `app-url.js`) and treats the platform
origin as trusted (`origin-allowlist.js`, `includePlatform`). Same-origin
sign-in therefore works with no extra configuration.

## Verified locally (this branch, commit <see PR>)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | pass |
| Unit/integration (PGlite) | `pnpm test` | 416 passed / 24 files |
| Netlify build | `NITRO_PRESET=netlify pnpm build` | pass — 3 functions + `dist/` (457 files) |
| PostgreSQL integration | `CASEFILE_TEST_PG_URL=… pnpm test:pg` | 13 passed / 2 files |

Not run here: `pnpm test:e2e` (needs a browser + dev server). It runs in the
repository's own CI.

## Required environment variables (names only; never commit values)

Set in the Netlify site → Site configuration → Environment variables, for the
**production** context:

- `DATABASE_URL` — required; the production release migrations run at build time
  and refuse to continue if it is unset. Use a pooled Postgres URL (Netlify DB,
  Neon, etc.). For a Netlify-managed database, `netlify.toml` maps
  `NETLIFY_DATABASE_URL` onto `DATABASE_URL` automatically.
- `BETTER_AUTH_SECRET` — required; a stable secret, or every session is invalidated
  on restart.
- `A2A_SECRET` — required by the scheduled recurring-jobs function; without it the
  scheduled sweep throws.
- One deployment-level AI provider key, e.g. `GROQ_API_KEY` (free tier) — so a judge
  in a fresh organization can run the investigation engine and chat. Set exactly one.
- `AGENT_ENGINE=ai-sdk:groq` and `AGENT_MODEL=openai/gpt-oss-20b` — the deployment
  model default (the framework default is retired at Groq).
- `CRON_SECRET` — only if an external cron calls the sweep endpoint directly; the
  Netlify scheduled function authenticates with `A2A_SECRET`.

Do **not** set `AUTH_DISABLED` in production (the auth boot guard refuses to start).

## Deploy procedure

1. Connect the repository to a **free Netlify account** (owner action; a different
   account from the blocked Vercel team).
2. Netlify reads `netlify.toml`; build command and publish dir are already correct.
3. Set the environment variables above for the production context.
4. Trigger the first production deploy from the chosen branch.
5. Verify: `https://<site>/` renders the app, `https://<site>/api/health` is 200,
   and the production build log shows the release migrations applied.

## Domain preservation

`casefile-fhkr.vercel.app` cannot be moved (it is a Vercel-managed subdomain). To
keep a stable public URL, add a **custom domain** the owner controls to Netlify and
point its DNS at Netlify. That is a DNS change and requires owner approval — do not
do it during preparation.

## Rollback

The Netlify deploy is additive: the existing Vercel project and its deployment
records are untouched. To roll back, stop using the Netlify URL (or remove the
custom domain) and, once the Vercel team unblocks (~2026-12-09), the existing
`dpl_56jiK7…` production deployment serves again with no action.

## Free-tier limitations to expect

- Netlify free: 300 build minutes/month, 100 GB bandwidth/month, serverless
  functions included. Scheduled functions run at most once per day on the free
  plan — sufficient for the daily sweep.
- The database is external; its own free tier governs connection limits and
  sleeping.
