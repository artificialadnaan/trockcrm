# contact_deal_associations backfill — manual script + dry-run census

Date: 2026-06-19 (converted from a migration to a deliberate, dry-run-first script)
Source: live prod (`DATABASE_PUBLIC_URL`), read-only `SELECT count(*)` only for the census. No writes.

> **This is a SCRIPT, not a migration — it does NOT auto-apply on deploy.** It is inert until invoked,
> defaults to a read-only dry-run, and only writes with an explicit `--commit`. The 697-row write happens
> only when Adnaan runs `--commit` against prod, after eyeballing this census (same pattern as the region /
> file-category backfills). Merging the PR changes nothing in the database.

## Run it

```bash
# read-only census, no writes (what produced the numbers below):
tsx scripts/backfill-contact-deal-associations.ts --dry-run
# apply, demote + upsert in a txn per office:
tsx scripts/backfill-contact-deal-associations.ts --commit
```

No flags also runs a dry-run (writes need an explicit `--commit`). Connection: `CRM_DATABASE_URL` or
`DATABASE_PUBLIC_URL` (same as the other backfills; TLS verification is off by default for the managed-PG
proxy, set `DATABASE_SSL_VERIFY=true` to enforce it).

**Run `--commit` during low app activity.** Each per-office txn takes the deal-row lock createAssociation
uses; a concurrent primary EDIT (updateAssociation, which locks the association row first) on a re-run could
deadlock → Postgres aborts one txn and the backfill rolls back cleanly (no partial state) → just re-run.
cda is empty on the first run, so this only matters on replay.

## Background

`contact_deal_associations` (cda) is the join table between `contacts` and `deals`
(`contact_id`, `deal_id`, `role varchar(100)` nullable, `is_primary bool default false`, `UNIQUE(contact_id, deal_id)`).
It is **empty in every office_\* schema**, yet office_dallas has 752 deals carrying a `primary_contact_id`.
HubSpot held ~462 contact↔deal edges; migration 0027 repaired the deal-side `deals.primary_contact_id` but
never re-seeded cda. Worker jobs that read cda (cold-lead warming, daily tasks, sent-email→deal mapping,
lost-deal outreach) and the contacts UI therefore run dry.

## Dry-run census (live prod, `--dry-run`)

| schema               | deals w/ primary_contact_id | **would-upsert** | would-demote |
| -------------------- | --------------------------: | ---------------: | -----------: |
| office_dallas        |                         752 |          **697** |            0 |
| office_atlanta       |                           0 |                0 |            0 |
| office_pwauditoffice |                           0 |                0 |            0 |
| **TOTAL**            |                     **752** |          **697** |        **0** |

**would-upsert** = active deal (`d.is_active`) whose `primary_contact_id` is an active contact
(`EXISTS … AND c.is_active`); the upsert inserts the edge or promotes an existing one to primary.
**would-demote** = other `is_primary` rows on those deals that are cleared (0 today — cda is empty).

### How 752 → 697 (active-only exclusions, mirroring the createAssociation writer)

- **−54** rows on **inactive/archived deals** (`d.is_active = false`).
- **−1** row whose target **contact is inactive** on an otherwise-active deal.
- The other **15** of the 16 inactive-contact rows sit on inactive deals (already excluded). Net = **55** → **697**.

An archived deal or contact must not resurface a primary edge on the Primary Contacts card / deal pages / APIs.

## What `--commit` does

For each office_* schema (discovered via `pg_namespace` where `nspname LIKE 'office\_%'`, with `to_regclass` presence guards on `deals` + `contacts` + `contact_deal_associations`),
in a transaction:
1. **DEMOTE** any OTHER `is_primary` row on a deal we're about to (re)materialize, gated on an active target
   (so a deal is never left primary-less) — each deal ends with exactly one primary; readers join on
   `is_primary = true`.
2. **UPSERT** the primary edge (`ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true`),
   `is_primary = true`, `role` NULL. Idempotent / replayable.

The exact `demote`/`upsert` SQL is exported as `backfillStatements()` and executed verbatim by the runtime
test `server/tests/scripts/backfill-contact-deal-associations.runtime.test.ts` (one-primary-per-deal across
6 cases, incl. an inactive target keeping its old primary), so the test can't drift from what `--commit` runs.
