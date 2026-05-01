# Ephemeral Staging Databases

This folder documents the one-shot staging database workflow for risky tenant-wide migrations.

The scripts do not run migrations automatically. They only create and tear down a temporary Railway Postgres clone so migration commands can be pointed at an isolated database.

## Prerequisites

- Railway CLI authenticated with access to the `T Rock CRM` project via `railway login`.
- `RAILWAY_API_TOKEN` set to an account or workspace token for GraphQL API calls.
- `pg_dump`, `pg_restore`, and `pg_isready` installed locally.
- Node.js available locally.
- Production Railway Postgres backups enabled before any production-affecting migration work.

Run `railway login` once in an interactive terminal to populate `~/.railway/config.json`. The create script uses Railway CLI commands for linking, variable lookup, and provisioning; those commands use browser-login auth state.

Create an account or workspace token from Railway account settings. Railway's API docs explain token types at <https://docs.railway.com/reference/integrations>. Use `RAILWAY_API_TOKEN` for account/workspace tokens; do not use `RAILWAY_TOKEN` for GraphQL Bearer auth because project tokens require a different header.

Both auth methods are currently required: Railway CLI commands use `~/.railway/config.json`, while direct GraphQL operations use `RAILWAY_API_TOKEN`. The create script intentionally runs Railway CLI invocations with `env -u RAILWAY_API_TOKEN` so the CLI does not prefer the API token over browser-login auth state.

Setting `RAILWAY_API_TOKEN` to an empty string is not equivalent to unsetting it. Railway CLI rejects empty-string tokens as unauthorized. Use `env -u RAILWAY_API_TOKEN` to actually remove the variable for the subcommand.

Defaults:

- Project: `53fbadb4-b2aa-4fe3-8f6d-4d8d3c2a2f9c`
- Environment: `8d35be1c-b4c2-4752-9aa3-08dfda944e1c`
- Production DB service: `Postgres`

Override with:

```bash
export RAILWAY_PROJECT_ID='<project-id>'
export RAILWAY_ENVIRONMENT_ID='<environment-id>'
export PRODUCTION_DB_SERVICE='Postgres'
export RAILWAY_API_TOKEN='<account-or-workspace-token>'
```

## Create an Ephemeral Database

Run:

```bash
scripts/staging/ephemeral-staging.sh
```

Or provide the service name explicitly:

```bash
scripts/staging/ephemeral-staging.sh staging-ephemeral-20260501-1730
```

The script will:

1. Read the production `DATABASE_PUBLIC_URL` from the Railway `Postgres` service.
2. Dump production to `tmp/staging-dumps/<service-name>.dump`.
3. Provision a new Railway Postgres service named `staging-ephemeral-YYYYMMDD-HHMM`.
4. Wait for the new database URL and connection readiness.
5. Restore the production dump into the ephemeral database.
6. Write the ephemeral `DATABASE_URL` export line to a restricted env file under `tmp/staging-dumps/`.
7. Print a redacted host/port/database summary and a `source <path>` instruction.

## Run Migration Verification Against the Ephemeral Database

After the create script finishes, it prints an env file path like:

```bash
tmp/staging-dumps/ephemeral-20260501-1730.env
```

Load it in the same shell:

```bash
source tmp/staging-dumps/ephemeral-20260501-1730.env
```

Then run the migration and verification commands for the PR under test. For PR 1:

```bash
npm run db:migrate
npx tsx scripts/verify-batch-migrations.ts
```

Run any PR-specific sanity queries against this ephemeral database, not production.

## Tear Down

When verification is complete:

```bash
scripts/staging/teardown-ephemeral.sh staging-ephemeral-YYYYMMDD-HHMM
```

The teardown script refuses to delete services unless the name matches `staging-ephemeral-YYYYMMDD-HHMM`, unless `--force` is provided:

```bash
scripts/staging/teardown-ephemeral.sh some-other-service --force
```

## Cost Estimate

Railway volume storage is billed at `$0.15 / GB / month` according to Railway's pricing docs. The current production Postgres volume reports about `1.26 GB` used, so storage for an ephemeral clone is roughly:

```text
1.26 GB * $0.15 / GB-month = $0.189 / month
$0.189 / 730 hours = about $0.00026 per hour for volume storage
```

The actual service cost is higher because the Postgres container also consumes CPU/RAM while running. Keep ephemeral databases short-lived and tear them down immediately after verification.

## Safety Notes

- Never point `DATABASE_URL` at production for migration rehearsals.
- Do not leave `staging-ephemeral-*` services running after the PR verification gate is complete.
- Do not use this workflow as a long-lived staging environment.

## Security

Ephemeral staging databases contain a full restore of production data. Treat the dump file, generated env file, and ephemeral Railway service as sensitive production data.

- The create script writes credentials to `tmp/staging-dumps/ephemeral-*.env` with file mode `600`.
- `tmp/staging-dumps/*.env` is gitignored and must not be copied into tickets, PR comments, chat, or logs.
- Tear down each ephemeral database promptly after verification, ideally within 4 hours of creation.
- Delete stale dump/env files from local machines once the verification record no longer needs them.
