-- Migration 0156: Change Orders become real CHILD deals (reverses the value-only model of 0153)
--
-- A change order is now a real row in `deals`: is_change_order = true, parent_deal_id -> the parent,
-- stage = Won, won_closed_date = the CO's date, awarded_amount = the CO amount. It is created Won and
-- never moves stages, inherits company/property/rep from the parent, and SHARES the parent's
-- project_number. CO children are CRM-only (the Bid Board sync skips is_change_order deals) and are
-- counted as Won everywhere (deal counts + Won-value reports) — intentionally retiring the
-- "COs are not deals / preserve-191" invariant that 0153 was built around.
--
-- Adds the two columns + a self-referencing FK (ON DELETE CASCADE: deleting a parent removes its CO
-- children) + a parent_deal_id index, and re-creates deals_project_number_uidx to EXEMPT
-- is_change_order rows (so a CO child can carry the parent's project_number without tripping
-- uniqueness). Per-tenant (office_*) + the TENANT_SCHEMA block for new tenants. Idempotent / replayable.

-- Existing tenants.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS is_change_order boolean NOT NULL DEFAULT false', schema_name);
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS parent_deal_id uuid', schema_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = schema_name AND c.conname = 'deals_parent_deal_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.deals ADD CONSTRAINT deals_parent_deal_id_fkey FOREIGN KEY (parent_deal_id) REFERENCES %I.deals(id) ON DELETE CASCADE',
        schema_name, schema_name
      );
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS deals_parent_deal_id_idx ON %I.deals (parent_deal_id) WHERE parent_deal_id IS NOT NULL',
      schema_name
    );

    -- Re-create the project_number unique index to exempt CO children (they share the parent's number).
    -- Safe on existing data: every current row has is_change_order = false, so the new partial index
    -- covers exactly the same rows the old one did — no new uniqueness conflict on rebuild.
    EXECUTE format('DROP INDEX IF EXISTS %I.deals_project_number_uidx', schema_name);
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS deals_project_number_uidx ON %I.deals (project_number) WHERE project_number IS NOT NULL AND is_change_order = false',
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by IF [NOT] EXISTS).
-- TENANT_SCHEMA_START
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS is_change_order boolean NOT NULL DEFAULT false;
ALTER TABLE office_dallas.deals ADD COLUMN IF NOT EXISTS parent_deal_id uuid;

DO $co_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'office_dallas' AND c.conname = 'deals_parent_deal_id_fkey'
  ) THEN
    ALTER TABLE office_dallas.deals
      ADD CONSTRAINT deals_parent_deal_id_fkey FOREIGN KEY (parent_deal_id) REFERENCES office_dallas.deals(id) ON DELETE CASCADE;
  END IF;
END $co_fk$;

CREATE INDEX IF NOT EXISTS deals_parent_deal_id_idx ON office_dallas.deals (parent_deal_id) WHERE parent_deal_id IS NOT NULL;

DROP INDEX IF EXISTS office_dallas.deals_project_number_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS deals_project_number_uidx ON office_dallas.deals (project_number) WHERE project_number IS NOT NULL AND is_change_order = false;
-- TENANT_SCHEMA_END
