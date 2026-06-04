# scripts/

One-off operational scripts. Most are migration-adjacent: surgical apply of a single migration to Railway prod, post-apply verification, schema probes.

## Connecting to the Postgres database

**Always invoke scripts via `railway run --service=Postgres`.** Railway injects `DATABASE_URL` and `DATABASE_PUBLIC_URL` into the child process env, so the connection string never appears on the command line (which would land in shell history and conversation logs).

```bash
railway run --service=Postgres npx tsx scripts/<script-name>.ts
```

Do **not** prefix the command with `DATABASE_PUBLIC_URL='postgresql://...' npx tsx ...` — that leaks the credential into shell history and any logged terminal session. If you need the URL for an external tool (Drizzle Studio, pgAdmin), use `railway variables --service=Postgres --kv | grep "^DATABASE_PUBLIC_URL="` and copy from there.

## Go-live cleanup scripts

Duplicate company detection is dry-run by default and writes a CSV:

```bash
railway run --service=Postgres npx tsx scripts/detect-duplicate-companies.ts --tenant=office_dallas
```

The generated audit files include live customer names and IDs. They are intentionally ignored under `docs/audit/` and should be shared as operational artifacts, not committed.

To populate the existing manual merge queue after reviewing the CSV:

```bash
railway run --service=Postgres npx tsx scripts/detect-duplicate-companies.ts --tenant=office_dallas --populate-merge-queue --execute
```

CompanyCam inventory is read-only and writes the import plan CSV:

```bash
railway run --service=Postgres npx tsx scripts/companycam-inventory.ts --tenant=office_dallas
```

CompanyCam import is gated. It defaults to dry-run; use `--project-id` for the pilot:

```bash
railway run --service=Postgres npx tsx scripts/companycam-import.ts --tenant=office_dallas --project-id=<companycam-project-id> --execute
```

Unscoped `--execute` is blocked unless `--limit` or the explicit `--allow-bulk-execute` flag is provided after a pilot has been reviewed.
`--limit` must be a positive integer. The importer also enforces one CompanyCam project per matched CRM deal by default; duplicate matches write `docs/audit/companycam-match-conflicts-<timestamp>.csv` and block `--execute` unless `--no-strict-one-to-one` is passed deliberately after review. That override still imports only the highest-confidence project per deal; dropped conflicts remain deferred for manual matching.

HubSpot cutover reconciliation is read-only and expects fresh HubSpot CSV exports:

```bash
railway run --service=Postgres npx tsx scripts/reconcile-hubspot-csv.ts --tenant=office_dallas --contacts ./contacts.csv --companies ./companies.csv --deals ./deals.csv
```

Close dates are normalized deterministically for cutover comparison. Date-only ISO strings stay date-only, ISO datetimes with `Z` or a numeric offset are converted to UTC dates, and ISO datetimes without an offset are treated as UTC by assumption.

## Per-rep expected-close-date export / re-import

Two-way workflow to fill in missing `expected_close_date` values: export one Excel file per rep listing their open deals that lack a forecast close date, send each rep their file, then re-import the filled files.

**Export** (read-only) writes one `close-dates-<rep>.xlsx` per rep to `close-date-exports/<date>/` (git-ignored — real customer data). Scope is open, rep-actionable deals only: `expected_close_date IS NULL`, active, non-test, non-mirror, non-terminal stage.

```bash
railway run --service=Postgres npx tsx scripts/close-date-export.ts                 # all offices
railway run --service=Postgres npx tsx scripts/close-date-export.ts --tenant=office_dallas
railway run --service=Postgres npx tsx scripts/close-date-export.ts --dry-run        # per-rep counts, write no files
```

Each workbook hides + locks the matching-key columns (`Deal ID` = deal UUID, `Office` = tenant schema) and protects the sheet so reps can only edit the highlighted **Expected Close Date** column. The UUID is the foolproof match key — `deal_number`/`project_number` are mutable and frequently null, so they are never used to match.

**Re-import** is **dry-run by default**; pass `--commit` to write. It reads the locked key columns to update the exact deal and writes only `expected_close_date`. An existing date is **never** overwritten (reported as `CONFLICT`) unless `--overwrite-existing` is passed; blank rows are skipped; bad dates / bad keys / unmatched rows are reported (the run never crashes on one bad row); re-running is idempotent. Writing only the close date is side-effect-safe — the deal stage-history / `stage_entered_at` triggers are guarded on stage changes and the close-date email triggers are column-scoped elsewhere. A per-row audit CSV is written to `docs/audit/close-date-reimport-<timestamp>.csv` (git-ignored).

```bash
railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --dir=./filled            # preview a folder
railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --dir=./filled --commit    # write
railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --file=close-dates-alice.xlsx --commit
railway run --service=Postgres npx tsx scripts/close-date-reimport.ts --dir=./filled --commit --overwrite-existing
```

Shared logic lives in `scripts/lib/close-date-workflow.ts` (queries, classification) and `scripts/lib/close-date-xlsx.ts` (workbook IO); both are covered by `server/tests/scripts/close-date-*.runtime.test.ts`.

## Surgically applying a single migration

When a feature branch adds a migration but other unrelated migrations on the working tree are not ready to apply (e.g., orphaned migrations from a sibling branch), do **not** run `npm run db:migrate` — it walks the entire `migrations/` directory and would sweep up unwanted siblings. Instead, write a one-off `apply-XXXX-surgical.ts` modeled on `apply-0062-surgical.ts`: it reads the single SQL file, runs it inside a `BEGIN`/`COMMIT`, and inserts the filename into `public._migrations` so the regular runner skips it on the next deploy. Then verify with a `verify-XXXX.ts` that checks `information_schema.tables`, `pg_constraint`, and `pg_indexes` against each tenant schema (currently `office_atlanta`, `office_dallas`, `office_pwauditoffice`). After both run clean, delete the one-off scripts in the same PR or keep them under `scripts/` as a record of what was applied — team preference.

Migration `0120_audit_log_dedup_partial_index.sql` is the exception: its existing-tenant backfill uses tenant-wide `CREATE INDEX CONCURRENTLY`, so the direct-apply path is `scripts/apply-0120-surgical.ts` rather than piping the `.sql` file into a transaction. The SQL file still contains the tenant provisioning DDL for future office schemas, but the live backfill must run through the TypeScript helper so each `office_*` schema gets its concurrent index statements outside a transaction.
