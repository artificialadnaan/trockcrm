# T Rock CRM

Custom CRM platform for T Rock Construction. Monorepo: `client/` (React + Vite), `server/` (Express + Drizzle), `worker/` (background jobs), `shared/` (schema + types).

## Development

### Email override (local + staging)

Set `EMAIL_OVERRIDE_RECIPIENT` in your `.env` to reroute **all** outbound email to a single address while keeping the original recipient list visible in the subject and body. This applies to every email path (verification, notifications, auth) — any new email feature inherits it automatically.

```env
EMAIL_OVERRIDE_RECIPIENT=adnaan.iqbal@gmail.com
```

When set, emails arrive with:
- Subject prefixed `[→ original@example.com, second@example.com] ...`
- A yellow banner at the top of the body identifying the original recipients

Leave **empty in production** to send to real recipients. The same variable should be set on Railway for any non-production environment.

### Common scripts

```bash
npm run dev             # Start all workspaces
npm run typecheck       # Strict typecheck across workspaces
npm test                # Run server vitest suite
npm run db:generate     # Drizzle migration generate
npm run db:migrate      # Apply migrations (tsx server/src/migrations/runner.ts)
```

See `docs/superpowers/plans/` for active implementation plans.

### Call recording transcription env

The worker uses `OPENAI_API_KEY` for Whisper transcription and `ANTHROPIC_API_KEY` for Claude call summaries. Optional guardrails live in `.env.example`: `CALL_RECORDING_TRANSCRIPTION_INTERVAL_MS`, `CALL_RECORDING_TRANSCRIPTION_DAILY_CAP_USD`, and the per-model cost estimate variables used for logging/cap checks.

### R2 browser upload CSP env

Call recording uploads and playback use presigned R2 URLs in the browser. `R2_CSP_DOMAIN` can override the derived R2 CSP host source; when unset, the API derives `https://*.{R2_ACCOUNT_ID}.r2.cloudflarestorage.com`. Add extra API origins to `CSP_CONNECT_SRC` as a comma-separated list.

Production entry points currently allowed by R2 CORS, API CORS, and CSP are:
- `https://trockcrm.com`
- `https://crm.trockconstruction.com`
- `https://frontend-production-bcab.up.railway.app`

Prefer `https://trockcrm.com` as the canonical public entry point and keep the others as compatibility origins until redirects are configured.
