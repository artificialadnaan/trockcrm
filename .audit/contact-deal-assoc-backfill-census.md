# contact_deal_associations backfill — read-only prod census

Date: 2026-06-19
Source: live prod (`DATABASE_PUBLIC_URL`), read-only `SELECT count(*)` only. No writes.

## Background

`contact_deal_associations` (cda) is the join table between `contacts` and `deals`
(`contactId`, `dealId`, `role varchar(100)` nullable, `isPrimary bool default false`, `UNIQUE(contactId, dealId)`
— `shared/src/schema/tenant/contact-deal-associations.ts`). It is **empty in every office_\* schema**, yet
office_dallas has 752 deals carrying a `primary_contact_id`. HubSpot held ~462 contact↔deal edges; migration
0027 repaired the deal-side `deals.primary_contact_id` but never re-seeded the cda join table. Worker jobs that
read cda (cold-lead warming, daily tasks, sent-email→deal mapping, lost-deal outreach) and the contacts UI
therefore run dry.

Verified FK/unique constraints on `office_dallas.contact_deal_associations`:
- `UNIQUE (contact_id, deal_id)` — matches the planned `ON CONFLICT (contact_id, deal_id) DO NOTHING`.
- `FOREIGN KEY (contact_id) REFERENCES contacts(id)` — plain FK to id (no is_active condition); **existence is sufficient**.
- `FOREIGN KEY (deal_id) REFERENCES deals(id)` — always satisfied (the backfill SELECTs FROM deals).

## Per-schema census

| schema              | (a) deals w/ primary_contact_id | (b) would-insert (DRY-RUN) | (c) existing cda rows | (d) FK-unsafe (missing contact) |
| ------------------- | ------------------------------: | -------------------------: | --------------------: | ------------------------------: |
| office_dallas       |                             752 |                        752 |                     0 |                               0 |
| office_atlanta      |                               0 |                          0 |                     0 |                               0 |
| office_pwauditoffice |                              0 |                          0 |                     0 |                               0 |
| **TOTAL**           |                         **752** |                    **752** |                 **0** |                           **0** |

Definitions:
- **(b) would-insert** = deals with `primary_contact_id IS NOT NULL` **AND** the contact exists (`EXISTS` by id)
  **AND** the `(contact_id, deal_id)` pair is not already in cda. This is exactly what migration 0169 inserts.
- **(d) FK-unsafe** = `primary_contact_id` pointing to a **missing** contact row (would violate the FK). **Zero in prod**,
  so nothing is dropped today; the `EXISTS` guard handles it forward-compatibly regardless.

## Notes / observations (do not change the would-insert count)

- **16 of office_dallas's 752** would-insert rows point to a contact whose `is_active = false`. These are **FK-safe**
  (the contact row still exists), so migration 0169's `EXISTS`-by-id guard inserts them — matching the FK semantics.
  The manual `createAssociation` writer additionally rejects inactive contacts (`AND is_active = true`); the backfill
  deliberately does **not** mirror that, because the deal-side `primary_contact_id` already points at the contact and
  we are materializing an edge that logically exists. If Adnaan prefers to exclude inactive contacts, add
  `AND c.is_active = true` to the `EXISTS` subquery (would lower office_dallas would-insert 752 → 736).
- **54 of the 752** would-insert rows are on deals with `is_active = false` (soft-deleted/archived deals). The backfill
  does not filter on deal active-state — the FK only needs the deal row to exist, and the worker/UI readers already
  apply their own active filters at read time.
- office_atlanta and office_pwauditoffice have **no deals with a primary_contact_id**, so the backfill is a no-op there.

## What the migration does (0169)

Per-office DO-loop over `information_schema.schemata` (system schemas + `pg_%` excluded), `to_regclass`-guarded on
both `deals` and `contact_deal_associations`, plus a `-- TENANT_SCHEMA_START/END` block (office_dallas literal) for
newly provisioned tenants. Idempotent / replayable via `ON CONFLICT (contact_id, deal_id) DO NOTHING`. Seeds
`is_primary = true`, leaves `role` NULL.
