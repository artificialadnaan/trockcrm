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
