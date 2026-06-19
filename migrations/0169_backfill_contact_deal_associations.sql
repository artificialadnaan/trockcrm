-- Migration 0169: backfill contact_deal_associations from deals.primary_contact_id.
--
-- WHAT THIS BACKFILLS
-- The join table `contact_deal_associations` (cda) is currently EMPTY in every office_* schema, yet
-- ~752 office_dallas deals carry a `primary_contact_id`. HubSpot held ~462 contact<->deal edges;
-- migration 0027 repaired the deal-side `deals.primary_contact_id` but never re-populated the cda join
-- table. Worker jobs (cold-lead warming, daily tasks, sent-email->deal mapping, lost-deal outreach) and
-- the contacts UI read cda and therefore silently run dry. This migration seeds one cda row per deal that
-- has a primary contact, materializing the primary edge that already exists on the deal row.
--
-- SHAPE / SAFETY
--   * is_primary = true   — every seeded row is the deal's PRIMARY contact (that is what primary_contact_id
--                           means), mirroring the manual createAssociation writer in association-service.ts.
--   * role            — left NULL (column is nullable, no default), matching createAssociation's `role ?? null`
--                           for a row created without an explicit role.
--   * FK-guarded      — only inserts when the referenced contact still EXISTS, so the
--                           contact_deal_associations_contact_id_fkey -> contacts(id) constraint cannot fail.
--                           (deal_id always exists; the SELECT is FROM deals.) Census: 0 dangling
--                           primary_contact_id rows in prod, so nothing is dropped today.
--   * idempotent / replayable — ON CONFLICT (contact_id, deal_id) DO NOTHING against the existing
--                           UNIQUE(contact_id, deal_id) constraint, so re-running (or the manual writer
--                           having already created a row) is a no-op and never duplicates an edge.
--
-- PROD WRITE: this performs an INSERT on merge+deploy. It is read-mostly-safe (insert-only, conflict-skipped)
-- but it DOES write rows. Do not merge until the census in the PR body is approved.
--
-- Per-tenant (office_*) DO-loop + the TENANT_SCHEMA block so freshly provisioned tenants (whose deals/
-- contacts tables start empty) also run it idempotently.

-- Existing tenants.
DO $mig$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('public', 'information_schema', 'pg_catalog', 'migration')
      AND schema_name NOT LIKE 'pg_%'
  LOOP
    -- Skip any schema that does not have BOTH the source (deals) and target (contact_deal_associations).
    IF to_regclass(format('%I.deals', tenant_schema)) IS NULL
       OR to_regclass(format('%I.contact_deal_associations', tenant_schema)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'INSERT INTO %I.contact_deal_associations (contact_id, deal_id, is_primary)
       SELECT d.primary_contact_id, d.id, true
       FROM %I.deals d
       WHERE d.primary_contact_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM %I.contacts c WHERE c.id = d.primary_contact_id)
       ON CONFLICT (contact_id, deal_id) DO NOTHING',
      tenant_schema, tenant_schema, tenant_schema
    );
  END LOOP;
END $mig$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above; ON CONFLICT DO NOTHING makes it a
-- no-op). On a brand-new tenant the deals table is empty, so this inserts zero rows.
-- TENANT_SCHEMA_START
INSERT INTO office_dallas.contact_deal_associations (contact_id, deal_id, is_primary)
SELECT d.primary_contact_id, d.id, true
FROM office_dallas.deals d
WHERE d.primary_contact_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM office_dallas.contacts c WHERE c.id = d.primary_contact_id)
ON CONFLICT (contact_id, deal_id) DO NOTHING;
-- TENANT_SCHEMA_END
