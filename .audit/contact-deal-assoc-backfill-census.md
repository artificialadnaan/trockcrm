# contact_deal_associations backfill — read-only prod census

Date: 2026-06-19 (revised for the active-only + single-primary migration)
Source: live prod (`DATABASE_PUBLIC_URL`), read-only `SELECT count(*)` only. No writes.

> This census is the merge/approval gate and matches migration 0169 EXACTLY as deployed. The earlier
> revision documented a looser 752-row predicate; the migration now mirrors the app writer (active deal
> AND active contact, single-primary-per-deal), so the production write is **697 rows**, not 752.

## Background

`contact_deal_associations` (cda) is the join table between `contacts` and `deals`
(`contactId`, `dealId`, `role varchar(100)` nullable, `isPrimary bool default false`, `UNIQUE(contactId, dealId)`
— `shared/src/schema/tenant/contact-deal-associations.ts`). It is **empty in every office_\* schema**, yet
office_dallas has 752 deals carrying a `primary_contact_id`. HubSpot held ~462 contact↔deal edges; migration
0027 repaired the deal-side `deals.primary_contact_id` but never re-seeded the cda join table. Worker jobs that
read cda (cold-lead warming, daily tasks, sent-email→deal mapping, lost-deal outreach) and the contacts UI
therefore run dry.

Verified FK/unique constraints on `office_dallas.contact_deal_associations`:
- `UNIQUE (contact_id, deal_id)` — matches the `ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true`.
- `FOREIGN KEY (contact_id) REFERENCES contacts(id)` / `(deal_id) REFERENCES deals(id)` — existence is sufficient.

## Per-schema census (matches the deployed SQL)

| schema               | deals w/ primary_contact_id | **would-insert (DRY-RUN)** | existing cda rows | existing primaries to demote |
| -------------------- | --------------------------: | -------------------------: | ----------------: | ---------------------------: |
| office_dallas        |                         752 |                    **697** |                 0 |                            0 |
| office_atlanta       |                           0 |                          0 |                 0 |                            0 |
| office_pwauditoffice |                           0 |                          0 |                 0 |                            0 |
| **TOTAL**            |                     **752** |                    **697** |             **0** |                        **0** |

**would-insert** = deals with `primary_contact_id IS NOT NULL` **AND** `d.is_active = true` **AND** the contact
exists and is active (`EXISTS … AND c.is_active = true`) **AND** the `(contact_id, deal_id)` pair is not already a
primary. This is exactly what migration 0169 writes.

### How 752 → 697 (the active-only exclusions)

- **−54** rows on **inactive/archived deals** (`d.is_active = false`) — excluded by the deal filter.
- **−1** row whose target **contact is inactive** *on an otherwise-active deal* — excluded by `c.is_active`.
- The other **15** of the 16 inactive-contact rows sit on inactive deals, so the deal filter already removed
  them (no double counting). Net unique exclusions = **55** → **697**.

Why exclude them: an archived deal or archived contact must not resurface a primary edge on the Primary
Contacts card / deal pages / APIs. This mirrors the manual `createAssociation` writer, which requires BOTH
the deal and the contact active.

## Single-primary-per-deal

`contact_deal_associations` has no DB-level "one primary per deal" constraint, and readers join on
`is_primary = true`. Before promoting a deal's `primary_contact_id`, the migration **demotes any OTHER**
`is_primary = true` row on that deal (gated on an active target so a deal is never left primary-less). cda is
empty in every office today, so **0 rows are demoted now** — the demote is defensive for replay / new tenants /
a concurrent manual writer. Proven by the PGlite runtime test
`server/tests/modules/migration/backfill-contact-deal-associations.runtime.test.ts`.

## What the migration does (0169)

Per-office DO-loop over `information_schema.schemata` (system schemas + `pg_%` excluded), `to_regclass`-guarded
on both `deals` and `contact_deal_associations`, plus a `-- TENANT_SCHEMA_START/END` block (office_dallas
literal) for newly provisioned tenants. For each active deal whose `primary_contact_id` is an active contact:
**(1) demote** any other primary on the deal, then **(2) upsert** the primary (`ON CONFLICT … DO UPDATE SET
is_primary = true`). Idempotent / replayable. Seeds `is_primary = true`, leaves `role` NULL.
