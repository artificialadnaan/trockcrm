-- Migration 0158: files.deal_id -> deals.id foreign key (per office schema)
--
-- The STRUCTURAL backstop for cross-office field WRITES (Phase 2b). `files.lead_id` already has an FK to
-- `leads.id`; `files.deal_id` was a bare uuid with NO FK, so a photo written into the WRONG office schema
-- (deal_id pointing at a deal that only exists in another office) succeeded silently and orphaned the row.
-- This adds the missing same-schema FK so Postgres rejects (23503) any files row whose deal_id is not a
-- deal in the SAME schema — making a mis-targeted cross-office write impossible for ANY code path, not
-- just the resolver-guarded field routes.
--
-- ON DELETE SET NULL: deleting a deal unassigns its photos (they become unassociated/pending) rather than
-- blocking the delete or cascading photo loss. NULL deal_id is allowed (unassigned/burst-captured photos).
--
-- Added NOT VALID: enforced on every future INSERT/UPDATE immediately (the whole point), WITHOUT scanning
-- existing rows — so the deploy can never hard-fail on legacy data (migrations auto-run on deploy and a
-- failure blocks the deploy). A Phase-1 orphan audit found ZERO orphan files.deal_id across all schemas,
-- so a follow-up `VALIDATE CONSTRAINT` is safe to run once re-confirmed in prod; it is intentionally
-- omitted here to keep this migration deploy-risk-free. Per-tenant (office_*) + the TENANT_SCHEMA block
-- for new tenants. Idempotent / replayable (pg_constraint existence guard).

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
    -- Skip a schema that has not yet been provisioned with the files/deals tables.
    IF to_regclass(format('%I.files', schema_name)) IS NULL
       OR to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = schema_name AND c.conname = 'files_deal_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %1$I.files ADD CONSTRAINT files_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES %1$I.deals(id) ON DELETE SET NULL NOT VALID',
        schema_name
      );
    END IF;
  END LOOP;
END $tenant$;

-- New tenants: cloned by the office provisioner (office_dallas -> new schema). Runs idempotently for
-- office_dallas at migration time too (redundant with the DO-loop above, guarded by the constraint check).
-- TENANT_SCHEMA_START
DO $files_deal_fk$
BEGIN
  -- Guard the tables exist before altering (matches the repo's TENANT_SCHEMA convention) so this block
  -- is safe both as office_dallas's own migration and as the clone template for a freshly-provisioned
  -- schema where files/deals may not be present yet.
  IF to_regclass('office_dallas.files') IS NOT NULL
     AND to_regclass('office_dallas.deals') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'office_dallas' AND c.conname = 'files_deal_id_fkey'
     ) THEN
    ALTER TABLE office_dallas.files
      ADD CONSTRAINT files_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES office_dallas.deals(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $files_deal_fk$;
-- TENANT_SCHEMA_END
