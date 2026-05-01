# Ephemeral Staging Databases

This folder documents the one-shot staging database workflow for risky tenant-wide migrations.

The scripts do not run migrations automatically. They only create and tear down a temporary Railway Postgres clone so migration commands can be pointed at an isolated database.

## Prerequisites

- Railway CLI authenticated with access to the `T Rock CRM` project.
- `pg_dump`, `pg_restore`, and `pg_isready` installed locally.
- Node.js available locally.
- Production Railway Postgres backups enabled before any production-affecting migration work.

Defaults:

- Project: `53fbadb4-b2aa-4fe3-8f6d-4d8d3c2a2f9c`
- Environment: `8d35be1c-b4c2-4752-9aa3-08dfda944e1c`
- Production DB service: `Postgres`

Override with:

```bash
export RAILWAY_PROJECT_ID='<project-id>'
export RAILWAY_ENVIRONMENT_ID='<environment-id>'
export PRODUCTION_DB_SERVICE='Postgres'
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
6. Print an `export DATABASE_URL='...'` command for local verification.

## Run Migration Verification Against the Ephemeral Database

After the create script prints the ephemeral database URL, export it in the same shell:

```bash
export DATABASE_URL='<ephemeral-database-public-url>'
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
- Use the printed ephemeral `DATABASE_URL` only in the local shell running verification.
- Do not leave `staging-ephemeral-*` services running after the PR verification gate is complete.
- Do not use this workflow as a long-lived staging environment.
