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
-- SHAPE / SAFETY — mirrors the manual createAssociation writer (association-service.ts) EXACTLY, which
-- requires BOTH the deal and the contact to be active.
--   * active-only     — d.is_active = true AND the contact is active (EXISTS ... AND c.is_active = true).
--                           An archived deal or archived contact must NOT resurface a primary edge on the
--                           Primary Contacts card / deal pages / APIs, so those rows are excluded (this
--                           drops the 54 inactive-deal + 16 inactive-contact rows the first census flagged).
--   * is_primary = true   — every seeded row is the deal's PRIMARY contact (that is what primary_contact_id
--                           means).
--   * role            — left NULL (column is nullable, no default), matching createAssociation's `role ?? null`
--                           for a row created without an explicit role.
--   * FK-guarded      — only inserts when the referenced contact EXISTS (and is active), so the
--                           contact_deal_associations_contact_id_fkey -> contacts(id) constraint cannot fail.
--   * promote-on-conflict / idempotent — ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true
--                           against the UNIQUE(contact_id, deal_id) constraint. If a (contact, deal) edge
--                           already exists (e.g. a manually-created non-primary row), it is PROMOTED to
--                           primary so the deal's one primary is always marked — the backfill never silently
--                           fails to set a primary. Re-running sets the same true, so it stays idempotent.
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
         AND d.is_active = true
         AND EXISTS (SELECT 1 FROM %I.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)
       ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true',
      tenant_schema, tenant_schema, tenant_schema
    );
  END LOOP;
END $mig$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above; ON CONFLICT re-marks the same
-- primary, a no-op). On a brand-new tenant the deals table is empty, so this inserts zero rows.
-- TENANT_SCHEMA_START
INSERT INTO office_dallas.contact_deal_associations (contact_id, deal_id, is_primary)
SELECT d.primary_contact_id, d.id, true
FROM office_dallas.deals d
WHERE d.primary_contact_id IS NOT NULL
  AND d.is_active = true
  AND EXISTS (SELECT 1 FROM office_dallas.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)
ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true;
-- TENANT_SCHEMA_END
