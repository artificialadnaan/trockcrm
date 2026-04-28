# scripts/

One-off operational scripts. Most are migration-adjacent: surgical apply of a single migration to Railway prod, post-apply verification, schema probes.

## Connecting to the Postgres database

**Always invoke scripts via `railway run --service=Postgres`.** Railway injects `DATABASE_URL` and `DATABASE_PUBLIC_URL` into the child process env, so the connection string never appears on the command line (which would land in shell history and conversation logs).

```bash
railway run --service=Postgres npx tsx scripts/<script-name>.ts
```

Do **not** prefix the command with `DATABASE_PUBLIC_URL='postgresql://...' npx tsx ...` — that leaks the credential into shell history and any logged terminal session. If you need the URL for an external tool (Drizzle Studio, pgAdmin), use `railway variables --service=Postgres --kv | grep "^DATABASE_PUBLIC_URL="` and copy from there.

## Surgically applying a single migration

When a feature branch adds a migration but other unrelated migrations on the working tree are not ready to apply (e.g., orphaned migrations from a sibling branch), do **not** run `npm run db:migrate` — it walks the entire `migrations/` directory and would sweep up unwanted siblings. Instead, write a one-off `apply-XXXX-surgical.ts` modeled on `apply-0062-surgical.ts`: it reads the single SQL file, runs it inside a `BEGIN`/`COMMIT`, and inserts the filename into `public._migrations` so the regular runner skips it on the next deploy. Then verify with a `verify-XXXX.ts` that checks `information_schema.tables`, `pg_constraint`, and `pg_indexes` against each tenant schema (currently `office_atlanta`, `office_dallas`, `office_pwauditoffice`). After both run clean, delete the one-off scripts in the same PR or keep them under `scripts/` as a record of what was applied — team preference.
